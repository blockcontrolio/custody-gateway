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
import { AccountService } from './account.service';
import type { AccountInfo, WalletInfo } from './account.service';

@ApiTags('Accounts')
@Controller('accounts')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  /** Create a new account (auto-generates UUID + wallet). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create new account' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        label: { type: 'string', example: 'main', nullable: true },
      },
    },
  })
  @ApiCreatedResponse({ description: 'Account with userId (UUID) and wallet address' })
  async createAccount(
    @Body() body: { label?: string },
  ): Promise<{ userId: string; wallet: WalletInfo }> {
    return this.accountService.createAccount(body.label);
  }

  /** Get account by userId. */
  @Get(':userId')
  @ApiOperation({ summary: 'Get account by userId' })
  @ApiParam({ name: 'userId', example: '550e8400-e29b-41d4-a716-446655440000', format: 'uuid' })
  @ApiOkResponse({ description: 'Account with wallets' })
  async getAccount(@Param('userId') userId: string): Promise<AccountInfo> {
    return this.accountService.getAccount(userId);
  }

  /** Add another wallet to an existing user. */
  @Post(':userId/wallets')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add wallet to existing user' })
  @ApiParam({ name: 'userId', example: '550e8400-e29b-41d4-a716-446655440000', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        label: { type: 'string', example: 'trading', nullable: true },
      },
    },
  })
  @ApiCreatedResponse({ description: 'New wallet' })
  async addWallet(
    @Param('userId') userId: string,
    @Body() body: { label?: string },
  ): Promise<WalletInfo> {
    return this.accountService.addWallet(userId, body.label);
  }

  /** List all accounts. */
  @Get()
  @ApiOperation({ summary: 'List all accounts' })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiOkResponse({ description: 'List of accounts' })
  async listAccounts(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<AccountInfo[]> {
    return this.accountService.listAccounts(
      limit ? parseInt(limit, 10) : 100,
      offset ? parseInt(offset, 10) : 0,
    );
  }

  /** Resolve userId → primary address. */
  @Get(':userId/address')
  @ApiOperation({ summary: 'Resolve userId to primary wallet address' })
  @ApiParam({ name: 'userId', example: '550e8400-e29b-41d4-a716-446655440000', format: 'uuid' })
  @ApiOkResponse({ description: 'Primary wallet address' })
  async resolveAddress(
    @Param('userId') userId: string,
  ): Promise<{ userId: string; address: string }> {
    const address = await this.accountService.resolveAddress(userId);
    return { userId, address };
  }
}
