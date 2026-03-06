import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import type { Address } from 'viem';
import { PrismaService } from '../prisma/prisma.service';
import { KeyProvider } from '../key-provider';

export interface WalletInfo {
  address: string;
  label: string | null;
  createdAt: Date;
}

export interface AccountInfo {
  userId: string;
  wallets: WalletInfo[];
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keyProvider: KeyProvider,
  ) {}

  /**
   * Create a new account: auto-generate userId (UUID v4) + wallet.
   */
  async createAccount(label?: string): Promise<{ userId: string; wallet: WalletInfo }> {
    const userId = crypto.randomUUID();
    const address = await this.keyProvider.generateKey();
    const wallet = await this.prisma.managedWallet.create({
      data: { userId, address: address as string, label: label ?? null },
    });
    this.logger.log(`Created account ${userId} with wallet ${address}`);
    return {
      userId,
      wallet: { address: wallet.address, label: wallet.label, createdAt: wallet.createdAt },
    };
  }

  /**
   * Add an additional wallet to an existing user.
   */
  async addWallet(userId: string, label?: string): Promise<WalletInfo> {
    const existing = await this.prisma.managedWallet.findFirst({
      where: { userId },
    });
    if (!existing) {
      throw new NotFoundException(`User ${userId} not found. Create an account first.`);
    }
    const address = await this.keyProvider.generateKey();
    const wallet = await this.prisma.managedWallet.create({
      data: { userId, address: address as string, label: label ?? null },
    });
    this.logger.log(`Added wallet ${address} to user ${userId}`);
    return { address: wallet.address, label: wallet.label, createdAt: wallet.createdAt };
  }

  /**
   * Get all wallets for a user.
   */
  async getAccount(userId: string): Promise<AccountInfo> {
    const wallets = await this.prisma.managedWallet.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    if (wallets.length === 0) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    return {
      userId,
      wallets: wallets.map((w) => ({
        address: w.address,
        label: w.label,
        createdAt: w.createdAt,
      })),
    };
  }

  /**
   * List all accounts (paginated).
   */
  async listAccounts(limit = 100, offset = 0): Promise<AccountInfo[]> {
    const wallets = await this.prisma.managedWallet.findMany({
      orderBy: { createdAt: 'asc' },
      take: limit,
      skip: offset,
    });

    // Group by userId
    const grouped = new Map<string, WalletInfo[]>();
    for (const w of wallets) {
      const arr = grouped.get(w.userId) ?? [];
      arr.push({ address: w.address, label: w.label, createdAt: w.createdAt });
      grouped.set(w.userId, arr);
    }

    return Array.from(grouped.entries()).map(([userId, ws]) => ({
      userId,
      wallets: ws,
    }));
  }

  /**
   * Resolve userId → primary wallet address (first created).
   * Used by other services to map userId to address.
   */
  async resolveAddress(userId: string): Promise<Address> {
    const wallet = await this.prisma.managedWallet.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    if (!wallet) {
      throw new NotFoundException(`No wallet found for user ${userId}`);
    }
    return wallet.address as Address;
  }

  /**
   * Resolve userId → all wallet addresses.
   */
  async resolveAddresses(userId: string): Promise<Address[]> {
    const wallets = await this.prisma.managedWallet.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    if (wallets.length === 0) {
      throw new NotFoundException(`No wallets found for user ${userId}`);
    }
    return wallets.map((w) => w.address as Address);
  }

  /**
   * Look up userId by address (reverse lookup).
   */
  async findUserByAddress(address: string): Promise<string | null> {
    const wallet = await this.prisma.managedWallet.findUnique({
      where: { address },
    });
    return wallet?.userId ?? null;
  }
}
