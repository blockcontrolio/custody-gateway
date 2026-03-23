import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket, { MessageEvent } from 'ws';
import { YellowAuthService } from '../yellow/auth/yellow-auth.service.js';
import { YellowService } from '../yellow/handler/yellow.service.js';
import { YellowParserService } from '../yellow/parser/yellow-parser.service.js';
import { DEFAULT_MAX_RECONNECT_DELAY_MS } from './clear-node.constants.js';
import { errorMessage } from '../yellow/yellow.utils.js';

type Json = Record<string, unknown>;

/** Safely convert WebSocket message data (string | Buffer | ArrayBuffer | Buffer[]) to string. */
function messageDataToText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (
    Array.isArray(data) &&
    data.every((chunk): chunk is Buffer => Buffer.isBuffer(chunk))
  ) {
    return Buffer.concat(data).toString('utf8');
  }
  return typeof data === 'object' && data !== null
    ? JSON.stringify(data)
    : String(data);
}

@Injectable()
export class ClearNodeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClearNodeService.name);
  private readonly url: string;
  private ws?: WebSocket;

  // Reconnect state
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private shuttingDown = false;

  // Connection state for health checks
  private connectionState: 'connected' | 'disconnected' | 'reconnecting' =
    'disconnected';

  constructor(
    @Inject(ConfigService)
    private readonly configService: Pick<ConfigService, 'get' | 'getOrThrow'>,
    @Inject(YellowParserService)
    private readonly yellowParserService: Pick<
      YellowParserService,
      'parse' | 'parseAndVerify'
    >,
    @Inject(YellowService)
    private readonly yellowService: Pick<
      YellowService,
      'isEnabled' | 'handleMessage'
    >,
    @Inject(forwardRef(() => YellowAuthService))
    private readonly yellowAuthService: Pick<
      YellowAuthService,
      'isConfigured' | 'startAuth' | 'onReconnect'
    >,
  ) {
    this.url = this.configService.getOrThrow<string>('CLEARNODE_URL');
    this.logger.log(`Using ClearNode URL: ${this.url}`);
  }

  onModuleInit() {
    this.connect();
  }

  onModuleDestroy() {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'App shutting down');
    }
    this.connectionState = 'disconnected';
  }

  getConnectionState(): 'connected' | 'disconnected' | 'reconnecting' {
    return this.connectionState;
  }

  private connect() {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      const isReconnect = this.reconnectAttempt > 0;
      this.logger.log('WebSocket connection established');
      this.reconnectAttempt = 0;
      this.connectionState = 'connected';
      if (
        this.yellowService.isEnabled() &&
        this.yellowAuthService.isConfigured()
      ) {
        const authPromise = isReconnect
          ? this.yellowAuthService.onReconnect()
          : this.yellowAuthService.startAuth();
        authPromise.catch((err) => {
          this.logger.warn(
            `Yellow auth on connect failed: ${errorMessage(err)}`,
          );
        });
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      const text = messageDataToText(event.data);
      try {
        if (this.yellowService.isEnabled()) {
          const signerAddress = this.configService.get<string>(
            'CLEARNODE_SIGNER_ADDRESS',
          );
          if (signerAddress) {
            // Async verification path
            void this.yellowParserService
              .parseAndVerify(text, signerAddress)
              .then((parsed) => {
                if (parsed) {
                  this.yellowService.handleMessage(parsed);
                } else {
                  this.logger.debug(
                    `Received (unparsed): ${text.slice(0, 200)}`,
                  );
                }
              })
              .catch((err) => {
                this.logger.warn(
                  `Message verification error: ${errorMessage(err)}`,
                );
              });
          } else {
            const parsed = this.yellowParserService.parse(text);
            if (parsed) {
              this.yellowService.handleMessage(parsed);
            } else {
              this.logger.debug(`Received (unparsed): ${text.slice(0, 200)}`);
            }
          }
        } else {
          const msg: unknown = JSON.parse(text);
          this.logger.debug(`Received JSON: ${JSON.stringify(msg)}`);
        }
      } catch (err) {
        this.logger.warn(`Message handling error: ${errorMessage(err)}`);
        this.logger.debug(`Raw message: ${text.slice(0, 300)}`);
      }
    };

    this.ws.on('error', (err) => {
      this.logger.error(`WebSocket error: ${err.message}`);
    });

    this.ws.on('close', (code, reason) => {
      this.logger.warn(
        `WebSocket closed: ${code} ${messageDataToText(reason)}`,
      );
      this.connectionState = 'disconnected';
      if (!this.shuttingDown) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    const maxDelay = Number(
      this.configService.get<string>('WS_RECONNECT_MAX_DELAY_MS') ||
        DEFAULT_MAX_RECONNECT_DELAY_MS,
    );
    const delay =
      Math.min(1000 * 2 ** this.reconnectAttempt, maxDelay) +
      Math.random() * 1000;
    this.connectionState = 'reconnecting';
    this.logger.log(
      `Scheduling reconnect attempt ${this.reconnectAttempt + 1} in ${Math.round(delay)}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempt++;
      this.connect();
    }, delay);
  }

  private ensureOpen(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
  }

  sendJson(message: Json): void {
    this.ensureOpen();
    this.ws!.send(JSON.stringify(message));
  }

  sendRaw(data: string | Buffer): void {
    this.ensureOpen();
    this.ws!.send(data);
  }
}
