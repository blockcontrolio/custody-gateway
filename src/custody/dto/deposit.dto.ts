import { ApiProperty } from '@nestjs/swagger';

export class DepositDto {
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
    description: 'Amount in wei (0.01 ETH = 10000000000000000)',
  })
  amount: string;

  @ApiProperty({
    example: 'ethereum_sepolia',
    description: 'Chain name: ethereum_sepolia, base_sepolia, linea_sepolia, polygon_amoy',
  })
  chain: string;
}
