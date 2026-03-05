import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for POST /yellow/sessions (create_app_session).
 * definition + allocations match Nitro RPC CreateAppSessionRequest params.
 */
export class CreateAppSessionDefinitionDto {
  @ApiProperty({ example: 'NitroRPC/0.2', description: 'Protocol version' })
  protocol: string;

  @ApiProperty({
    example: ['0xaaa...', '0xbbb...'],
    description: 'Participant addresses (hex)',
  })
  participants: string[];

  @ApiProperty({ example: [1, 1] })
  weights: number[];

  @ApiProperty({ example: 2 })
  quorum: number;

  @ApiProperty({ example: 86400 })
  challenge: number;

  @ApiPropertyOptional()
  nonce?: number;
}

export class CreateAppSessionAllocationDto {
  @ApiProperty({ example: '0x0000000000000000000000000000000000000000' })
  asset: string;

  @ApiProperty({ example: '1000000' })
  amount: string;

  @ApiProperty({
    example: '0xaaa...',
    description: 'Participant address (hex)',
  })
  participant: string;
}

export class CreateAppSessionDto {
  @ApiProperty({ type: CreateAppSessionDefinitionDto })
  definition: CreateAppSessionDefinitionDto;

  @ApiProperty({ type: [CreateAppSessionAllocationDto] })
  allocations: CreateAppSessionAllocationDto[];

  @ApiPropertyOptional()
  session_data?: string;
}
