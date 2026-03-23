import { ApiProperty } from '@nestjs/swagger';

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

export class HealthResponseDto {
  @ApiProperty({ enum: ['ok', 'degraded', 'down'] })
  status: 'ok' | 'degraded' | 'down';

  @ApiProperty({ enum: ['connected', 'disconnected', 'reconnecting'] })
  websocket: string;

  @ApiProperty({ enum: ['authenticated', 'not_configured', 'failed'] })
  auth: string;

  @ApiProperty({ enum: ['connected', 'disconnected'] })
  database: string;

  @ApiProperty({ example: 3600000 })
  uptime: number;
}
