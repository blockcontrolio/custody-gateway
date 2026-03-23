import { Injectable, Logger } from '@nestjs/common';
import type { Address, Hex } from 'viem';
import { YellowClientService } from '../yellow/client/yellow-client.service.js';
import { YellowAuthService } from '../yellow/auth/yellow-auth.service.js';
import { CustodyService } from './custody.service.js';
import { KeyProvider } from '../key-provider/index.js';
import {
  resolveTokenAddress,
  chainIdFromName,
  parseDecimalToBaseUnits,
} from './custody.constants.js';

/** How often to poll ClearNode for channel status changes (ms). */
const POLL_INTERVAL_MS = 5_000;
/** Maximum wait for channel to reach 'open' status (seconds). */
const MAX_WAIT_SEC = 120;

/**
 * Orchestrates the full channel funding flow for a participant:
 *   1. Check existing channels/ledger
 *   2. Create channel (RPC + on-chain)
 *   3. Resize to add funds (RPC + on-chain)
 *   4. De-allocate channel → ledger (RPC + on-chain)
 *
 * After this, the participant has ledger balance with no channel
 * allocations blocking app session creation.
 */
@Injectable()
export class ChannelFundingService {
  private readonly logger = new Logger(ChannelFundingService.name);

  constructor(
    private readonly yellowClient: YellowClientService,
    private readonly custodyService: CustodyService,
    private readonly authService: YellowAuthService,
    private readonly keyProvider: KeyProvider,
  ) {}

  /**
   * Ensure a participant has at least `amount` in their ClearNode ledger
   * with no channel allocations blocking session creation.
   */
  async ensureLedgerBalance(
    address: Address,
    asset: string,
    amount: string,
    chainName: string,
  ): Promise<void> {
    const amountBig = BigInt(amount);
    if (amountBig === 0n) return;

    await this.authenticateWallet(address);

    const tokenAddress = resolveTokenAddress(asset, chainName);
    const currentAmount = await this.checkLedgerBalance(address, asset, tokenAddress);

    if (currentAmount >= amountBig) {
      this.logger.log(`${address.slice(0, 10)}... already has sufficient ledger balance`);
      await this.deallocateBlockingChannels(address, chainName);
      return;
    }

    const channelId = await this.findOrCreateChannel(address, asset, chainName);
    await this.resizeAndDeallocate(address, channelId, asset, amountBig, chainName);
  }

  // ─── Private steps ──────────────────────────────────────

  /** Authenticate wallet with ClearNode (skips if already auth'd). */
  private async authenticateWallet(address: Address): Promise<void> {
    const privateKey = this.keyProvider.getKey(address);
    if (!privateKey) {
      throw new Error(`No managed key for address ${address}`);
    }
    await this.authService.authWallet(privateKey);
  }

  /** Check current ledger balance, return amount in base units. */
  private async checkLedgerBalance(
    address: Address,
    asset: string,
    tokenAddress: Address | undefined,
  ): Promise<bigint> {
    const balances = await this.yellowClient.getLedgerBalances(address);
    this.logger.debug(
      `Ledger balances for ${address.slice(0, 10)}: ${JSON.stringify(balances.ledger_balances)}`,
    );
    const entry = balances.ledger_balances?.find(
      (b) =>
        b.asset === asset ||
        b.asset?.toLowerCase() === tokenAddress?.toLowerCase(),
    );
    return parseDecimalToBaseUnits(entry?.amount, 6);
  }

  /** De-allocate any channels that have non-zero allocation (would block session creation). */
  private async deallocateBlockingChannels(
    address: Address,
    chainName: string,
  ): Promise<void> {
    const channels = await this.yellowClient.getChannels(address, address);
    const blocking = channels.channels?.filter(
      (c: any) => c.status !== 'closed' && BigInt(c.amount || '0') > 0n,
    );
    if (!blocking?.length) return;

    this.logger.log(`${blocking.length} channel(s) with non-zero allocation, de-allocating...`);
    for (const ch of blocking) {
      await this.deallocateChannel(
        address,
        ch.channel_id as Hex,
        BigInt(ch.amount),
        chainName,
      );
    }
  }

  /** Find existing open channel or create a new one. */
  private async findOrCreateChannel(
    address: Address,
    asset: string,
    chainName: string,
  ): Promise<Hex> {
    const channels = await this.yellowClient.getChannels(address, address);
    const openChannel = channels.channels?.find((c: any) => c.status === 'open');

    if (openChannel) {
      const channelId = openChannel.channel_id as Hex;
      if (BigInt(openChannel.amount || '0') > 0n) {
        await this.deallocateChannel(address, channelId, BigInt(openChannel.amount), chainName);
      }
      return channelId;
    }

    return this.createAndWaitForChannel(address, asset, chainName);
  }

  /** Create channel via RPC + on-chain, wait for ClearNode to detect. */
  private async createAndWaitForChannel(
    address: Address,
    asset: string,
    chainName: string,
  ): Promise<Hex> {
    const tokenAddress = resolveTokenAddress(asset, chainName);
    if (!tokenAddress) {
      throw new Error(`Unknown token ${asset} on ${chainName}`);
    }

    const chainId = chainIdFromName(chainName);
    const result = await this.yellowClient.createChannel(
      { chain_id: chainId, token: tokenAddress },
      address,
    );
    const channelId = result.channel_id as Hex;
    this.logger.log(`Channel created (RPC): ${channelId.slice(0, 20)}...`);

    await this.custodyService.onchainCreateChannel(
      address,
      { channel: result.channel, state: result.state, server_signature: result.server_signature },
      chainName,
    );

    await this.waitForChannelOpen(address, channelId);
    return channelId;
  }

