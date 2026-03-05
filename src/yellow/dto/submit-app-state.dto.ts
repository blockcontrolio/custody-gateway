import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitAppStateAllocationDto {
  @ApiProperty()
  asset: string;

  @ApiProperty()
  amount: string;

  @ApiProperty({ description: 'Participant address (hex)' })
  participant: string;
}

/**
 * DTO for POST /yellow/sessions/:sessionId/state (submit_app_state).
 * Protocol 0.2 format.
 */
export class SubmitAppStateDto {
  @ApiProperty({ type: [SubmitAppStateAllocationDto] })
  allocations: SubmitAppStateAllocationDto[];

  @ApiPropertyOptional()
  session_data?: string;
}
