import {
  Injectable,
  Logger,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
} from '@erc7824/nitrolite';
import type {
  AuthChallengeResponse,
  AuthRequestParams,
  PartialEIP712AuthMessage,
  EIP712AuthDomain,
} from '@erc7824/nitrolite';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex, WalletClient } from 'viem';
import { ClearNodeService } from '../../clear-node/clear-node.service.js';
import { YellowService } from '../handler/yellow.service.js';
import { KeyProviderService } from '../providers/key-provider.service.js';
import { RequestIdService } from '../providers/request-id.service.js';
import { AUTH_TIMEOUT_MS } from '../yellow.constants.js';
import { errorMessage, toError } from '../yellow.utils.js';

@Injectable()
export class YellowAuthService {
  private readonly logger = new Logger(YellowAuthService.name);

  /** JWT tokens per wallet address (lowercase). */
  private readonly sessionTokens = new Map<string, string>();

  /** Private keys for authenticated wallets — needed to re-auth after reconnect. */
  private readonly authedKeys = new Map<string, Hex>();

  /** Serialize auth flows to avoid concurrent request-ID / callback conflicts. */
  private authQueue: Promise<void> = Promise.resolve();

  /** Single-slot callback used during an auth flow (serialized via authQueue). */
  private pendingAuthResolve:
    | ((result: unknown, method?: string) => void)
    | null = null;

  constructor(
    @Optional()
    @Inject(forwardRef(() => ClearNodeService))
    private readonly clearNodeService: ClearNodeService | null,
    @Inject(YellowService)
    private readonly yellowService: Pick<
      YellowService,
      'registerPendingResponse'
    >,
    @Inject(ConfigService)
    private readonly configService: Pick<ConfigService, 'get'>,
    private readonly requestIdService: RequestIdService,
    @Inject(KeyProviderService)
    private readonly keyProvider: Pick<
      KeyProviderService,
      'isConfigured' | 'getSignerKey'
    >,
  ) {}

  // ─── Public API ────────────────────────────────────────

  /** Get primary session token (backward-compat). */
  getSessionToken(): string | null {
    if (this.sessionTokens.size === 0) return null;
    return this.sessionTokens.values().next().value ?? null;
  }

  /** Get session token for a specific wallet. */
  getSessionTokenForAddress(address: string): string | null {
    return this.sessionTokens.get(address.toLowerCase()) ?? null;
  }

  /** Whether there is at least one authenticated wallet. */
  hasAnyAuth(): boolean {
    return this.sessionTokens.size > 0;
  }

  isConfigured(): boolean {
    return this.keyProvider.isConfigured();
  }

  /**
   * Called on WebSocket reconnect — clears cached tokens and re-auths
   * all previously authenticated wallets (ClearNode loses auth on disconnect).
   */
  async onReconnect(): Promise<void> {
    const keysToReauth = [...this.authedKeys.values()];
    this.sessionTokens.clear();
    this.logger.log(`WebSocket reconnected, re-authenticating ${keysToReauth.length} wallet(s)...`);
    for (const key of keysToReauth) {
      try {
        await this.authWallet(key);
      } catch (err) {
        this.logger.error(`Re-auth failed: ${errorMessage(err)}`);
      }
    }
  }

  /**
   * Auth the default signer (YELLOW_SIGNER_PRIVATE_KEY).
   * Called automatically after WebSocket connects.
   */
  async startAuth(): Promise<void> {
    if (!this.isConfigured()) {
      this.logger.debug(
        'YELLOW_SIGNER_PRIVATE_KEY not set or invalid; skipping auth',
      );
      return;
    }
    if (!this.clearNodeService) {
      this.logger.warn('ClearNodeService not available; skipping auth');
      return;
    }
    const privateKey = this.keyProvider.getSignerKey()!;
    try {
      await this.authWallet(privateKey);
    } catch (err) {
      this.logger.error(`Auth failed: ${errorMessage(err)}`);
    }
  }

