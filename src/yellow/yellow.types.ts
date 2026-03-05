/**
 * Parsed Nitro RPC message from ClearNode.
 * Supports response wrapper (res), request wrapper (req), and notifications.
 */
export type ParsedMessage =
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

/** Session status (matches prisma YellowSessionStatus). */
export type YellowSessionStatus = 'active' | 'closed';

/** Channel status (matches prisma ChannelStateStatus). */
export type ChannelStateStatus = 'active' | 'closed' | 'challenged';

/** Signed state intent (matches prisma SignedStateIntent). */
export type SignedStateIntent =
  | 'OPERATE'
  | 'INITIALIZE'
  | 'RESIZE'
  | 'FINALIZE';

/** Data for persistSignedState (dispute resolution). */
export interface PersistSignedStateData {
  channelId: string;
  sessionId?: string;
  stateVersion: number;
  intent: string;
  stateData: unknown;
  allocations: unknown;
  signatures: unknown;
  rawMessage: string;
}
