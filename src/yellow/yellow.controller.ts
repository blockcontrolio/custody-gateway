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
  ServiceUnavailableException,
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
import { YellowClientService } from './client/yellow-client.service';
import { YellowService } from './handler/yellow.service';
import { YellowAuthService } from './auth/yellow-auth.service';
import type { StoredSession } from './handler/yellow.service';
import {
  CreateAppSessionDto,
  SubmitAppStateDto,
  CloseAppSessionDto,
  ResizeChannelDto,
  TransferDto,
  StoredSessionDto,
} from './dto';
import type { Hex } from 'viem';
import { RPCChannelStatus } from '@erc7824/nitrolite';

const YELLOW_PREFIX = 'yellow';

@ApiTags('Yellow')
@Controller(YELLOW_PREFIX)
export class YellowController {
  constructor(
    private readonly yellowClient: YellowClientService,
    private readonly yellowService: YellowService,
    private readonly yellowAuth: YellowAuthService,
  ) {}

  private ensureYellowReady(): void {
    if (!this.yellowService.isEnabled()) {
      throw new ServiceUnavailableException(
        'Yellow partner is disabled (YELLOW_PARTNER_ENABLED)',
      );
    }
    if (!this.yellowClient.isConfigured()) {
      throw new ServiceUnavailableException(
        'Yellow signer not configured (YELLOW_SIGNER_PRIVATE_KEY required for outgoing RPC)',
      );
    }
  }

  /** Status: is Yellow enabled, configured, and whether we have a session token. */
  @Get('status')
  @ApiOperation({
    summary: 'Yellow status (enabled, configured, hasSessionToken)',
  })
  @ApiOkResponse({ description: 'Status flags' })
  getStatus(): {
    enabled: boolean;
    configured: boolean;
    hasSessionToken: boolean;
  } {
    return {
      enabled: this.yellowService.isEnabled(),
      configured: this.yellowClient.isConfigured(),
      hasSessionToken: !!this.yellowAuth.getSessionToken(),
    };
  }

  /** List all known app sessions (active, from DB or cache). */
  @Get('sessions')
  @ApiOperation({ summary: 'List all app sessions' })
  @ApiOkResponse({ description: 'List of sessions', type: [StoredSessionDto] })
  async listSessions(): Promise<StoredSession[]> {
    if (!this.yellowService.isEnabled()) return [];
    return this.yellowService.getAllSessions();
  }

  /** Get one session by id. */
  @Get('sessions/:sessionId')
  @ApiOperation({ summary: 'Get session by id' })
  @ApiParam({ name: 'sessionId' })
  @ApiOkResponse({ description: 'Session or null', type: StoredSessionDto })
  async getSession(
    @Param('sessionId') sessionId: string,
  ): Promise<StoredSession | null> {
    if (!this.yellowService.isEnabled()) return null;
    const session = await this.yellowService.getSession(sessionId);
    return session ?? null;
  }

  /** Create app session (create_app_session). */
  @Post('sessions')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create app session (create_app_session)' })
  @ApiBody({ type: CreateAppSessionDto })
  @ApiCreatedResponse({
    description: 'RPC result (sessionId / app_session_id)',
  })
  async createAppSession(@Body() body: CreateAppSessionDto): Promise<unknown> {
    this.ensureYellowReady();
    if (!body.definition || !Array.isArray(body.allocations)) {
      throw new BadRequestException(
        'Body must include definition and allocations',
      );
    }
    return this.yellowClient.createAppSession(
      body as Parameters<YellowClientService['createAppSession']>[0],
    );
  }

  /** Submit app state (submit_app_state, protocol 0.2). */
  @Post('sessions/:sessionId/state')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit app state (submit_app_state)' })
  @ApiParam({ name: 'sessionId' })
  @ApiBody({ type: SubmitAppStateDto })
  @ApiOkResponse({ description: 'RPC result' })
  async submitAppState(
    @Param('sessionId') sessionId: string,
    @Body() body: SubmitAppStateDto,
  ): Promise<unknown> {
    this.ensureYellowReady();
    if (!body.allocations || !Array.isArray(body.allocations)) {
      throw new BadRequestException('Body must include allocations');
    }
    return this.yellowClient.submitAppState({
      app_session_id: sessionId as Hex,
      allocations: body.allocations as Parameters<
        YellowClientService['submitAppState']
      >[0]['allocations'],
      session_data: body.session_data,
    });
  }

  /** Close app session (close_app_session). */
  @Post('sessions/:sessionId/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close app session (close_app_session)' })
  @ApiParam({ name: 'sessionId' })
  @ApiBody({ type: CloseAppSessionDto })
  @ApiOkResponse({ description: 'RPC result' })
  async closeAppSession(
    @Param('sessionId') sessionId: string,
    @Body() body: CloseAppSessionDto,
  ): Promise<unknown> {
    this.ensureYellowReady();
    if (!body.allocations || !Array.isArray(body.allocations)) {
      throw new BadRequestException('Body must include allocations');
    }
    return this.yellowClient.closeAppSession({
      app_session_id: sessionId as Hex,
      allocations: body.allocations as Parameters<
        YellowClientService['closeAppSession']
      >[0]['allocations'],
      session_data: body.session_data,
    });
  }

  /** Get channels (get_channels). Optional query: participant, status (open | closed | challenged). */
  @Get('channels')
  @ApiOperation({ summary: 'Get channels (get_channels)' })
  @ApiQuery({ name: 'participant', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['open', 'closed', 'challenged'],
  })
  @ApiOkResponse({ description: 'RPC result (channels)' })
  async getChannels(
    @Query('participant') participant?: string,
    @Query('status') status?: string,
  ): Promise<unknown> {
    this.ensureYellowReady();
    const statusEnum =
      status === 'open'
        ? RPCChannelStatus.Open
        : status === 'closed'
          ? RPCChannelStatus.Closed
          : status === 'challenged'
            ? RPCChannelStatus.Challenged
            : undefined;
    return this.yellowClient.getChannels(
      participant as Hex | undefined,
      statusEnum,
    );
  }

  /** Resize channel — add or remove funds without closing. */
  @Post('channels/:channelId/resize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resize channel (resize_channel)' })
  @ApiParam({ name: 'channelId', description: 'Channel ID (hex)' })
  @ApiBody({ type: ResizeChannelDto })
  @ApiOkResponse({ description: 'RPC result' })
  async resizeChannel(
    @Param('channelId') channelId: string,
    @Body() body: ResizeChannelDto,
  ): Promise<unknown> {
    this.ensureYellowReady();
    if (!body.funds_destination) {
      throw new BadRequestException('funds_destination is required');
    }
    return this.yellowClient.resizeChannel({
      channel_id: channelId as Hex,
      ...(body.resize_amount != null && {
        resize_amount: BigInt(body.resize_amount),
      }),
      ...(body.allocate_amount != null && {
        allocate_amount: BigInt(body.allocate_amount),
      }),
      funds_destination: body.funds_destination as Hex,
    });
  }

  /** Transfer (transfer). */
  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transfer (transfer)' })
  @ApiBody({ type: TransferDto })
  @ApiOkResponse({ description: 'RPC result' })
  async transfer(@Body() body: TransferDto): Promise<unknown> {
    this.ensureYellowReady();
    if (!body.allocations || !Array.isArray(body.allocations)) {
      throw new BadRequestException('Body must include allocations');
    }
    if (!body.destination && !body.destination_user_tag) {
      throw new BadRequestException(
        'Either destination (address) or destination_user_tag is required',
      );
    }
    return this.yellowClient.transfer(
      body as Parameters<YellowClientService['transfer']>[0],
    );
  }
}
