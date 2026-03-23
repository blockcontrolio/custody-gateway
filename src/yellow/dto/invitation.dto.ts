import { ApiProperty } from '@nestjs/swagger';

export class CreateInvitationDto {
  @ApiProperty({ example: 'usdc', description: 'Asset/token identifier' })
  token: string;

  @ApiProperty({ description: 'Initiator user ID' })
  initiatorUserId: string;

  @ApiProperty({ description: 'Invitee user ID' })
  inviteeUserId: string;

  @ApiProperty({
    example: '2000000',
    description: 'Amount initiator puts into session (base units)',
  })
  amountInitiator: string;

  @ApiProperty({ example: '2000000', description: 'Amount invitee puts into session (base units)' })
  amountInvitee: string;
}
