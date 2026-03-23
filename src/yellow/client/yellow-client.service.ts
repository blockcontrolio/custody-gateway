import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import {
  createAppSessionMessage,
  createSubmitAppStateMessage,
  createCloseAppSessionMessage,
  createCreateChannelMessage,
  createResizeChannelMessage,
  createGetChannelsMessage,
  createGetLedgerBalancesMessage,
  createCloseChannelMessage,
  createECDSAMessageSigner,
  RPCAppStateIntent,
} from '@erc7824/nitrolite';
import type {
  MessageSigner,
  CreateAppSessionRequestParams,
  CloseAppSessionRequestParams,
  SubmitAppStateRequestParamsV04,
  SubmitAppStateRequestParamsV02,
} from '@erc7824/nitrolite';
import type { Address, Hex } from 'viem';
import { ClearNodeService } from '../../clear-node/clear-node.service.js';
import { YellowService } from '../handler/yellow.service.js';
import type { PersistSignedStateData } from '../yellow.types.js';
import { KeyProviderService } from '../providers/key-provider.service.js';
import { KeyProvider } from '../../key-provider/index.js';
import { RequestIdService } from '../providers/request-id.service.js';
import { RPC_TIMEOUT_MS } from '../yellow.constants.js';
import { toError } from '../yellow.utils.js';

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
      'isConfigured' | 'createSigner' | 'createSignerForAddress'
    >,
    private readonly requestIdService: RequestIdService,
    @Inject(KeyProvider)
    private readonly globalKeyProvider: KeyProvider,
  ) {}

  isConfigured(): boolean {
    if (!this.yellowService.isEnabled()) return false;
    return this.keyProvider.isConfigured();
  }

  private getSigner(address?: string): MessageSigner | null {
    if (address) {
      return this.keyProvider.createSignerForAddress(address as Address);
    }
    return this.keyProvider.createSigner();
  }

  /** Send signed RPC, wait for response or timeout. */
  private sendRequest<T>(
    requestId: number,
    buildMessage: (signer: MessageSigner) => Promise<string>,
    signerAddress?: string,
  ): Promise<T> {
    const signer = this.getSigner(signerAddress);
    if (!signer) {
      return Promise.reject(
        signerAddress
          ? new Error(`No managed key found for address ${signerAddress}`)
          : new Error('YELLOW_SIGNER_PRIVATE_KEY not set or invalid'),
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
    signerAddress?: string,
  ): Promise<T> {
    const requestId = this.requestIdService.nextId();
    this.logger.debug(`${methodName} requestId=${requestId}`);
    return this.sendRequest<T>(requestId, (s) => build(s, requestId), signerAddress);
  }

  async createAppSession(
    params: CreateAppSessionRequestParams,
  ): Promise<unknown> {
    const participants = (params.definition?.participants ?? []) as Hex[];
    return this.rpc('create_app_session', async (s, id) => {
      const msg = await createAppSessionMessage(s, params, id);
      if (participants.length > 1) {
        return this.addCoSignatures(msg, participants, 'create_app_session');
      }
      return msg;
    });
  }

  /**
   * Co-sign a message for all participants whose keys are in the KeyProvider.
   * ClearNode requires signatures from every participant in the session.
   */
  private async addCoSignatures(
    msg: string,
    participants: Hex[],
    methodName?: string,
  ): Promise<string> {
    const parsed = JSON.parse(msg) as { req: unknown; sig: Hex[] };
    if (!parsed.req || !Array.isArray(parsed.sig)) return msg;

    const sigs: Hex[] = [];
    for (const addr of participants) {
      const key = this.globalKeyProvider.getKey(addr);
      if (!key) continue;
      const signer = createECDSAMessageSigner(key);
      sigs.push(
        await signer(parsed.req as Parameters<MessageSigner>[0]),
      );
    }

    if (sigs.length > 1) {
      this.logger.debug(
        `Co-signed ${methodName ?? 'message'} for ${sigs.length}/${participants.length} participants`,
      );
      parsed.sig = sigs;
      return JSON.stringify(parsed);
    }
    return msg;
  }

  async submitAppState(params: {
    app_session_id: Hex;
    intent?: string;
    version?: number;
    allocations: Array<{ asset: string; amount: string; participant: Hex }>;
    session_data?: string;
  }): Promise<unknown> {
    const participants = [
      ...new Set(params.allocations.map((a) => a.participant)),
    ] as Hex[];
    return this.rpc('submit_app_state', async (s, id) => {
      let rpcParams: SubmitAppStateRequestParamsV04 | SubmitAppStateRequestParamsV02;

      if (params.intent && params.version != null) {
        // NitroRPC/0.4 — include intent and version
        rpcParams = {
          app_session_id: params.app_session_id,
          intent: params.intent as RPCAppStateIntent,
          version: params.version,
          allocations: params.allocations,
          session_data: params.session_data,
        } satisfies SubmitAppStateRequestParamsV04;
      } else {
        // NitroRPC/0.2 — omit intent and version
        rpcParams = {
          app_session_id: params.app_session_id,
          allocations: params.allocations,
          session_data: params.session_data,
        } satisfies SubmitAppStateRequestParamsV02;
      }

      const msg = await createSubmitAppStateMessage(
        s,
        rpcParams as Parameters<typeof createSubmitAppStateMessage>[1],
        id,
      );
      if (participants.length > 1) {
        return this.addCoSignatures(msg, participants, 'submit_app_state');
      }
      return msg;
    });
  }

  async closeAppSession(
    params: CloseAppSessionRequestParams,
  ): Promise<unknown> {
    const participants = [
      ...new Set(
        ((params as { allocations?: Array<{ participant: string }> }).allocations ?? []).map(
          (a) => a.participant,
        ),
      ),
    ] as Hex[];
    return this.rpc('close_app_session', async (s, id) => {
      const msg = await createCloseAppSessionMessage(s, params, id);
      if (participants.length > 1) {
        return this.addCoSignatures(msg, participants, 'close_app_session');
      }
      return msg;
    });
  }

  // ─── Channel RPC methods ────────────────────────────────────

  async createChannel(
    params: { chain_id: number; token: Address },
    signerAddress?: string,
  ): Promise<{ channel_id: string; channel: any; state: any; server_signature: string }> {
    return this.rpc('create_channel', (s, id) =>
      createCreateChannelMessage(s, params, id),
      signerAddress,
    );
  }

  async resizeChannel(
    params: { channel_id: Hex; resize_amount?: bigint; allocate_amount?: bigint; funds_destination: Address },
    signerAddress?: string,
  ): Promise<{ channel_id: string; state: any; server_signature: string }> {
    return this.rpc('resize_channel', (s, id) =>
      createResizeChannelMessage(s, params, id),
      signerAddress,
    );
  }

  async getChannels(
    participant: Address,
    signerAddress?: string,
  ): Promise<{ channels: any[] }> {
    return this.rpc('get_channels', (s, id) =>
      createGetChannelsMessage(s, participant, undefined, id),
      signerAddress,
    );
  }

  async getLedgerBalances(
    signerAddress?: string,
  ): Promise<{ ledger_balances: Array<{ asset: string; amount: string }> }> {
    return this.rpc('get_ledger_balances', (s, id) =>
      createGetLedgerBalancesMessage(s, undefined, id),
      signerAddress,
    );
  }

  async closeChannel(
    channelId: Hex,
    fundsDestination: Address,
    signerAddress?: string,
  ): Promise<{ state: any; server_signature: string }> {
    return this.rpc('close_channel', (s, id) =>
      createCloseChannelMessage(s, channelId, fundsDestination, id),
      signerAddress,
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
    const channelId = field<string>(r, 'channelId', 'channel_id');
    const signatures = r?.signatures ?? r?.sigs;
    if (!channelId || !Array.isArray(signatures) || signatures.length === 0) {
      return;
    }

    const intent = r?.intent;
    const data: PersistSignedStateData = {
      channelId,
      sessionId: field<string>(r, 'sessionId', 'app_session_id'),
      stateVersion:
        typeof r?.stateVersion === 'number' ? r.stateVersion : ((r?.version as number) ?? 0),
      intent:
        typeof intent === 'string' ? intent : typeof intent === 'number' ? String(intent) : 'OPERATE',
      stateData: r?.stateData ?? r?.state ?? {},
      allocations: r?.allocations ?? [],
      signatures,
      rawMessage:
        typeof r?.rawMessage === 'string' ? r.rawMessage : JSON.stringify(result),
    };
    void this.yellowService.persistSignedState(data);
  }
}

/**
 * Extract a string field from an RPC result, trying camelCase then snake_case key.
 * ClearNode responses are inconsistent in naming convention.
 */
function field<T = string>(
  obj: Record<string, unknown> | undefined,
  camelKey: string,
  snakeKey: string,
): T | undefined {
  const camel = obj?.[camelKey];
  if (camel != null && (typeof camel === 'string' || typeof camel === 'number')) {
    return camel as T;
  }
  const snake = obj?.[snakeKey];
  if (snake != null && (typeof snake === 'string' || typeof snake === 'number')) {
    return snake as T;
  }
  return undefined;
}