  /** Resize channel to add funds, then de-allocate to free channel for session. */
  private async resizeAndDeallocate(
    address: Address,
    channelId: Hex,
    asset: string,
    amount: bigint,
    chainName: string,
  ): Promise<void> {
    await this.ensureCustodyBalance(address, asset, amount, chainName);

    // Step 1: Resize with resize_amount (adds on-chain funds)
    this.logger.log(`Resize: adding ${amount} to channel ${channelId.slice(0, 20)}...`);
    const resize = await this.yellowClient.resizeChannel(
      { channel_id: channelId, resize_amount: amount, funds_destination: address },
      address,
    );
    await this.custodyService.onchainResize(
      address, channelId, resize.state, resize.server_signature as Hex, chainName,
    );
    await this.waitForChannelOpen(address, channelId);

    // Step 2: De-allocate (channel allocation → ledger balance)
    await this.deallocateChannel(address, channelId, amount, chainName);
  }

  /** Ensure Custody contract has enough balance, deposit from wallet if needed. */
  private async ensureCustodyBalance(
    address: Address,
    asset: string,
    amount: bigint,
    chainName: string,
  ): Promise<void> {
    const tokenAddress = resolveTokenAddress(asset, chainName);
    if (!tokenAddress) return;

    const bal = await this.custodyService.getCustodyBalance(address, tokenAddress, chainName);
    const custodyAmount = BigInt(bal.balance);
    if (custodyAmount >= amount) return;

    const deficit = amount - custodyAmount;
    this.logger.log(`Custody balance ${custodyAmount} < ${amount}, depositing ${deficit}...`);
    await this.custodyService.depositToCustody(address, tokenAddress, deficit, chainName);
  }

  /** De-allocate funds from channel to ledger via resize with negative allocate_amount. */
  private async deallocateChannel(
    address: Address,
    channelId: Hex,
    amount: bigint,
    chainName: string,
  ): Promise<void> {
    this.logger.log(`De-allocate: ${amount} from channel ${channelId.slice(0, 20)}...`);
    const resize = await this.yellowClient.resizeChannel(
      { channel_id: channelId, allocate_amount: -amount, funds_destination: address },
      address,
    );
    await this.custodyService.onchainResize(
      address, channelId, resize.state, resize.server_signature as Hex, chainName,
    );
    await this.waitForChannelOpen(address, channelId, 60);
    this.logger.log(`De-allocation complete for ${address.slice(0, 10)}...`);
  }

  // ─── Withdrawal flow (reverse of funding) ─────────────

  /**
   * Withdraw a participant's ledger balance back to their wallet.
   * Reverse of ensureLedgerBalance:
   *   1. Allocate ledger → channel (resize with positive allocate_amount)
   *   2. Resize out (negative resize_amount — moves funds from channel to Custody)
   *   3. Close channel via RPC
   *   4. Withdraw from Custody contract to wallet
   */
  async withdrawToWallet(
    address: Address,
    asset: string,
    amount: string,
    chainName: string,
  ): Promise<{ txHash: string }> {
    const amountBig = BigInt(amount);
    if (amountBig === 0n) return { txHash: '' };

    await this.authenticateWallet(address);

    // 1. Find or create an open channel
    const channelId = await this.findOrCreateChannel(address, asset, chainName);

    // 2. Allocate ledger → channel (positive allocate_amount)
    this.logger.log(`Allocate: ${amountBig} from ledger to channel ${channelId.slice(0, 20)}...`);
    const allocResize = await this.yellowClient.resizeChannel(
      { channel_id: channelId, allocate_amount: amountBig, funds_destination: address },
      address,
    );
    await this.custodyService.onchainResize(
      address, channelId, allocResize.state, allocResize.server_signature as Hex, chainName,
    );
    await this.waitForChannelOpen(address, channelId);

    // 3. Resize out (negative resize_amount — moves on-chain funds back to Custody)
    this.logger.log(`Resize out: ${amountBig} from channel to Custody...`);
    const resizeOut = await this.yellowClient.resizeChannel(
      { channel_id: channelId, resize_amount: -amountBig, funds_destination: address },
      address,
    );
    await this.custodyService.onchainResize(
      address, channelId, resizeOut.state, resizeOut.server_signature as Hex, chainName,
    );
    await this.waitForChannelOpen(address, channelId);

    // 4. Withdraw from Custody to wallet
    const tokenAddress = resolveTokenAddress(asset, chainName);
    if (!tokenAddress) throw new Error(`Unknown token ${asset} on ${chainName}`);

    const result = await this.custodyService.withdraw(address, tokenAddress, amount, chainName);
    this.logger.log(`Withdrawn ${amount} ${asset} to ${address.slice(0, 10)}... tx=${result.txHash}`);
    return { txHash: result.txHash };
  }

  // ─── Shared helpers ─────────────────────────────────────

  /** Poll ClearNode until channel reaches 'open' status. */
  private async waitForChannelOpen(
    address: Address,
    channelId: Hex,
    maxWaitSec = MAX_WAIT_SEC,
  ): Promise<void> {
    const polls = Math.ceil(maxWaitSec / (POLL_INTERVAL_MS / 1000));
    for (let i = 1; i <= polls; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const channels = await this.yellowClient.getChannels(address, address);
      const found = channels.channels?.find((c: any) => c.channel_id === channelId);
      if (found?.status === 'open') {
        this.logger.debug(
          `Channel ${channelId.slice(0, 14)}... open after ${i * (POLL_INTERVAL_MS / 1000)}s (amount=${found.amount})`,
        );
        return;
      }
    }
    throw new Error(`Channel ${channelId} did not reach open status after ${maxWaitSec}s`);
  }
}
