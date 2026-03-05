import { ApiProperty } from '@nestjs/swagger';

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
