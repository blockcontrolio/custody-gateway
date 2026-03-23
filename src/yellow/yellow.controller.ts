import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { YellowClientService } from './client/yellow-client.service.js';
import { YellowService } from './handler/yellow.service.js';
import { AccountService } from '../account/index.js';
import { InvitationRepository } from '../repository/invitation.repository.js';
import { CustodyService } from '../custody/custody.service.js';
import { ChannelFundingService } from '../custody/channel-funding.service.js';
import { resolveTokenAddress, toDecimal, parseDecimalToBaseUnits, DEFAULT_CHAIN } from '../custody/custody.constants.js';
import type { StoredSession } from './handler/yellow.service.js';
import {
  SubmitAppStateDto,
  CloseAppSessionDto,
  StoredSessionDto,
  CreateInvitationDto,
} from './dto/index.js';
import type { Address, Hex } from 'viem';
import { RPCProtocolVersion } from '@erc7824/nitrolite';

@ApiTags('Sessions')
@Controller('sessions')
export class YellowController {
  constructor(
    private readonly yellowClient: YellowClientService,
    private readonly yellowService: YellowService,
    private readonly accountService: AccountService,
    private readonly invitationRepo: InvitationRepository,
    private readonly custodyService: CustodyService,
    private readonly channelFunding: ChannelFundingService,
  ) {}

  private ensureYellowReady(): void {
    if (!this.yellowService.isEnabled()) {
      throw new ServiceUnavailableException(
        'Yellow partner is disabled (YELLOW_PARTNER_ENABLED)',
      );
    }
    if (!this.yellowClient.isConfigured()) {
      throw new ServiceUnavailableException(
        'Yellow signer not configured (YELLOW_SIGNER_PRIVATE_KEY required)',
      );
    }
  }

