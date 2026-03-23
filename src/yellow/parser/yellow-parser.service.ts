import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { recoverMessageAddress } from 'viem';
import type { Hex } from 'viem';
import { DEFAULT_MAX_DRIFT_MS } from '../yellow.constants.js';
import { ParsedMessage } from '../yellow.types.js';

/**
 * Parses raw WebSocket messages from ClearNode (Nitro RPC format).
 * Format: { "req": [requestId, method, params, timestamp], "sig": [...] }
 *         { "res": [requestId, method, result, timestamp], "sig": [...] }
 * Notifications: bu, cu, tr, asu (pushed by ClearNode).
 */
@Injectable()
export class YellowParserService {
  private readonly logger = new Logger(YellowParserService.name);

  constructor(
    @Inject(ConfigService)
    private readonly configService: Pick<ConfigService, 'get'>,
  ) {}

  parse(raw: string): ParsedMessage | null {
    if (!raw?.trim()) {
      return null;
    }
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;

      // Response: { "res": [requestId, method, result, timestamp], "sig": [...] }
      if (Array.isArray(data.res)) {
        const [requestId, method, result, timestamp] = data.res as [
          number,
          string,
          unknown,
          number?,
        ];
        this.warnIfTimestampDrifted(timestamp);
        if (
          method === 'error' &&
          result &&
          typeof result === 'object' &&
          'error' in result
        ) {
          return {
            kind: 'error',
            requestId,
            error: String((result as { error: string }).error),
            timestamp,
          };
        }
        return {
          kind: 'response',
          requestId,
          method,
          result,
          timestamp,
        };
      }

      // Request: { "req": [requestId, method, params, timestamp], "sig": [...] }
      if (Array.isArray(data.req)) {
        const [requestId, method, params, timestamp] = data.req as [
          number,
          string,
          unknown,
          number?,
        ];
        this.warnIfTimestampDrifted(timestamp);
        return {
          kind: 'request',
          requestId,
          method,
          params,
          timestamp,
        };
      }

      // Notifications or app-level messages (e.g. session_created, payment, bu, cu, tr, asu)
      if (typeof data.type === 'string') {
        return {
          kind: 'notification',
          type: data.type,
          payload: data,
        };
      }

      // Fallback: treat as unknown for debugging
      return { kind: 'unknown', raw: data };
    } catch {
      this.logger.debug(
        `Failed to parse message as JSON: ${raw.slice(0, 200)}`,
      );
      return null;
    }
  }

  /**
   * Parse and optionally verify the ECDSA signature on the message.
   * If expectedAddress is provided and signature is invalid, returns kind='unknown'.
   */
  async parseAndVerify(
    raw: string,
    expectedAddress?: string,
  ): Promise<ParsedMessage | null> {
    const parsed = this.parse(raw);
    if (!parsed || !expectedAddress) {
      return parsed;
    }

    // Only verify signed messages (req/res have sig field)
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      const sig = data.sig as string[] | undefined;
      if (!sig || !Array.isArray(sig) || sig.length === 0) {
        return parsed; // No signature to verify
      }

      // The signed payload is the req or res array as JSON
      const payload = data.req ?? data.res;
      if (!payload) {
        return parsed;
      }

      const message = JSON.stringify(payload);
      const signature = sig[0] as Hex;

      const recoveredAddress = await recoverMessageAddress({
        message,
        signature,
      });

      if (recoveredAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
        this.logger.warn(
          `Signature verification failed: expected=${expectedAddress}, recovered=${recoveredAddress}`,
        );
        return { kind: 'unknown', raw: data };
      }
    } catch (err) {
      this.logger.warn(
        `Signature verification error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { kind: 'unknown', raw };
    }

    return parsed;
  }

  private warnIfTimestampDrifted(timestamp?: number): void {
    if (timestamp == null) return;
    const maxDrift = Number(
      this.configService.get<string>('TIMESTAMP_MAX_DRIFT_MS') ||
        DEFAULT_MAX_DRIFT_MS,
    );
    const drift = Math.abs(timestamp - Date.now());
    if (drift > maxDrift) {
      this.logger.warn(
        `Timestamp drift detected: ${drift}ms (max ${maxDrift}ms)`,
      );
    }
  }
}
