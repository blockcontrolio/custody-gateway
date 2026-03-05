import {
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  YellowSessionStatus,
  ChannelStateStatus,
  SignedStateIntent,
} from '../yellow.constants';
import { errorMessage } from '../yellow.utils';

/** Session shape used by this service (matches YellowSession in yellow.types). Exported for controller return types. */
export interface StoredSession {
  sessionId: string;
  createdAt: number;
  partnerId?: string;
  userId?: string;
}

/** Parsed Nitro RPC message (same shape as yellow.types.ParsedMessage). */
type ParsedMessage =
  | {
      kind: 'response';
      requestId: number;
      method: string;
      result: unknown;
      timestamp?: number;
    }
  | {
      kind: 'request';
      requestId: number;
      method: string;
      params: unknown;
      timestamp?: number;
    }
  | { kind: 'notification'; type: string; payload: unknown }
  | { kind: 'error'; requestId?: number; error: string; timestamp?: number }
  | { kind: 'unknown'; raw: unknown };

/** Channel status (same as yellow.types.ChannelStateStatus). */
type ChannelStateStatusType = 'active' | 'closed' | 'challenged';

/** Signed state intent (same as yellow.types.SignedStateIntent). */
type SignedStateIntentType = 'OPERATE' | 'INITIALIZE' | 'RESIZE' | 'FINALIZE';

/** Data for persistSignedState (same shape as yellow.types.PersistSignedStateData). */
interface PersistSignedStateData {
  channelId: string;
  sessionId?: string;
  stateVersion: number;
  intent: string;
  stateData: unknown;
  allocations: unknown;
  signatures: unknown;
  rawMessage: string;
}

/** Coerce to string only when value is string or number; avoid '[object Object]'. */
function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

@Injectable()
export class YellowService implements OnModuleDestroy {
  private readonly logger = new Logger(YellowService.name);
  /** Active sessions by sessionId (cache). */
  private readonly sessions = new Map<string, StoredSession>();
  /** Pending response callbacks by requestId (for outgoing requests). */
  private readonly pendingResponses = new Map<
    number,
    (result: unknown, method?: string) => void
  >();

  constructor(
    @Inject(ConfigService)
    private readonly configService: Pick<ConfigService, 'get'>,
    @Optional()
    @Inject(PrismaService)
    private readonly prisma?: PrismaService,
  ) {}

  isEnabled(): boolean {
    const value = this.configService.get<string>('YELLOW_PARTNER_ENABLED');
    return value === 'true' || value === '1';
  }

  handleMessage(parsed: ParsedMessage): void {
    switch (parsed.kind) {
      case 'response':
        this.handleResponse(parsed.method, parsed.result, parsed.requestId);
        break;
      case 'request':
        this.logger.debug(
          `Incoming request: method=${parsed.method} requestId=${parsed.requestId}`,
        );
        break;
      case 'notification':
        this.handleNotification(parsed.type, parsed.payload);
        break;
      case 'error':
        this.onError(parsed.error, parsed.requestId);
        break;
      case 'unknown':
        this.logger.debug(
          `Unknown message shape: ${JSON.stringify(parsed.raw).slice(0, 200)}`,
        );
        break;
    }
  }

  private handleResponse(
    method: string,
    result: unknown,
    requestId: number,
  ): void {
    const pending = this.pendingResponses.get(requestId);
    if (pending) {
      this.pendingResponses.delete(requestId);
      try {
        pending(result, method);
      } catch (err) {
        this.logger.warn(
          `Pending response handler error for requestId=${requestId}: ${errorMessage(err)}`,
        );
      }
    }
    if (method === 'error') {
      this.onError(String(result), requestId);
      return;
    }
    if (
      method === 'session_created' ||
      (result && typeof result === 'object' && 'sessionId' in result)
    ) {
      const sessionId = (result as { sessionId?: string })?.sessionId;
      void this.onSessionCreated(sessionId ?? String(result));
      return;
    }
    if (method === 'close_app_session') {
      const r = result as Record<string, unknown>;
      const sessionId = r?.appSessionId ?? r?.app_session_id ?? r?.sessionId;
      const id = sessionId != null ? safeString(sessionId) : '';
      if (id) void this.onSessionClosed(id);
      return;
    }
    this.logger.debug(`Response: method=${method} requestId=${requestId}`);
  }

  /** Register a callback for the response with the given requestId (for outgoing requests). */
  registerPendingResponse(
    requestId: number,
    resolve: (result: unknown, method?: string) => void,
  ): void {
    this.pendingResponses.set(requestId, resolve);
  }

  /** Remove a pending response (e.g. on timeout). */
  deletePendingResponse(requestId: number): void {
    this.pendingResponses.delete(requestId);
  }

  /**
   * Reject all pending RPC callbacks (e.g. on shutdown).
   * Each callback receives (reason, 'error') so it will reject with an error.
   */
  rejectAllPending(reason: string): void {
    for (const [requestId, pending] of this.pendingResponses) {
      this.pendingResponses.delete(requestId);
      try {
        pending(new Error(reason), 'error');
      } catch (err) {
        this.logger.warn(
          `rejectAllPending handler error for requestId=${requestId}: ${errorMessage(err)}`,
        );
      }
    }
  }

  onModuleDestroy(): void {
    this.rejectAllPending('Application shutting down');
  }

