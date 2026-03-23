import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { Address, Hex } from 'viem';
import { RPCProtocolVersion } from '@erc7824/nitrolite';
import { YellowClientService } from './client/yellow-client.service.js';
import { YellowService } from './handler/yellow.service.js';
import type { StoredSession } from './handler/yellow.service.js';
import { AccountService } from '../account/index.js';
import { InvitationRepository } from '../repository/invitation.repository.js';
import { CustodyService } from '../custody/custody.service.js';
import { ChannelFundingService } from '../custody/channel-funding.service.js';
import {
  resolveTokenAddress,
  toDecimal,
  parseDecimalToBaseUnits,
  DEFAULT_CHAIN,
} from '../custody/custody.constants.js';
import { errorMessage } from './yellow.utils.js';

export interface SessionAllocation {
  asset: string;
  amount: string;
  participant: string;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly yellowClient: YellowClientService,
    private readonly yellowService: YellowService,
    private readonly accountService: AccountService,
    private readonly invitationRepo: InvitationRepository,
    private readonly custodyService: CustodyService,
    private readonly channelFunding: ChannelFundingService,
  ) {}

  private ensureReady(): void {
    if (!this.yellowService.isEnabled()) {
      throw new ServiceUnavailableException('Yellow partner is disabled');
    }
    if (!this.yellowClient.isConfigured()) {
      throw new ServiceUnavailableException('Yellow signer not configured');
    }
  }

  // ─── Invitations ───────────────────────────────────────

  async createInvitation(dto: {
    initiatorUserId: string;
    inviteeUserId: string;
    token: string;
    amountInitiator: string;
    amountInvitee: string;
  }) {
    const initiator = await this.accountService.resolveAddress(dto.initiatorUserId);
    const invitee = await this.accountService.resolveAddress(dto.inviteeUserId);
    if (!initiator || !invitee) {
      throw new BadRequestException('Both users must have valid wallets');
    }

    return this.invitationRepo.create({
      token: dto.token,
      initiatorAddr: initiator,
      inviteeAddr: invitee,
      amountInitiator: dto.amountInitiator,
      amountInvitee: dto.amountInvitee,
    });
  }

  async listInvitations(userId: string, role?: string) {
    const address = await this.accountService.resolveAddress(userId);
    if (role === 'initiator') {
      return this.invitationRepo.findPendingByInitiator(address);
    }
    return this.invitationRepo.findPendingForAddress(address);
  }

  async rejectInvitation(id: string) {
    const invitation = await this.invitationRepo.findById(id);
    if (!invitation) throw new BadRequestException('Invitation not found');
    if (invitation.status !== 'pending') {
      throw new BadRequestException(`Invitation already ${invitation.status}`);
    }
    await this.invitationRepo.reject(id);
    return { ...invitation, status: 'rejected' };
  }

  // ─── Accept invitation → fund → create session ────────

  async acceptInvitation(invitationId: string) {
    this.ensureReady();

    const invitation = await this.invitationRepo.findById(invitationId);
    if (!invitation) throw new BadRequestException('Invitation not found');
    if (invitation.status !== 'pending') {
      throw new BadRequestException(`Invitation already ${invitation.status}`);
    }

    const participants = [invitation.initiatorAddr, invitation.inviteeAddr] as Hex[];
    const chainName = DEFAULT_CHAIN;
    const tokenAddress = resolveTokenAddress(invitation.token, chainName);
    if (!tokenAddress) {
      throw new BadRequestException(`Unknown token: ${invitation.token}`);
    }

    const participantAmounts = [
      { participant: invitation.initiatorAddr, amount: invitation.amountInitiator },
      { participant: invitation.inviteeAddr, amount: invitation.amountInvitee },
    ];

    const allocations = participantAmounts.map((pa) => ({
      asset: invitation.token,
      amount: toDecimal(pa.amount),
      participant: pa.participant,
    }));

    // Fund participants (channels → ledger)
    for (const pa of participantAmounts) {
      if (BigInt(pa.amount) > 0n) {
        try {
          await this.channelFunding.ensureLedgerBalance(
            pa.participant as Address,
            invitation.token,
            pa.amount,
            chainName,
          );
        } catch (err) {
          throw new BadRequestException(`Failed to fund ${pa.participant}: ${errorMessage(err)}`);
        }
      }
    }

    // Create app session via RPC
    const definition = {
      protocol: RPCProtocolVersion.NitroRPC_0_4,
      participants,
      weights: [100, 100],
      quorum: 200,
      challenge: 86400,
      nonce: Date.now(),
      application: 'custody-gateway',
    };

    try {
      const result = await this.yellowClient.createAppSession({
        definition,
        allocations: allocations as Parameters<
          YellowClientService['createAppSession']
        >[0]['allocations'],
        session_data: String(Date.now()),
      });

      const rpcResult = result as { app_session_id?: string } | undefined;
      const sessionId = rpcResult?.app_session_id ?? `0x${Date.now().toString(16)}`;

      await this.invitationRepo.accept(invitationId, sessionId);
      await this.yellowService.onSessionCreated(sessionId, { participants, allocations });

      return { sessionId, status: 'open', participants, allocations };
    } catch (err) {
      throw new BadRequestException(`Create session failed: ${errorMessage(err)}`);
    }
  }

  // ─── Sessions ──────────────────────────────────────────

  async listSessions(): Promise<StoredSession[]> {
    if (!this.yellowService.isEnabled()) return [];
    return this.yellowService.getAllSessions();
  }

  async getSession(sessionId: string): Promise<StoredSession | null> {
    if (!this.yellowService.isEnabled()) return null;
    return (await this.yellowService.getSession(sessionId)) ?? null;
  }

  async updateState(sessionId: string, allocations: SessionAllocation[]) {
    this.ensureReady();

    const session = await this.yellowService.getSession(sessionId);
    const version = (session?.stateVersion ?? 1) + 1;

    try {
      const result = await this.yellowClient.submitAppState({
        app_session_id: sessionId as Hex,
        intent: 'operate',
        version,
        allocations: allocations as Parameters<
          YellowClientService['submitAppState']
        >[0]['allocations'],
        session_data: String(Date.now()),
      });

      await this.yellowService.updateSessionAllocations(
        sessionId,
        allocations.map((a) => ({ asset: a.asset, amount: a.amount, participant: a.participant })),
        version,
      );

      return { sessionId, allocations, rpc_result: result };
    } catch (err) {
      throw new BadRequestException(`Update state failed: ${errorMessage(err)}`);
    }
  }

  async closeSession(sessionId: string, allocations: SessionAllocation[]) {
    this.ensureReady();

    // 1. Close app session via RPC
    try {
      await this.yellowClient.closeAppSession({
        app_session_id: sessionId as Hex,
        allocations: allocations as Parameters<
          YellowClientService['closeAppSession']
        >[0]['allocations'],
        session_data: String(Date.now()),
      });
      await this.yellowService.onSessionClosed(sessionId);
    } catch (err) {
      throw new BadRequestException(`Close session failed: ${errorMessage(err)}`);
    }

    // 2. Withdraw funds back to each participant's wallet
    const chainName = DEFAULT_CHAIN;
    const withdrawals: Array<{
      participant: string;
      amount: string;
      txHash?: string;
      error?: string;
    }> = [];

    for (const alloc of allocations) {
      const baseUnits = parseDecimalToBaseUnits(alloc.amount, 6);
      if (baseUnits <= 0n) {
        withdrawals.push({ participant: alloc.participant, amount: '0' });
        continue;
      }
      try {
        const result = await this.channelFunding.withdrawToWallet(
          alloc.participant as Address,
          alloc.asset,
          baseUnits.toString(),
          chainName,
        );
        withdrawals.push({
          participant: alloc.participant,
          amount: alloc.amount,
          txHash: result.txHash,
        });
      } catch (err) {
        withdrawals.push({
          participant: alloc.participant,
          amount: alloc.amount,
          error: errorMessage(err),
        });
      }
    }

    return { sessionId, status: 'closed', allocations, withdrawals };
  }

  // ─── Faucet (sandbox only) ───────────────────────────

  async faucet(userId: string, chainName = DEFAULT_CHAIN) {
    const address = await this.accountService.resolveAddress(userId);

    // 1. Request test tokens from ClearNode sandbox faucet → Unified Balance
    const resp = await fetch('https://clearnet-sandbox.yellow.com/faucet/requestTokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAddress: address }),
    });
    if (!resp.ok) throw new BadRequestException(`Faucet request failed: ${resp.statusText}`);
    const faucetResult = await resp.json() as { amount?: string; asset?: string };

    // 2. Withdraw from ledger to on-chain wallet
    this.ensureReady();
    const amount = faucetResult.amount ?? '10000000';
    const asset = faucetResult.asset ?? 'ytest.usd';

    const { txHash } = await this.channelFunding.withdrawToWallet(
      address,
      asset,
      amount,
      chainName,
    );

    return { address, asset, amount, txHash };
  }
}
