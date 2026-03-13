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
  InternalServerErrorException,
  Logger,
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
import { AccountService } from '../account';
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
  private readonly logger = new Logger(YellowController.name);

  constructor(
    private readonly yellowClient: YellowClientService,
    private readonly yellowService: YellowService,
    private readonly yellowAuth: YellowAuthService,
    private readonly accountService: AccountService,
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

  /** Extract a meaningful error message from RPC or unknown errors. */
  private rpcError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return JSON.stringify(err);
  }

  /** Enrich sparse ClearNode RPC result with participants and allocations. */
  private enrichRpcResult(
    result: unknown,
    participants: string[],
    allocations: Array<{ asset: string; amount: string; participant: string }>,
  ): unknown {
    const r = (result ?? {}) as Record<string, unknown>;
    return {
      ...r,
      participants: r.participants ?? participants,
      allocations: allocations.map((a) => ({
        asset: a.asset,
        amount: a.amount,
        participant: a.participant,
      })),
    };
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
  @ApiOperation({ summary: 'Create app session' })
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
    if (!body.definition.participants?.length) {
      throw new BadRequestException(
        'definition.participants must contain at least one address',
      );
    }
    if (!body.allocations.length) {
      throw new BadRequestException(
        'allocations must contain at least one entry',
      );
    }

    // Auto-set nonce if zero or missing — ClearNode requires a non-zero nonce
    if (!body.definition.nonce) {
      body.definition.nonce = Date.now();
    }

    // Auto-set session_data as timestamp
    body.session_data = String(Date.now());

    try {
      const result = await this.yellowClient.createAppSession(
        body as Parameters<YellowClientService['createAppSession']>[0],
      );

      // Store session with participants & allocations
      const rpcResult = result as { app_session_id?: string } | undefined;
      if (rpcResult?.app_session_id) {
        await this.yellowService.onSessionCreated(rpcResult.app_session_id, {
          participants: body.definition.participants,
          allocations: body.allocations.map((a) => ({
            asset: a.asset,
            amount: a.amount,
            participant: a.participant,
          })),
        });
      }

      return this.enrichRpcResult(result, body.definition.participants, body.allocations);
    } catch (err) {
      const msg = this.rpcError(err);
      this.logger.error(`createAppSession failed: ${msg}`);
      throw new BadRequestException(`Create session failed: ${msg}`);
    }
  }

  /** Submit app state (submit_app_state, protocol 0.2). */
  @Post('sessions/:sessionId/state')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit app state' })
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
    if (!sessionId) {
      throw new BadRequestException('sessionId path parameter is required');
    }

    // Auto-set session_data as timestamp
    body.session_data = String(Date.now());

    try {
      const result = await this.yellowClient.submitAppState({
        app_session_id: sessionId as Hex,
        allocations: body.allocations as Parameters<
          YellowClientService['submitAppState']
        >[0]['allocations'],
        session_data: body.session_data,
      });

      const participants = [...new Set(body.allocations.map((a) => a.participant))];

      // Update stored allocations so GET session returns current balances
      await this.yellowService.updateSessionAllocations(
        sessionId,
        body.allocations.map((a) => ({ asset: a.asset, amount: a.amount, participant: a.participant })),
      );

      return this.enrichRpcResult(result, participants, body.allocations);
    } catch (err) {
      const msg = this.rpcError(err);
      this.logger.error(`submitAppState failed: ${msg}`);
      throw new BadRequestException(`Submit state failed: ${msg}`);
    }
  }

  /** Close app session (close_app_session). */
  @Post('sessions/:sessionId/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close app session' })
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
    if (!sessionId) {
      throw new BadRequestException('sessionId path parameter is required');
    }

    // Auto-set session_data as timestamp
    body.session_data = String(Date.now());

    try {
      const result = await this.yellowClient.closeAppSession({
        app_session_id: sessionId as Hex,
        allocations: body.allocations as Parameters<
          YellowClientService['closeAppSession']
        >[0]['allocations'],
        session_data: body.session_data,
      });

      const participants = [...new Set(body.allocations.map((a) => a.participant))];
      return this.enrichRpcResult(result, participants, body.allocations);
    } catch (err) {
      const msg = this.rpcError(err);
      this.logger.error(`closeAppSession failed: ${msg}`);
      throw new BadRequestException(`Close session failed: ${msg}`);
    }
  }

  /** Get channels (get_channels). Optional query: participant, status (open | closed | challenged). */
  @Get('channels')
  @ApiOperation({ summary: 'Get channels' })
  @ApiQuery({ name: 'participant', required: false, example: '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2' })
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

    try {
      return await this.yellowClient.getChannels(
        participant as Hex | undefined,
        statusEnum,
      );
    } catch (err) {
      const msg = this.rpcError(err);
      this.logger.error(`getChannels failed: ${msg}`);
      throw new InternalServerErrorException(`Get channels failed: ${msg}`);
    }
  }

  /** Resize channel — add or remove funds without closing. */
  @Post('channels/:channelId/resize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resize channel' })
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
    if (!body.resize_amount && !body.allocate_amount) {
      throw new BadRequestException(
        'Either resize_amount or allocate_amount is required',
      );
    }

    try {
      return await this.yellowClient.resizeChannel({
        channel_id: channelId as Hex,
        ...(body.resize_amount != null && {
          resize_amount: BigInt(body.resize_amount),
        }),
        ...(body.allocate_amount != null && {
          allocate_amount: BigInt(body.allocate_amount),
        }),
        funds_destination: body.funds_destination as Hex,
      });
    } catch (err) {
      const msg = this.rpcError(err);
      this.logger.error(`resizeChannel failed: ${msg}`);
      throw new BadRequestException(`Resize channel failed: ${msg}`);
    }
  }

  /** Request sandbox faucet tokens for an address (sandbox only). */
  @Post('faucet')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request sandbox faucet tokens' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { address: { type: 'string', example: '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2' } },
      required: ['address'],
    },
  })
  @ApiOkResponse({ description: 'Faucet result' })
  async faucet(@Body() body: { address?: string; userId?: string }): Promise<unknown> {
    if (body.userId && !body.address) {
      try {
        body.address = await this.accountService.resolveAddress(body.userId);
      } catch {
        throw new BadRequestException(`Could not resolve userId "${body.userId}" to an address`);
      }
    }
    if (!body.address) {
      throw new BadRequestException('address or userId is required');
    }

    try {
      const res = await fetch(
        'https://clearnet-sandbox.yellow.com/faucet/requestTokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userAddress: body.address }),
        },
      );
      const json = (await res.json()) as Record<string, unknown>;
      if (!json.success) {
        throw new BadRequestException(`Faucet failed: ${JSON.stringify(json)}`);
      }
      return json;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const msg = this.rpcError(err);
      this.logger.error(`faucet failed: ${msg}`);
      throw new InternalServerErrorException(`Faucet request failed: ${msg}`);
    }
  }

  /** Get ledger balances (off-chain unified balance). Accepts userId or account address. */
  @Get('ledger-balances')
  @ApiOperation({ summary: 'Get ledger balances' })
  @ApiQuery({ name: 'account', required: false, example: '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2', description: 'Account address (defaults to own)' })
  @ApiQuery({ name: 'userId', required: false, description: 'Resolve userId to account address' })
  @ApiOkResponse({ description: 'Ledger balances' })
  async getLedgerBalances(
    @Query('account') account?: string,
    @Query('userId') userId?: string,
  ): Promise<unknown> {
    this.ensureYellowReady();
    if (userId && !account) {
      try {
        account = await this.accountService.resolveAddress(userId);
      } catch {
        throw new BadRequestException(`Could not resolve userId "${userId}" to an address`);
      }
    }

    try {
      return await this.yellowClient.getLedgerBalances(account);
    } catch (err) {
      const msg = this.rpcError(err);
      this.logger.error(`getLedgerBalances failed: ${msg}`);
      throw new BadRequestException(`Get ledger balances failed: ${msg}`);
    }
  }

  /** Transfer. Accepts userId / destinationUserId as alternatives to addresses. */
  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transfer' })
  @ApiBody({ type: TransferDto })
  @ApiOkResponse({ description: 'RPC result' })
  async transfer(@Body() body: TransferDto & { userId?: string; destinationUserId?: string }): Promise<unknown> {
    this.ensureYellowReady();
    if (!body.allocations || !Array.isArray(body.allocations)) {
      throw new BadRequestException('Body must include allocations');
    }
    if (!body.allocations.length) {
      throw new BadRequestException('allocations must contain at least one entry');
    }

    // Resolve userId → destination address
    if (body.destinationUserId && !body.destination) {
      try {
        body.destination = await this.accountService.resolveAddress(body.destinationUserId);
      } catch {
        throw new BadRequestException(
          `Could not resolve destinationUserId "${body.destinationUserId}" to an address`,
        );
      }
    }
    if (!body.destination && !body.destination_user_tag) {
      throw new BadRequestException(
        'Either destination, destinationUserId, or destination_user_tag is required',
      );
    }

    try {
      return await this.yellowClient.transfer(
        body as Parameters<YellowClientService['transfer']>[0],
      );
    } catch (err) {
      const msg = this.rpcError(err);
      this.logger.error(`transfer failed: ${msg}`);
      throw new BadRequestException(`Transfer failed: ${msg}`);
    }
  }
}
