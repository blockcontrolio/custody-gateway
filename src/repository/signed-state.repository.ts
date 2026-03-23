import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SignedStateIntent } from '../yellow/yellow.constants.js';
import { errorMessage } from '../yellow/yellow.utils.js';
import type { PersistSignedStateData } from '../yellow/yellow.types.js';

type SignedStateIntentType = 'OPERATE' | 'INITIALIZE' | 'RESIZE' | 'FINALIZE';

function parseIntent(raw: unknown): SignedStateIntentType {
  const s =
    (raw != null && (typeof raw === 'string' || typeof raw === 'number')
      ? String(raw)
      : 'OPERATE'
    ).toUpperCase() || 'OPERATE';
  if (s === 'INITIALIZE') return SignedStateIntent.INITIALIZE;
  if (s === 'RESIZE') return SignedStateIntent.RESIZE;
  if (s === 'FINALIZE') return SignedStateIntent.FINALIZE;
  return SignedStateIntent.OPERATE;
}

@Injectable()
export class SignedStateRepository {
  private readonly logger = new Logger(SignedStateRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(data: PersistSignedStateData): Promise<void> {
    try {
      await this.prisma.signedState.create({
        data: {
          channelId: data.channelId,
          sessionId: data.sessionId ?? undefined,
          stateVersion: data.stateVersion,
          intent: parseIntent(data.intent),
          stateData: data.stateData as object,
          allocations: data.allocations as object,
          signatures: data.signatures as object,
          rawMessage: data.rawMessage,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to persist signed state: ${errorMessage(err)}`);
    }
  }
}
