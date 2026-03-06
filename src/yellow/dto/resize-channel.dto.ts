import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for POST /yellow/channels/:channelId/resize (resize_channel).
 * Add or remove funds from an existing channel without closing it.
 */
export class ResizeChannelDto {
  @ApiPropertyOptional({
    example: '1000000',
    description: 'Amount to resize by (string, will be converted to bigint)',
  })
  resize_amount?: string;

  @ApiPropertyOptional({
    example: '500000',
    description: 'Amount to allocate (string, will be converted to bigint)',
  })
  allocate_amount?: string;

  @ApiProperty({
    example: '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2',
    description: 'Destination address for funds (hex)',
  })
  funds_destination: string;
}
