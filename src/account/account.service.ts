import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import type { Address } from 'viem';
import { KeyProvider } from '../key-provider/index.js';
import { CustodyService } from '../custody/custody.service.js';
import { WalletRepository } from '../repository/wallet.repository.js';
import { resolveTokenAddress, TOKENS, DEFAULT_CHAIN } from '../custody/custody.constants.js';

export interface AccountInfo {
  userId: string;
  walletAddress: string;
  label: string | null;
  createdAt: Date;
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly walletRepo: WalletRepository,
    private readonly keyProvider: KeyProvider,
    private readonly custodyService: CustodyService,
  ) {}

  async createAccount(label?: string): Promise<AccountInfo> {
    const userId = crypto.randomUUID();
    const address = await this.keyProvider.generateKey();
    const wallet = await this.walletRepo.create(userId, address as string, label ?? null);
    this.logger.log(`Created account ${userId} with wallet ${address}`);
    return {
      userId,
      walletAddress: wallet.address,
      label: wallet.label,
      createdAt: wallet.createdAt,
    };
  }

  async getAccount(userId: string): Promise<AccountInfo> {
    const wallet = await this.walletRepo.findByUserId(userId);
    if (!wallet) throw new NotFoundException(`User ${userId} not found`);
    return {
      userId,
      walletAddress: wallet.address,
      label: wallet.label,
      createdAt: wallet.createdAt,
    };
  }

  async listAccounts(limit = 100, offset = 0): Promise<AccountInfo[]> {
    const wallets = await this.walletRepo.findAll(limit, offset);
    return wallets.map((w) => ({
      userId: w.userId,
      walletAddress: w.address,
      label: w.label,
      createdAt: w.createdAt,
    }));
  }

  async resolveAddress(userId: string): Promise<Address> {
    const wallet = await this.walletRepo.findByUserId(userId);
    if (!wallet) throw new NotFoundException(`No wallet found for user ${userId}`);
    return wallet.address as Address;
  }

  async findUserByAddress(address: string): Promise<string | null> {
    const wallet = await this.walletRepo.findByAddress(address);
    return wallet?.userId ?? null;
  }

  async getBalance(
    userId: string,
    chainName = DEFAULT_CHAIN,
  ) {
    const address = await this.resolveAddress(userId);
    const ethBal = await this.custodyService.getWalletBalance(address, chainName);

    const chainTokens = TOKENS[chainName] ?? {};
    const tokens: Record<string, string> = {};
    for (const [symbol, tokenAddr] of Object.entries(chainTokens)) {
      try {
        const bal = await this.custodyService.getTokenBalance(
          address,
          tokenAddr as Address,
          chainName,
        );
        tokens[symbol] = bal.formatted;
      } catch {
        tokens[symbol] = '0';
      }
    }

    return { userId, address, chain: chainName, eth: ethBal.formatted, tokens };
  }

  async transfer(
    userId: string,
    to: string,
    asset: string,
    amount: string,
    chainName = DEFAULT_CHAIN,
  ) {
    const from = await this.resolveAddress(userId);

    if (asset.toLowerCase() === 'eth') {
      const { parseEther } = await import('viem');
      return this.custodyService.transferEth(from, to as Address, parseEther(amount), chainName);
    }

    const tokenAddr = resolveTokenAddress(asset, chainName);
    if (!tokenAddr) throw new BadRequestException(`Unknown token "${asset}" on "${chainName}"`);
    return this.custodyService.transferToken(from, to as Address, tokenAddr, amount, chainName);
  }
}
