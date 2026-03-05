import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelStateStatus } from '../yellow/yellow.constants';
import { errorMessage } from '../yellow/yellow.utils';

type ChannelStatus = 'active' | 'closed' | 'challenged';

function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function parseStatus(raw: unknown): ChannelStatus {
  const s = (raw != null ? safeString(raw) : 'active').toLowerCase() || 'active';
  if (s === 'closed') return ChannelStateStatus.closed;
  if (s === 'challenged') return ChannelStateStatus.challenged;
  return ChannelStateStatus.active;
}

@Injectable()
export class ChannelRepository {
  private readonly logger = new Logger(ChannelRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsertFromPayload(payload: unknown): Promise<void> {
    const p = payload as Record<string, unknown>;
    const channelId = safeString(p?.channelId ?? p?.channel_id) || '';
    if (!channelId) return;

    const status = parseStatus(p?.status);
    const participants = Array.isArray(p?.participants)
      ? (p.participants as unknown[])
      : p?.participant != null
        ? [p.participant]
        : [];
    const chainId =
      typeof p?.chainId === 'number'
        ? p.chainId
        : typeof p?.chain_id === 'number'
          ? p.chain_id
          : null;
    const token = p?.token != null ? safeString(p.token) : null;
    const balance =
      p?.amount != null || p?.balance != null ? (p.balance ?? p.amount) : null;

    const participantsJson = participants as Prisma.InputJsonValue;
    const balanceJson = balance as Prisma.InputJsonValue | null;

    try {
      await this.prisma.channelState.upsert({
        where: { channelId },
        create: {
          channelId,
          status,
          participants: participantsJson,
          chainId,
          token,
          balance: balanceJson ?? undefined,
        },
        update: {
          status,
          participants: participantsJson,
          chainId,
          token,
          balance: balanceJson ?? undefined,
          lastUpdate: new Date(),
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to persist channel ${channelId}: ${errorMessage(err)}`,
      );
    }
  }
}
