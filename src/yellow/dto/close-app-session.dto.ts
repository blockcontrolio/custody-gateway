import { ApiProperty } from '@nestjs/swagger';

export class CloseAppSessionAllocationDto {
  @ApiProperty({ example: 'ytest.usd', description: 'Asset identifier (e.g. ytest.usd)' })
  asset: string;

  @ApiProperty({ example: '1000000', description: 'Final amount for this participant (6 decimals)' })
  amount: string;

  @ApiProperty({
    example: '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2',
    description: 'Participant address (hex)',
  })
  participant: string;
}

/**
 * DTO for POST /yellow/sessions/:sessionId/close (close_app_session).
 */
export class CloseAppSessionDto {
  @ApiProperty({
    type: [CloseAppSessionAllocationDto],
    example: [
      { asset: 'ytest.usd', amount: '900000', participant: '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2' },
      { asset: 'ytest.usd', amount: '1100000', participant: '0xF44020407a75d7B8525d7aEC114A16f7ebbfc9d6' },
    ],
    description: 'Final distribution — total must equal session total. Funds return to each participant ledger.',
  })
  allocations: CloseAppSessionAllocationDto[];

  /** Auto-generated as timestamp on the backend. No need to provide. */
  session_data?: string;
}
