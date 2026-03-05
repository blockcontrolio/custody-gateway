import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Session (for list/get session endpoints). */
export class StoredSessionDto {
  @ApiProperty()
  sessionId: string;

  @ApiProperty({ example: 1700000000000 })
  createdAt: number;

  @ApiPropertyOptional()
  partnerId?: string;

  @ApiPropertyOptional()
  userId?: string;
}
