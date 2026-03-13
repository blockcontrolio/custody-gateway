import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TransferAllocationDto {
  @ApiProperty({ example: 'ytest.usd', description: 'Asset identifier (e.g. ytest.usd)' })
  asset: string;

  @ApiProperty({ example: '1000000', description: 'Amount to transfer (6 decimals, 1000000 = 1 USD)' })
  amount: string;
}

/**
 * DTO for POST /yellow/transfer.
 * destination OR destination_user_tag; allocations required.
 */
export class TransferDto {
  @ApiPropertyOptional({
    example: '0xF44020407a75d7B8525d7aEC114A16f7ebbfc9d6',
    description: 'Destination address (hex)',
  })
  destination?: string;

  @ApiPropertyOptional({ description: 'Alternative to destination' })
  destination_user_tag?: string;

  @ApiProperty({ type: [TransferAllocationDto] })
  allocations: TransferAllocationDto[];
}
