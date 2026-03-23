import { ApiProperty } from '@nestjs/swagger';

export class DepositDto {
  @ApiProperty({
    example: '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2',
    description: 'Ethereum address of the managed wallet',
  })
  address: string;

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
    example: 'ethereum',
    description: 'Chain name: ethereum, bsc, polygon, base, linea (mainnet) or ethereum_sepolia, base_sepolia, etc. (testnet)',
  })
  chain: string;
}
