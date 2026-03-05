import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CloseAppSessionAllocationDto {
  @ApiProperty()
  asset: string;

  @ApiProperty()
  amount: string;

  @ApiProperty({ description: 'Participant address (hex)' })
  participant: string;
}

/**
 * DTO for POST /yellow/sessions/:sessionId/close (close_app_session).
 */
export class CloseAppSessionDto {
  @ApiProperty({ type: [CloseAppSessionAllocationDto] })
  allocations: CloseAppSessionAllocationDto[];

  @ApiPropertyOptional()
  session_data?: string;
}