  private handleNotification(type: string, payload: unknown): void {
    const p = payload as Record<string, unknown>;
    switch (type) {
      case 'session_created':
        void this.onSessionCreated(String(p?.sessionId ?? payload));
        break;
      case 'payment':
        this.onPayment(p);
        break;
      case 'session_message':
        this.onSessionMessage(p);
        break;
      case 'bu':
        this.onBalanceUpdate(p);
        break;
      case 'cu':
        this.onChannelUpdate(p);
        break;
      case 'tr':
        this.onTransfer(p);
        break;
      case 'asu':
        this.onAppSessionUpdate(p);
        break;
      case 'error':
        this.onError(String(p?.error ?? payload), undefined);
        break;
      default:
        this.logger.debug(`Notification: type=${type}`);
    }
  }

  async onSessionCreated(sessionId: string): Promise<void> {
    const now = Date.now();
    const session: StoredSession = { sessionId, createdAt: now };
    this.sessions.set(sessionId, session);
    this.logger.log(`[Yellow] session_created: ${sessionId}`);
    if (this.prisma) {
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
  }

  /**
   * Mark session as closed.
   * Called on close_app_session RPC response success or asu notification with status=closed.
   */
  async onSessionClosed(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.logger.log(`[Yellow] session_closed: ${sessionId}`);
    if (this.prisma) {
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
  }

  async getSession(sessionId: string): Promise<StoredSession | undefined> {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    if (this.prisma) {
      try {
        const row = await this.prisma.yellowSession.findUnique({
          where: { sessionId },
        });
        if (row?.status === YellowSessionStatus.active) {
          const session: StoredSession = {
            sessionId: row.sessionId,
            createdAt: row.createdAt.getTime(),
            partnerId: row.partnerId ?? undefined,
            userId: row.userId ?? undefined,
          };
          this.sessions.set(sessionId, session);
          return session;
        }
      } catch (err) {
        this.logger.warn(
          `Failed to fetch session ${sessionId}: ${errorMessage(err)}`,
        );
      }
    }
    return undefined;
  }

  /** All known sessions (active only). */
  async getAllSessions(): Promise<StoredSession[]> {
    if (this.prisma) {
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
      }
    }
    return Array.from(this.sessions.values());
  }

  private formatPayloadField(v: unknown): string {
    if (v == null) return '?';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    return JSON.stringify(v);
  }

  onPayment(payload: unknown): void {
    const p = payload as Record<string, unknown>;
    const amount = this.formatPayloadField(p?.amount);
    const sender = this.formatPayloadField(p?.sender);
    const recipient = this.formatPayloadField(p?.recipient);
    this.logger.log(
      `[Yellow] payment: amount=${amount} sender=${sender} recipient=${recipient}`,
    );
    // TODO: call internal API/event when integration is ready
  }

  onSessionMessage(payload: unknown): void {
    this.logger.debug(`[Yellow] session_message: ${JSON.stringify(payload)}`);
  }

  onBalanceUpdate(payload: unknown): void {
    this.logger.debug(
      `[Yellow] balance_update (bu): ${JSON.stringify(payload)}`,
    );
  }

  onChannelUpdate(payload: unknown): void {
    this.logger.debug(
      `[Yellow] channel_update (cu): ${JSON.stringify(payload)}`,
    );
    if (this.prisma) {
      this.persistChannelUpdate(payload).catch((err) =>
        this.logger.warn(
          `Failed to persist channel update: ${errorMessage(err)}`,
        ),
      );
    }
  }

  private parseChannelStateStatus(raw: unknown): ChannelStateStatusType {
    const s =
      (raw != null ? safeString(raw) : 'active').toLowerCase() || 'active';
    if (s === 'closed') return ChannelStateStatus.closed;
    if (s === 'challenged') return ChannelStateStatus.challenged;
    return ChannelStateStatus.active;
  }

  private async persistChannelUpdate(payload: unknown): Promise<void> {
    if (!this.prisma) return;
    const p = payload as Record<string, unknown>;
    const channelId = safeString(p?.channelId ?? p?.channel_id) || '';
    if (!channelId) return;
    const status = this.parseChannelStateStatus(p?.status);
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
  }

  private parseSignedStateIntent(raw: unknown): SignedStateIntentType {
    const s =
      (raw != null ? safeString(raw) : 'OPERATE').toUpperCase() || 'OPERATE';
    if (s === 'INITIALIZE') return SignedStateIntent.INITIALIZE;
    if (s === 'RESIZE') return SignedStateIntent.RESIZE;
    if (s === 'FINALIZE') return SignedStateIntent.FINALIZE;
    return SignedStateIntent.OPERATE;
  }

  /** Persist signed state for dispute resolution (called from yellow-client after RPC response). */
  async persistSignedState(data: PersistSignedStateData): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.signedState.create({
        data: {
          channelId: data.channelId,
          sessionId: data.sessionId ?? undefined,
          stateVersion: data.stateVersion,
          intent: this.parseSignedStateIntent(data.intent),
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

  onTransfer(payload: unknown): void {
    this.logger.log(`[Yellow] transfer (tr): ${JSON.stringify(payload)}`);
  }

  onAppSessionUpdate(payload: unknown): void {
    this.logger.debug(
      `[Yellow] app_session_update (asu): ${JSON.stringify(payload)}`,
    );
    const p = payload as Record<string, unknown>;
    const status = safeString(p?.status).toLowerCase();
    if (status === 'closed') {
      const sessionId = p?.appSessionId ?? p?.app_session_id ?? p?.sessionId;
      const id = sessionId != null ? safeString(sessionId) : '';
      if (id) void this.onSessionClosed(id);
    }
  }

  onError(error: string, requestId?: number): void {
    this.logger.error(
      `[Yellow] error${requestId != null ? ` requestId=${requestId}` : ''}: ${error}`,
    );
    // TODO: metrics/alerts when needed
  }
}
