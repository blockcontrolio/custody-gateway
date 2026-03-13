import { ApiProperty } from '@nestjs/swagger';

export class SubmitAppStateAllocationDto {
  @ApiProperty({ example: 'ytest.usd', description: 'Asset identifier (e.g. ytest.usd)' })
  asset: string;

  @ApiProperty({ example: '900000', description: 'New amount after state change (6 decimals)' })
  amount: string;

  @ApiProperty({
    example: '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2',
    description: 'Participant address (hex)',
  })
  participant: string;
}

/**
 * DTO for POST /yellow/sessions/:sessionId/state (submit_app_state).
 * Protocol 0.2 format.
 */
export class SubmitAppStateDto {
  @ApiProperty({
    type: [SubmitAppStateAllocationDto],
    example: [
      { asset: 'ytest.usd', amount: '900000', participant: '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2' },
      { asset: 'ytest.usd', amount: '1100000', participant: '0xF44020407a75d7B8525d7aEC114A16f7ebbfc9d6' },
    ],
    description: 'New state — total across all participants must equal the session total',
  })
  allocations: SubmitAppStateAllocationDto[];

  /** Auto-generated as timestamp on the backend. No need to provide. */
  session_data?: string;
}
