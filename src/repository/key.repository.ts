import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class KeyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(address: string, encryptedKey: string, iv: string, tag: string) {
    return this.prisma.managedKey.upsert({
      where: { address },
      update: { encryptedKey, iv, tag },
      create: { address, encryptedKey, iv, tag },
    });
  }

  async findAll() {
    return this.prisma.managedKey.findMany();
  }
}
