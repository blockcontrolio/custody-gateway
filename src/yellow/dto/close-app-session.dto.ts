import { ApiProperty } from '@nestjs/swagger';

export class CloseAppSessionAllocationDto {
  @ApiProperty({ example: 'usdc', description: 'Asset identifier (e.g. usdc)' })
  asset: string;

  @ApiProperty({
    example: '2.300000',
    description: 'Final amount for this participant (decimal, 6 decimals)',
  })
  amount: string;

  @ApiProperty({
    example: '0x539d10F898e01470e400B87bbDe01e45955A9330',
    description: 'Participant address (hex)',
  })
  participant: string;
}

/**
 * DTO for POST /sessions/:sessionId/close (close_app_session).
 */
export class CloseAppSessionDto {
  @ApiProperty({
    type: [CloseAppSessionAllocationDto],
    example: [
      {
        asset: 'usdc',
        amount: '2.300000',
        participant: '0x539d10F898e01470e400B87bbDe01e45955A9330',
      },
      {
        asset: 'usdc',
        amount: '1.700000',
        participant: '0xD988C8fA82Fa37Fa3daD336F169AAdadeFBE77e1',
      },
    ],
    description:
      'Final distribution — total must equal session total. Funds return to each participant wallet.',
  })
  allocations: CloseAppSessionAllocationDto[];

  /** Auto-generated as timestamp on the backend. No need to provide. */
  session_data?: string;
}
