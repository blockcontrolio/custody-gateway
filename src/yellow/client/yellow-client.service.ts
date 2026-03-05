import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import {
  createAppSessionMessage,
  createSubmitAppStateMessage,
  createCloseAppSessionMessage,
  createGetChannelsMessage,
  createTransferMessage,
} from '@erc7824/nitrolite';
import type {
  MessageSigner,
  CreateAppSessionRequestParams,
  CloseAppSessionRequestParams,
  TransferRequestParams,
} from '@erc7824/nitrolite';
import { RPCChannelStatus } from '@erc7824/nitrolite';
import type { Hex } from 'viem';
import { ClearNodeService } from '../../clear-node/clear-node.service';
import { YellowService } from '../handler/yellow.service';
import type { PersistSignedStateData } from '../yellow.types';
import { KeyProviderService } from '../providers/key-provider.service';
import { RequestIdService } from '../providers/request-id.service';
import { RPC_TIMEOUT_MS } from '../yellow.constants';
import { toError } from '../yellow.utils';

@Injectable()
export class YellowClientService {
  private readonly logger = new Logger(YellowClientService.name);

  constructor(
    @Inject(forwardRef(() => ClearNodeService))
    private readonly clearNodeService: Pick<ClearNodeService, 'sendRaw'>,
    @Inject(YellowService)
    private readonly yellowService: Pick<
      YellowService,
      | 'isEnabled'
      | 'registerPendingResponse'
      | 'deletePendingResponse'
      | 'persistSignedState'
    >,
    @Inject(KeyProviderService)
    private readonly keyProvider: Pick<
      KeyProviderService,
      'isConfigured' | 'createSigner'
    >,
    private readonly requestIdService: RequestIdService,
  ) {}

  isConfigured(): boolean {
    if (!this.yellowService.isEnabled()) return false;
    return this.keyProvider.isConfigured();
  }

  private getSigner(): MessageSigner | null {
    return this.keyProvider.createSigner();
  }

  /** Send signed RPC, wait for response or timeout. */
  private sendRequest<T>(
    requestId: number,
    buildMessage: (signer: MessageSigner) => Promise<string>,
  ): Promise<T> {
    const signer = this.getSigner();
    if (!signer) {
      return Promise.reject(
        new Error('YELLOW_SIGNER_PRIVATE_KEY not set or invalid'),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.yellowService.deletePendingResponse(requestId);
        reject(
          new Error(
            `RPC request ${requestId} timed out after ${RPC_TIMEOUT_MS}ms`,
          ),
        );
      }, RPC_TIMEOUT_MS);

      const cleanup = (err: Error) => {
        clearTimeout(timeout);
        this.yellowService.deletePendingResponse(requestId);
        reject(err);
      };

      this.yellowService.registerPendingResponse(
        requestId,
        (result, method) => {
          clearTimeout(timeout);
          if (method === 'error') reject(new Error(String(result)));
          else {
            this.tryPersistSignedState(result, method);
            resolve(result as T);
          }
        },
      );

      buildMessage(signer)
        .then((msg) => this.clearNodeService.sendRaw(msg))
        .catch((err) => cleanup(toError(err)));
    });
  }

  /** One RPC call: next requestId, log, build+send, return result. */
  private rpc<T>(
    methodName: string,
    build: (signer: MessageSigner, requestId: number) => Promise<string>,
  ): Promise<T> {
    const requestId = this.requestIdService.nextId();
    this.logger.debug(`${methodName} requestId=${requestId}`);
    return this.sendRequest<T>(requestId, (s) => build(s, requestId));
  }

  async createAppSession(
    params: CreateAppSessionRequestParams,
  ): Promise<unknown> {
    return this.rpc('create_app_session', (s, id) =>
      createAppSessionMessage(s, params, id),
    );
  }

  async submitAppState(params: {
    app_session_id: Hex;
    allocations: Array<{ asset: string; amount: string; participant: Hex }>;
    session_data?: string;
  }): Promise<unknown> {
    return this.rpc('submit_app_state', (s, id) =>
      createSubmitAppStateMessage(
        s,
        params as Parameters<typeof createSubmitAppStateMessage>[1],
        id,
      ),
    );
  }

  async closeAppSession(
    params: CloseAppSessionRequestParams,
  ): Promise<unknown> {
    return this.rpc('close_app_session', (s, id) =>
      createCloseAppSessionMessage(s, params, id),
    );
  }

  async getChannels(
    participant?: Hex,
    status?: RPCChannelStatus,
  ): Promise<unknown> {
    return this.rpc('get_channels', (s, id) =>
      createGetChannelsMessage(s, participant, status, id),
    );
  }

  async transfer(params: TransferRequestParams): Promise<unknown> {
    return this.rpc('transfer', (s, id) =>
      createTransferMessage(s, params, id),
    );
  }

  /**
   * Persist signed state for dispute resolution when response contains
   * channelId, signatures, and state data (submit_app_state, close_app_session).
   */
  private tryPersistSignedState(result: unknown, method?: string): void {
    if (method !== 'submit_app_state' && method !== 'close_app_session') {
      return;
    }
    const r = result as Record<string, unknown>;
    const channelId =
      typeof r?.channelId === 'string'
        ? r.channelId
        : typeof r?.channel_id === 'string'
          ? r.channel_id
          : undefined;
    const signatures = r?.signatures ?? r?.sigs;
    if (!channelId || !Array.isArray(signatures) || signatures.length === 0) {
      return;
    }
    const data: PersistSignedStateData = {
      channelId,
      sessionId:
        typeof r?.sessionId === 'string'
          ? r.sessionId
          : typeof r?.app_session_id === 'string'
            ? r.app_session_id
            : undefined,
      stateVersion:
        typeof r?.stateVersion === 'number'
          ? r.stateVersion
          : ((r?.version as number) ?? 0),
      intent:
        typeof r?.intent === 'string'
          ? r.intent
          : typeof r?.intent === 'number'
            ? String(r.intent)
            : 'OPERATE',
      stateData: r?.stateData ?? r?.state ?? {},
      allocations: r?.allocations ?? [],
      signatures,
      rawMessage:
        typeof r?.rawMessage === 'string'
          ? r.rawMessage
          : JSON.stringify(result),
    };
    void this.yellowService.persistSignedState(data);
  }
}
