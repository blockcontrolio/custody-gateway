import {Injectable, Logger, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {ConfigService} from '@nestjs/config'
import WebSocket, {MessageEvent} from 'ws';

type Json = Record<string, unknown>;

@Injectable()
export class ClearNodeService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ClearNodeService.name);
    private readonly url: string;
    private ws?: WebSocket;

    constructor(private readonly configService: ConfigService) {
        this.url = this.configService.getOrThrow<string>('CLEARNODE_URL');
        this.logger.log(`Using ClearNode URL: ${this.url}`);
    }

    onModuleInit() {
        this.connect();
    }

    onModuleDestroy() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close(1000, 'App shutting down');
        }
    }

    private connect() {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
            this.logger.log('WebSocket connection established');
            // Optionally: this.sendJson({ type: 'auth', token: '...' });
        };

        this.ws.onmessage = (event: MessageEvent) => {
            const text = event.data.toString();
            try {
                const msg = JSON.parse(text);
                this.logger.debug(`Received JSON: ${JSON.stringify(msg)}`);
                // TODO: handle msg
            } catch {
                this.logger.debug(`Received text: ${text}`);
                // TODO: handle plain text if needed
            }
        };

        this.ws.on('error', (err) => {
            this.logger.error(`WebSocket error: ${err.message}`);
        });

        this.ws.on('close', (code, reason) => {
            this.logger.warn(`WebSocket closed: ${code} ${reason.toString()}`);
        });
    }

    /** Send a JSON message if socket is open */
    sendJson(message: Json) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket is not open');
        }
        this.ws.send(JSON.stringify(message));
    }

    /** Optional: raw send */
    sendRaw(data: string | Buffer) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket is not open');
        }
        this.ws.send(data);
    }
}