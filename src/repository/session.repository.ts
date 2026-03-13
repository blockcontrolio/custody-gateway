import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { YellowSessionStatus } from '../yellow/yellow.constants';
import { errorMessage } from '../yellow/yellow.utils';

export interface SessionAllocation {
  asset: string;
  amount: string;
  participant: string;
}

export interface SessionMetadata {
  participants?: string[];
  allocations?: SessionAllocation[];
}

export interface StoredSession {
  sessionId: string;
  createdAt: number;
  status: 'active' | 'closed';
  partnerId?: string;
  userId?: string;
  participants?: string[];
  allocations?: SessionAllocation[];
}

@Injectable()
export class SessionRepository {
  private readonly logger = new Logger(SessionRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsertActive(
    sessionId: string,
    metadata?: SessionMetadata,
  ): Promise<void> {
    try {
      await this.prisma.yellowSession.upsert({
        where: { sessionId },
        create: {
          sessionId,
          status: YellowSessionStatus.active,
          ...(metadata && { metadata: metadata as unknown as Prisma.InputJsonValue }),
        },
        update: {
          status: YellowSessionStatus.active,
          ...(metadata && { metadata: metadata as unknown as Prisma.InputJsonValue }),
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to persist session ${sessionId}: ${errorMessage(err)}`,
      );
    }
  }

  async markClosed(sessionId: string): Promise<void> {
    try {
      const closedAt = new Date();
      await this.prisma.yellowSession.upsert({
        where: { sessionId },
        create: { sessionId, status: YellowSessionStatus.closed, closedAt },
        update: { status: YellowSessionStatus.closed, closedAt },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to mark session ${sessionId} closed: ${errorMessage(err)}`,
      );
    }
  }

  async updateMetadata(
    sessionId: string,
    metadata: SessionMetadata,
  ): Promise<void> {
    try {
      await this.prisma.yellowSession.update({
        where: { sessionId },
        data: { metadata: metadata as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to update metadata for session ${sessionId}: ${errorMessage(err)}`,
      );
    }
  }

  async findSession(sessionId: string): Promise<StoredSession | undefined> {
    try {
      const row = await this.prisma.yellowSession.findUnique({
        where: { sessionId },
      });
      if (!row) return undefined;
      return this.toStoredSession(row);
    } catch (err) {
      this.logger.warn(
        `Failed to fetch session ${sessionId}: ${errorMessage(err)}`,
      );
    }
    return undefined;
  }

  async findAllActive(): Promise<StoredSession[]> {
    try {
      const rows = await this.prisma.yellowSession.findMany({
        where: { status: YellowSessionStatus.active },
      });
      return rows.map((r) => this.toStoredSession(r));
    } catch (err) {
      this.logger.warn(`Failed to fetch sessions: ${errorMessage(err)}`);
      return [];
    }
  }

  private toStoredSession(row: {
    sessionId: string;
    status: string;
    createdAt: Date;
    partnerId: string | null;
    userId: string | null;
    metadata: unknown;
  }): StoredSession {
    const meta = (row.metadata ?? {}) as SessionMetadata;
    return {
      sessionId: row.sessionId,
      createdAt: row.createdAt.getTime(),
      status: row.status as 'active' | 'closed',
      partnerId: row.partnerId ?? undefined,
      userId: row.userId ?? undefined,
      participants: meta.participants,
      allocations: meta.allocations,
    };
  }
}
