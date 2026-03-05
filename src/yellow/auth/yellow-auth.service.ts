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
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, WalletClient } from 'viem';
import { ClearNodeService } from '../../clear-node/clear-node.service';
import { YellowService } from '../handler/yellow.service';
import { KeyProviderService } from '../providers/key-provider.service';
import { RequestIdService } from '../providers/request-id.service';
import { AUTH_TIMEOUT_MS } from '../yellow.constants';
import { errorMessage, toError } from '../yellow.utils';

@Injectable()
export class YellowAuthService {
  private readonly logger = new Logger(YellowAuthService.name);
  private sessionToken: string | null = null;

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

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  isConfigured(): boolean {
    return this.keyProvider.isConfigured();
  }

  /**
   * Run auth flow: auth_request -> auth_challenge -> auth_verify, then store JWT.
   * Call after WebSocket is connected. No-op if YELLOW_SIGNER_PRIVATE_KEY is not set.
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
      const account = privateKeyToAccount(privateKey);
      const address = account.address;
      const requestId = this.requestIdService.nextId();

      // expires_at must be Unix SECONDS (not milliseconds!)
      const expireSec = Number(
        this.configService.get<string>('YELLOW_AUTH_EXPIRE_SEC') || '86400',
      );
      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + expireSec);

      const authParams: AuthRequestParams = {
        address,
        session_key: address,
        application:
          this.configService.get<string>('YELLOW_AUTH_APP_NAME') ||
          'custody-gateway',
        allowances: [],
        expires_at: expiresAt,
        scope:
          this.configService.get<string>('YELLOW_AUTH_SCOPE') || 'console',
      };

      this.lastAuthParams = authParams;
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
    } catch (err) {
      this.logger.error(`Auth failed: ${errorMessage(err)}`);
    }
  }

  private pendingAuthResolve:
    | ((result: unknown, method?: string) => void)
    | null = null;

  /** Stored during startAuth for use in handleAuthChallenge EIP-712 signing. */
  private lastAuthParams: AuthRequestParams | null = null;

  private async handleAuthChallenge(
    result: { challenge_message?: string; challengeMessage?: string },
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
      const privateKey = this.keyProvider.getSignerKey()!;
      const account = privateKeyToAccount(privateKey);
      const params = this.lastAuthParams!;

      // Build EIP-712 signer (ClearNode requires EIP-712 typed data signatures for auth)
      const partialMessage: PartialEIP712AuthMessage = {
        scope: params.scope,
        session_key: params.session_key,
        expires_at: params.expires_at,
        allowances: params.allowances,
      };
      const domain: EIP712AuthDomain = { name: params.application };
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
            this.sessionToken = token;
            this.logger.log('Yellow auth success; JWT stored');
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
