import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { YellowSessionStatus } from '../yellow/yellow.constants';
import { errorMessage } from '../yellow/yellow.utils';

export interface StoredSession {
  sessionId: string;
  createdAt: number;
  partnerId?: string;
  userId?: string;
}

@Injectable()
export class SessionRepository {
  private readonly logger = new Logger(SessionRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsertActive(sessionId: string): Promise<void> {
    try {
      await this.prisma.yellowSession.upsert({
        where: { sessionId },
        create: { sessionId, status: YellowSessionStatus.active },
        update: { status: YellowSessionStatus.active },
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

  async findActive(sessionId: string): Promise<StoredSession | undefined> {
    try {
      const row = await this.prisma.yellowSession.findUnique({
        where: { sessionId },
      });
      if (row?.status === YellowSessionStatus.active) {
        return {
          sessionId: row.sessionId,
          createdAt: row.createdAt.getTime(),
          partnerId: row.partnerId ?? undefined,
          userId: row.userId ?? undefined,
        };
      }
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
      return rows.map((r) => ({
        sessionId: r.sessionId,
        createdAt: r.createdAt.getTime(),
        partnerId: r.partnerId ?? undefined,
        userId: r.userId ?? undefined,
      }));
    } catch (err) {
      this.logger.warn(`Failed to fetch sessions: ${errorMessage(err)}`);
      return [];
    }
  }
}
