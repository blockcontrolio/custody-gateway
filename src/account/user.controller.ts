import { Controller, Post, Get, Body, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { AccountService } from './account.service.js';
import type { AccountInfo, WalletInfo } from './account.service.js';

@ApiTags('Users')
@Controller('users')
export class UserController {
  constructor(private readonly accountService: AccountService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new user (generates wallet + private key)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { label: { type: 'string', example: 'Alice', nullable: true } },
    },
  })
  @ApiCreatedResponse({ description: 'User with userId and wallet address' })
  async create(@Body() body: { label?: string }): Promise<{ userId: string; wallet: WalletInfo }> {
    return this.accountService.createAccount(body.label);
  }

  @Get()
  @ApiOperation({ summary: 'List all users' })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiOkResponse({ description: 'List of users with wallets' })
  async list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<AccountInfo[]> {
    return this.accountService.listAccounts(
      limit ? parseInt(limit, 10) : 100,
      offset ? parseInt(offset, 10) : 0,
    );
  }

  @Get(':userId')
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiOkResponse({ description: 'User with wallets' })
  async get(@Param('userId') userId: string): Promise<AccountInfo> {
    return this.accountService.getAccount(userId);
  }

  @Get(':userId/balance')
  @ApiOperation({ summary: 'Get user wallet balance (ETH + tokens)' })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiQuery({ name: 'chain', required: false, example: 'ethereum' })
  @ApiOkResponse({ description: 'Wallet balances' })
  async getBalance(@Param('userId') userId: string, @Query('chain') chain?: string) {
    return this.accountService.getBalance(userId, chain);
  }

  @Post(':userId/transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transfer tokens or ETH to another address' })
  @ApiParam({ name: 'userId' })
  async transfer(
    @Param('userId') userId: string,
    @Body() body: { to: string; asset: string; amount: string; chain?: string },
  ) {
    return this.accountService.transfer(userId, body.to, body.asset, body.amount, body.chain);
  }
}