  /**
   * Authenticate any wallet by its private key.
   * Safe to call multiple times — skips if already authenticated.
   * Queued internally so concurrent calls don't collide.
   */
  async authWallet(privateKey: Hex): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.authQueue = this.authQueue
        .then(() => this.runAuthFlow(privateKey))
        .then(resolve)
        .catch(reject);
    });
  }

  // ─── Internal ──────────────────────────────────────────

  private async runAuthFlow(privateKey: Hex): Promise<void> {
    if (!this.clearNodeService) {
      throw new Error('ClearNodeService not available');
    }

    const account = privateKeyToAccount(privateKey);
    const address = account.address;

    // Already authed — skip
    if (this.sessionTokens.has(address.toLowerCase())) {
      this.logger.debug(`Wallet ${address} already authenticated`);
      return;
    }

    const requestId = this.requestIdService.nextId();
    const expireSec = Number(
      this.configService.get<string>('YELLOW_AUTH_EXPIRE_SEC') || '86400',
    );
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + expireSec);

    // Fresh session key each time (avoids "session key already exists")
    const sessionKeyPrivate = generatePrivateKey();
    const sessionKeyAddress = privateKeyToAccount(sessionKeyPrivate).address;

    const authParams: AuthRequestParams = {
      address,
      session_key: sessionKeyAddress,
      application: 'clearnode', // root access — bypasses allowance checks
      allowances: [],
      expires_at: expiresAt,
      scope:
        this.configService.get<string>('YELLOW_AUTH_SCOPE') || 'console',
    };

    const authRequestStr = await createAuthRequestMessage(
      authParams,
      requestId,
      Date.now(),
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingAuthResolve) {
          this.pendingAuthResolve = null;
          reject(new Error('Auth request timeout'));
        }
      }, AUTH_TIMEOUT_MS);

      this.pendingAuthResolve = (result: unknown, method?: string) => {
        clearTimeout(timeout);
        this.pendingAuthResolve = null;
        if (method === 'error') {
          reject(new Error(String(result)));
          return;
        }
        if (method === 'auth_challenge') {
          void this.handleAuthChallenge(
            result as {
              challenge_message?: string;
              challengeMessage?: string;
            },
            privateKey,
            authParams,
            resolve,
            reject,
          );
          return;
        }
        reject(new Error(`Unexpected auth response method: ${method}`));
      };

      this.yellowService.registerPendingResponse(
        requestId,
        this.pendingAuthResolve,
      );
      this.clearNodeService!.sendRaw(authRequestStr);
    });
  }

  private async handleAuthChallenge(
    result: { challenge_message?: string; challengeMessage?: string },
    privateKey: Hex,
    authParams: AuthRequestParams,
    resolve: () => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    const challengeMessage =
      result.challengeMessage ?? result.challenge_message;
    if (!challengeMessage) {
      reject(new Error('Missing challengeMessage in auth_challenge'));
      return;
    }

    try {
      const account = privateKeyToAccount(privateKey);

      // Build EIP-712 signer
      const partialMessage: PartialEIP712AuthMessage = {
        scope: authParams.scope,
        session_key: authParams.session_key,
        expires_at: authParams.expires_at,
        allowances: authParams.allowances,
      };
      const domain: EIP712AuthDomain = { name: authParams.application };
      const walletLikeClient = {
        account,
        signTypedData: (args: Parameters<typeof account.signTypedData>[0]) =>
          account.signTypedData(args),
      } as unknown as WalletClient;
      const eip712Signer = createEIP712AuthMessageSigner(
        walletLikeClient,
        partialMessage,
        domain,
      );

      const challengeResponse: AuthChallengeResponse = {
        method: 'auth_challenge' as AuthChallengeResponse['method'],
        params: { challengeMessage },
      };
      const authVerifyStr = await createAuthVerifyMessage(
        eip712Signer,
        challengeResponse,
        this.requestIdService.nextId(),
        Date.now(),
      );
      const parsed = JSON.parse(authVerifyStr) as {
        req: [number, string, unknown, number];
      };
      const verifyRequestId = parsed.req[0];

      this.yellowService.registerPendingResponse(
        verifyRequestId,
        (verifyResult: unknown, method?: string) => {
          if (method === 'error') {
            reject(new Error(String(verifyResult)));
            return;
          }
          const res = verifyResult as
            | {
                jwtToken?: string;
                jwt_token?: string;
              }
            | undefined;
          const token = res?.jwtToken ?? res?.jwt_token;
          if (token) {
            this.sessionTokens.set(account.address.toLowerCase(), token);
            this.authedKeys.set(account.address.toLowerCase(), privateKey);
            this.logger.log(
              `Yellow auth success for ${account.address}; JWT stored`,
            );
            resolve();
          } else {
            reject(new Error('Auth verify response missing jwtToken'));
          }
        },
      );
      this.clearNodeService!.sendRaw(authVerifyStr);
    } catch (err) {
      reject(toError(err));
    }
  }
}
