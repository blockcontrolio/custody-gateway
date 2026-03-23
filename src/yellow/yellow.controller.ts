import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { SessionService } from './session.service.js';
import type { StoredSession } from './handler/yellow.service.js';
import {
  SubmitAppStateDto,
  CloseAppSessionDto,
  CreateInvitationDto,
} from './dto/index.js';

@ApiTags('Sessions')
@Controller('sessions')
export class YellowController {
  constructor(private readonly sessionService: SessionService) {}

  // ─── Invitations ───────────────────────────────────────

  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Invite another user to a session' })
  @ApiBody({ type: CreateInvitationDto })
  @ApiCreatedResponse({ description: 'Invitation created' })
  async invite(@Body() body: CreateInvitationDto) {
    return this.sessionService.createInvitation(body);
  }

  @Get('invitations')
  @ApiOperation({ summary: 'List pending invitations for a user' })
  @ApiQuery({ name: 'userId', required: true })
  @ApiQuery({ name: 'role', required: false, enum: ['invitee', 'initiator'] })
  @ApiOkResponse({ description: 'Pending invitations' })
  async listInvitations(@Query('userId') userId?: string, @Query('role') role?: string) {
    if (!userId) throw new BadRequestException('userId is required');
    return this.sessionService.listInvitations(userId, role);
  }

  @Post('invitations/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept invitation (auto-prepares wallets + creates session)' })
  @ApiParam({ name: 'id', description: 'Invitation ID' })
  @ApiOkResponse({ description: 'Session created' })
  async accept(@Param('id') id: string) {
    return this.sessionService.acceptInvitation(id);
  }

  @Post('invitations/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject invitation' })
  @ApiParam({ name: 'id' })
  async reject(@Param('id') id: string) {
    return this.sessionService.rejectInvitation(id);
  }

  // ─── Faucet (sandbox) ────────────────────────────────

  @Post('faucet')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request test tokens and withdraw on-chain (sandbox only, needs Sepolia ETH for gas)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['userId'],
      properties: { userId: { type: 'string', format: 'uuid' } },
    },
  })
  @ApiOkResponse({ description: 'Tokens withdrawn on-chain' })
  async faucet(@Body() body: { userId: string }) {
    if (!body.userId) throw new BadRequestException('userId is required');
    return this.sessionService.faucet(body.userId);
  }

  // ─── Sessions ──────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List all sessions' })
  async list(): Promise<StoredSession[]> {
    return this.sessionService.listSessions();
  }

  @Get(':sessionId')
  @ApiOperation({ summary: 'Get session by ID (with current state)' })
  @ApiParam({ name: 'sessionId' })
  async get(@Param('sessionId') sessionId: string): Promise<StoredSession | null> {
    return this.sessionService.getSession(sessionId);
  }

  @Post(':sessionId/state')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update session state (change allocations)' })
  @ApiParam({ name: 'sessionId' })
  @ApiBody({ type: SubmitAppStateDto })
  @ApiOkResponse({ description: 'Updated state' })
  async updateState(@Param('sessionId') sessionId: string, @Body() body: SubmitAppStateDto) {
    if (!body.allocations?.length) {
      throw new BadRequestException('allocations are required');
    }
    return this.sessionService.updateState(sessionId, body.allocations);
  }

  @Post(':sessionId/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close session' })
  @ApiParam({ name: 'sessionId' })
  @ApiBody({ type: CloseAppSessionDto })
  @ApiOkResponse({ description: 'Session closed' })
  async close(@Param('sessionId') sessionId: string, @Body() body: CloseAppSessionDto) {
    if (!body.allocations?.length) {
      throw new BadRequestException('allocations are required');
    }
    return this.sessionService.closeSession(sessionId, body.allocations);
  }
}
