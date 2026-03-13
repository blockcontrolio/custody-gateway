import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for POST /yellow/sessions (create_app_session).
 * definition + allocations match Nitro RPC CreateAppSessionRequest params.
 */
export class CreateAppSessionDefinitionDto {
  @ApiProperty({ example: 'NitroRPC/0.2', description: 'Protocol version' })
  protocol: string;

  @ApiProperty({
    example: [
      '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2',
      '0xF44020407a75d7B8525d7aEC114A16f7ebbfc9d6',
    ],
    description: 'Participant addresses (hex)',
  })
  participants: string[];

  @ApiProperty({ example: [1, 1] })
  weights: number[];

  @ApiProperty({ example: 2 })
  quorum: number;

  @ApiProperty({ example: 86400 })
  challenge: number;

  @ApiPropertyOptional({ description: 'Auto-generated if omitted or zero' })
  nonce?: number;

  @ApiProperty({ example: 'custody-gateway' })
  application: string;
}

export class CreateAppSessionAllocationDto {
  @ApiProperty({ example: 'ytest.usd', description: 'Asset identifier (e.g. ytest.usd)' })
  asset: string;

  @ApiProperty({ example: '1000000', description: 'Amount in smallest unit (6 decimals, 1000000 = 1 USD)' })
  amount: string;

  @ApiProperty({
    example: '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2',
    description: 'Participant address (hex)',
  })
  participant: string;
}

export class CreateAppSessionDto {
  @ApiProperty({ type: CreateAppSessionDefinitionDto })
  definition: CreateAppSessionDefinitionDto;

  @ApiProperty({
    type: [CreateAppSessionAllocationDto],
    example: [
      { asset: 'ytest.usd', amount: '1000000', participant: '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2' },
      { asset: 'ytest.usd', amount: '1000000', participant: '0xF44020407a75d7B8525d7aEC114A16f7ebbfc9d6' },
    ],
    description: 'Initial allocations — each participant deposits their amount into the session',
  })
  allocations: CreateAppSessionAllocationDto[];

  /** Auto-generated as timestamp on the backend. No need to provide. */
  session_data?: string;
}