  private rpcError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return JSON.stringify(err);
  }

  // ─── Invitations ───────────────────────────────────────

  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Invite another user to a session' })
  @ApiBody({ type: CreateInvitationDto })
  @ApiCreatedResponse({ description: 'Invitation created' })
  async invite(@Body() body: CreateInvitationDto): Promise<unknown> {
    const initiator = await this.accountService.resolveAddress(body.initiatorUserId);
    const invitee = await this.accountService.resolveAddress(body.inviteeUserId);
    if (!initiator || !invitee) {
      throw new BadRequestException('Both initiatorUserId and inviteeUserId must resolve to valid addresses');
    }

    return this.invitationRepo.create({
      token: body.token,
      initiatorAddr: initiator,
      inviteeAddr: invitee,
      amountInitiator: body.amountInitiator,
      amountInvitee: body.amountInvitee,
    });
  }

  @Get('invitations')
  @ApiOperation({ summary: 'List pending invitations for a user' })
  @ApiQuery({ name: 'userId', required: true })
  @ApiQuery({ name: 'role', required: false, enum: ['invitee', 'initiator'] })
  @ApiOkResponse({ description: 'Pending invitations' })
  async listInvitations(
    @Query('userId') userId?: string,
    @Query('role') role?: string,
  ): Promise<unknown> {
    if (!userId) {
      throw new BadRequestException('userId is required');
    }
    const address = await this.accountService.resolveAddress(userId);
    if (!address) {
      throw new BadRequestException('User not found');
    }
    if (role === 'initiator') {
      return this.invitationRepo.findPendingByInitiator(address);
    }
    return this.invitationRepo.findPendingForAddress(address);
  }

  /**
   * Accept invitation → auto-prepare wallets → create session.
   *
   * Under the hood:
   *   1. Auth both wallets with ClearNode
   *   2. Deposit tokens → Custody contract
   *   3. Create channels + resize (fund unified balances)
   *   4. Create app session (NitroRPC/0.4)
   */
  @Post('invitations/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept invitation (auto-prepares wallets + creates session)' })
  @ApiParam({ name: 'id', description: 'Invitation ID' })
  @ApiOkResponse({ description: 'Session created' })
  async accept(@Param('id') id: string): Promise<unknown> {
    this.ensureYellowReady();

    const invitation = await this.invitationRepo.findById(id);
    if (!invitation) {
      throw new BadRequestException('Invitation not found');
    }
    if (invitation.status !== 'pending') {
      throw new BadRequestException(`Invitation already ${invitation.status}`);
    }

    const participants = [invitation.initiatorAddr, invitation.inviteeAddr] as Hex[];
    const chainName = DEFAULT_CHAIN;
    const tokenAddress = resolveTokenAddress(invitation.token, chainName);
    if (!tokenAddress) {
      throw new BadRequestException(`Unknown token: ${invitation.token}`);
    }
    // Build participant allocations (base units for funding, decimal for ClearNode RPC)
    const participantAmounts = [
      { participant: invitation.initiatorAddr, amount: invitation.amountInitiator },
      { participant: invitation.inviteeAddr, amount: invitation.amountInvitee },
    ];
    const allocations = participantAmounts.map((pa) => ({
      asset: invitation.token,
      amount: toDecimal(pa.amount),
      participant: pa.participant,
    }));

    // ── Fund participants (channels → ledger) ──
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
          throw new BadRequestException(
            `Failed to fund ${pa.participant}: ${this.rpcError(err)}`,
          );
        }
      }
    }

    // ── Create app session via RPC ──
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
        allocations: allocations as Parameters<YellowClientService['createAppSession']>[0]['allocations'],
        session_data: String(Date.now()),
      });

      const rpcResult = result as { app_session_id?: string; version?: number } | undefined;
      const sessionId = rpcResult?.app_session_id ?? `0x${Date.now().toString(16)}`;

      await this.invitationRepo.accept(id, sessionId);
      await this.yellowService.onSessionCreated(sessionId, { participants, allocations });

      return {
        sessionId,
        status: 'open',
        participants,
        allocations,
      };
    } catch (err) {
      throw new BadRequestException(`Create session failed: ${this.rpcError(err)}`);
    }
  }

  @Post('invitations/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject invitation' })
  @ApiParam({ name: 'id' })
  async reject(@Param('id') id: string): Promise<unknown> {
    const invitation = await this.invitationRepo.findById(id);
    if (!invitation) throw new BadRequestException('Invitation not found');
    if (invitation.status !== 'pending') {
      throw new BadRequestException(`Invitation already ${invitation.status}`);
    }
    await this.invitationRepo.reject(id);
    return { ...invitation, status: 'rejected' };
  }

  // ─── Recovery / Debug ─────────────────────────────────

  @Post('recover-funds')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw stuck funds from Custody contract back to wallet' })
  async recoverFunds(
    @Body() body: { address: string; asset: string; chainName?: string },
  ): Promise<unknown> {
    const chainName = body.chainName || DEFAULT_CHAIN;
    const tokenAddress = resolveTokenAddress(body.asset, chainName);
    if (!tokenAddress) throw new BadRequestException(`Unknown token ${body.asset}`);

    const bal = await this.custodyService.getCustodyBalance(body.address as Address, tokenAddress, chainName);
    if (BigInt(bal.balance) === 0n) return { withdrawn: '0' };

    const tx = await this.custodyService.withdraw(body.address as Address, tokenAddress, bal.balance, chainName);
    return { withdrawn: bal.balance, txHash: tx.txHash };
  }

  // ─── Sessions ──────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List all sessions' })
  @ApiOkResponse({ type: [StoredSessionDto] })
  async list(): Promise<StoredSession[]> {
    if (!this.yellowService.isEnabled()) return [];
    return this.yellowService.getAllSessions();
  }

  @Get(':sessionId')
  @ApiOperation({ summary: 'Get session by ID (with current state)' })
  @ApiParam({ name: 'sessionId' })
  @ApiOkResponse({ type: StoredSessionDto })
  async get(@Param('sessionId') sessionId: string): Promise<StoredSession | null> {
    if (!this.yellowService.isEnabled()) return null;
    return (await this.yellowService.getSession(sessionId)) ?? null;
  }

  @Post(':sessionId/state')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update session state (change allocations)' })
  @ApiParam({ name: 'sessionId' })
  @ApiBody({ type: SubmitAppStateDto })
  @ApiOkResponse({ description: 'Updated state' })
  async updateState(
    @Param('sessionId') sessionId: string,
    @Body() body: SubmitAppStateDto,
  ): Promise<unknown> {
    if (!body.allocations?.length) {
      throw new BadRequestException('allocations are required');
    }
    this.ensureYellowReady();

    // Auto-manage intent & version (NitroRPC/0.4)
    const session = await this.yellowService.getSession(sessionId);
    const version = (session?.stateVersion ?? 1) + 1;

    try {
      const result = await this.yellowClient.submitAppState({
        app_session_id: sessionId as Hex,
        intent: 'operate',
        version,
        allocations: body.allocations as Parameters<YellowClientService['submitAppState']>[0]['allocations'],
        session_data: String(Date.now()),
      });

      await this.yellowService.updateSessionAllocations(
        sessionId,
        body.allocations.map((a) => ({ asset: a.asset, amount: a.amount, participant: a.participant })),
        version,
      );

      return {
        sessionId,
        allocations: body.allocations,
        rpc_result: result,
      };
    } catch (err) {
      throw new BadRequestException(`Update state failed: ${this.rpcError(err)}`);
    }
  }

  @Post(':sessionId/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close session' })
  @ApiParam({ name: 'sessionId' })
  @ApiBody({ type: CloseAppSessionDto })
  @ApiOkResponse({ description: 'Session closed' })
  async close(
    @Param('sessionId') sessionId: string,
    @Body() body: CloseAppSessionDto,
  ): Promise<unknown> {
    if (!body.allocations?.length) {
      throw new BadRequestException('allocations are required');
    }
    this.ensureYellowReady();

    // 1. Close app session via RPC
    try {
      await this.yellowClient.closeAppSession({
        app_session_id: sessionId as Hex,
        allocations: body.allocations as Parameters<YellowClientService['closeAppSession']>[0]['allocations'],
        session_data: String(Date.now()),
      });
      await this.yellowService.onSessionClosed(sessionId);
    } catch (err) {
      throw new BadRequestException(`Close session failed: ${this.rpcError(err)}`);
    }

    // 2. Withdraw funds back to each participant's wallet
    const chainName = DEFAULT_CHAIN;
    const withdrawals: Array<{ participant: string; amount: string; txHash?: string; error?: string }> = [];

    for (const alloc of body.allocations) {
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
        withdrawals.push({ participant: alloc.participant, amount: alloc.amount, txHash: result.txHash });
      } catch (err) {
        // Don't fail the whole close — session is already closed, log and continue
        withdrawals.push({ participant: alloc.participant, amount: alloc.amount, error: this.rpcError(err) });
      }
    }

    return {
      sessionId,
      status: 'closed',
      allocations: body.allocations,
      withdrawals,
    };
  }
}
