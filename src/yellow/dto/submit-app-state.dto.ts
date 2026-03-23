import { ApiProperty } from '@nestjs/swagger';

export class SubmitAppStateAllocationDto {
  @ApiProperty({ example: 'usdc', description: 'Asset identifier (e.g. usdc)' })
  asset: string;

  @ApiProperty({ example: '2.200000', description: 'New amount after state change (decimal, 6 decimals)' })
  amount: string;

  @ApiProperty({
    example: '0x539d10F898e01470e400B87bbDe01e45955A9330',
    description: 'Participant address (hex)',
  })
  participant: string;
}

/**
 * DTO for POST /sessions/:sessionId/state (submit_app_state).
 *
 * Only `allocations` is required. The backend auto-manages
 * `intent` ("operate") and `version` (auto-incremented).
 */
export class SubmitAppStateDto {
  @ApiProperty({
    type: [SubmitAppStateAllocationDto],
    example: [
      { asset: 'usdc', amount: '2.200000', participant: '0x539d10F898e01470e400B87bbDe01e45955A9330' },
      { asset: 'usdc', amount: '1.800000', participant: '0xD988C8fA82Fa37Fa3daD336F169AAdadeFBE77e1' },
    ],
    description: 'FINAL allocations state (not delta). Sum must equal session total.',
  })
  allocations: SubmitAppStateAllocationDto[];
}
