import { ApiProperty } from '@nestjs/swagger';

export class WithdrawDto {
  @ApiProperty({
    example: 'A',
    description: 'Wallet identifier: "A" (primary) or "B" (secondary)',
  })
  wallet: string;

  @ApiProperty({
    example: '0x0000000000000000000000000000000000000000',
    description: 'Token address (zero-address for ETH)',
  })
  token: string;

  @ApiProperty({
    example: '10000000000000000',
    description: 'Amount in wei',
  })
  amount: string;

  @ApiProperty({
    example: 'ethereum_sepolia',
    description: 'Chain name',
  })
  chain: string;
}
