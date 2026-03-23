import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { errorMessage } from '../yellow/yellow.utils.js';

export interface StoredInvitation {
  id: string;
  token: string;
  initiatorAddr: string;
  inviteeAddr: string;
  amountInitiator: string;
  amountInvitee: string;
  status: 'pending' | 'accepted' | 'rejected';
  sessionId?: string;
  createdAt: number;
  respondedAt?: number;
}

@Injectable()
export class InvitationRepository {
  private readonly logger = new Logger(InvitationRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(data: {
    token: string;
    initiatorAddr: string;
    inviteeAddr: string;
    amountInitiator: string;
    amountInvitee: string;
  }): Promise<StoredInvitation> {
    const row = await this.prisma.sessionInvitation.create({ data });
    return this.toStored(row);
  }

  async findById(id: string): Promise<StoredInvitation | undefined> {
    const row = await this.prisma.sessionInvitation.findUnique({
      where: { id },
    });
    return row ? this.toStored(row) : undefined;
  }

  async findPendingForAddress(address: string): Promise<StoredInvitation[]> {
    const rows = await this.prisma.sessionInvitation.findMany({
      where: { inviteeAddr: address, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toStored(r));
  }

  async findPendingByInitiator(address: string): Promise<StoredInvitation[]> {
    const rows = await this.prisma.sessionInvitation.findMany({
      where: { initiatorAddr: address, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toStored(r));
  }

  async accept(id: string, sessionId: string): Promise<void> {
    try {
      await this.prisma.sessionInvitation.update({
        where: { id },
        data: { status: 'accepted', sessionId, respondedAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(`Failed to accept invitation ${id}: ${errorMessage(err)}`);
      throw err;
    }
  }

  async reject(id: string): Promise<void> {
    try {
      await this.prisma.sessionInvitation.update({
        where: { id },
        data: { status: 'rejected', respondedAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(`Failed to reject invitation ${id}: ${errorMessage(err)}`);
      throw err;
    }
  }

  private toStored(row: {
    id: string;
    token: string;
    initiatorAddr: string;
    inviteeAddr: string;
    amountInitiator: string;
    amountInvitee: string;
    status: string;
    sessionId: string | null;
    createdAt: Date;
    respondedAt: Date | null;
  }): StoredInvitation {
    return {
      id: row.id,
      token: row.token,
      initiatorAddr: row.initiatorAddr,
      inviteeAddr: row.inviteeAddr,
      amountInitiator: row.amountInitiator,
      amountInvitee: row.amountInvitee,
      status: row.status as StoredInvitation['status'],
      sessionId: row.sessionId ?? undefined,
      createdAt: row.createdAt.getTime(),
      respondedAt: row.respondedAt?.getTime(),
    };
  }
}
