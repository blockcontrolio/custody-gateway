import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class WalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, address: string, label: string | null) {
    return this.prisma.managedWallet.create({
      data: { userId, address, label },
    });
  }

  async findByUserId(userId: string) {
    return this.prisma.managedWallet.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findAll(limit: number, offset: number) {
    return this.prisma.managedWallet.findMany({
      orderBy: { createdAt: 'asc' },
      take: limit,
      skip: offset,
    });
  }

  async findByAddress(address: string) {
    return this.prisma.managedWallet.findUnique({
      where: { address },
    });
  }
}
