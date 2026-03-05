import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TransferAllocationDto {
  @ApiProperty({ example: '0x0000000000000000000000000000000000000000' })
  asset: string;

  @ApiProperty({ example: '100000' })
  amount: string;
}

/**
 * DTO for POST /yellow/transfer.
 * destination OR destination_user_tag; allocations required.
 */
export class TransferDto {
  @ApiPropertyOptional({
    example: '0xbbb...',
    description: 'Destination address (hex)',
  })
  destination?: string;

  @ApiPropertyOptional({ description: 'Alternative to destination' })
  destination_user_tag?: string;

  @ApiProperty({ type: [TransferAllocationDto] })
  allocations: TransferAllocationDto[];
}
