/** WebSocket connection state. */
export type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';

/** Yellow auth state. */
export type AuthState = 'authenticated' | 'not_configured' | 'failed';

/** Database connection state. */
export type DbState = 'connected' | 'disconnected';

/** Health check response payload. */
export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  websocket: ConnectionState;
  auth: AuthState;
  database: DbState;
  uptime: number;
}
