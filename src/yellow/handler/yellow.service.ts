import {
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionRepository } from '../../repository/session.repository.js';
import type { StoredSession, SessionMetadata } from '../../repository/session.repository.js';
import { ChannelRepository } from '../../repository/channel.repository.js';
import { SignedStateRepository } from '../../repository/signed-state.repository.js';
import type { PersistSignedStateData } from '../yellow.types.js';
import { errorMessage } from '../yellow.utils.js';
import type { ParsedMessage } from '../yellow.types.js';

export type { StoredSession, SessionMetadata } from '../../repository/session.repository.js';

/** Coerce to string only when value is string or number; avoid '[object Object]'. */
function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

@Injectable()
export class YellowService implements OnModuleDestroy {
  private readonly logger = new Logger(YellowService.name);
  /** Active sessions by sessionId (in-memory cache). */
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
    @Inject(SessionRepository)
    private readonly sessionRepo?: SessionRepository,
    @Optional()
    @Inject(ChannelRepository)
    private readonly channelRepo?: ChannelRepository,
    @Optional()
    @Inject(SignedStateRepository)
    private readonly signedStateRepo?: SignedStateRepository,
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
        if (parsed.requestId != null) {
          this.handleResponse('error', parsed.error, parsed.requestId);
        } else {
          this.onError(parsed.error, undefined);
        }
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
    this.resolvePending(requestId, result, method);

    if (method === 'error') {
      this.onError(String(result), requestId);
      return;
    }

    const sessionId = this.extractSessionId(result);

    if (method === 'create_app_session' && sessionId) {
      void this.onSessionCreated(sessionId);
      return;
    }

    if (method === 'close_app_session' && sessionId) {
      void this.onSessionClosed(sessionId);
      return;
    }

    this.logger.debug(`Response: method=${method} requestId=${requestId}`);
  }

  private resolvePending(
    requestId: number,
    result: unknown,
    method: string,
  ): void {
    const pending = this.pendingResponses.get(requestId);
    if (!pending) return;
    this.pendingResponses.delete(requestId);
    try {
      pending(result, method);
    } catch (err) {
      this.logger.warn(
        `Pending callback error for requestId=${requestId}: ${errorMessage(err)}`,
      );
    }
  }

  /** Extract session ID from RPC result (ClearNode uses app_session_id). */
  private extractSessionId(result: unknown): string {
    if (!result || typeof result !== 'object') return '';
    const r = result as Record<string, unknown>;
    const raw = r.app_session_id ?? r.appSessionId ?? r.sessionId;
    return raw != null ? safeString(raw) : '';
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

  async onSessionCreated(
    sessionId: string,
    metadata?: SessionMetadata,
  ): Promise<void> {
    const now = Date.now();
    const session: StoredSession = {
      sessionId,
      createdAt: now,
      status: 'active',
      participants: metadata?.participants,
      allocations: metadata?.allocations,
    };
    this.sessions.set(sessionId, session);
    this.logger.log(`[Yellow] session_created: ${sessionId}`);
    if (this.sessionRepo) {
      await this.sessionRepo.upsertActive(sessionId, metadata);
    }
  }

  async updateSessionAllocations(
    sessionId: string,
    allocations: Array<{ asset: string; amount: string; participant: string }>,
    stateVersion?: number,
  ): Promise<void> {
    const cached = this.sessions.get(sessionId);
    if (cached) {
      cached.allocations = allocations;
      if (stateVersion != null) cached.stateVersion = stateVersion;
    }
    if (this.sessionRepo) {
      const existing = await this.sessionRepo.findSession(sessionId);
      await this.sessionRepo.updateMetadata(sessionId, {
        participants: existing?.participants,
        allocations,
      });
    }
  }

  async onSessionClosed(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.logger.log(`[Yellow] session_closed: ${sessionId}`);
    if (this.sessionRepo) {
      await this.sessionRepo.markClosed(sessionId);
    }
  }

  async getSession(sessionId: string): Promise<StoredSession | undefined> {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    if (this.sessionRepo) {
      const session = await this.sessionRepo.findSession(sessionId);
      if (session) {
        this.sessions.set(sessionId, session);
        return session;
      }
    }
    return undefined;
  }

  async getAllSessions(): Promise<StoredSession[]> {
    if (this.sessionRepo) {
      return this.sessionRepo.findAllActive();
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
    if (this.channelRepo) {
      this.channelRepo.upsertFromPayload(payload).catch((err) =>
        this.logger.warn(
          `Failed to persist channel update: ${errorMessage(err)}`,
        ),
      );
    }
  }

  async persistSignedState(data: PersistSignedStateData): Promise<void> {
    if (this.signedStateRepo) {
      await this.signedStateRepo.create(data);
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
    if (safeString(p?.status).toLowerCase() === 'closed') {
      const id = this.extractSessionId(p);
      if (id) void this.onSessionClosed(id);
    }
  }

  onError(error: string, requestId?: number): void {
    this.logger.error(
      `[Yellow] error${requestId != null ? ` requestId=${requestId}` : ''}: ${error}`,
    );
  }
}
