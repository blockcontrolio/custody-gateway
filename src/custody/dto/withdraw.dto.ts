import { ApiProperty } from '@nestjs/swagger';

export class WithdrawDto {
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
    description: 'Amount in wei',
  })
  amount: string;

  @ApiProperty({
    example: 'ethereum_sepolia',
    description: 'Chain name',
  })
  chain: string;
}
