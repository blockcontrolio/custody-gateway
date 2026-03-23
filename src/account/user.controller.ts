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
import { ApiTags, ApiOperation, ApiOkResponse, ApiCreatedResponse, ApiParam, ApiQuery, ApiBody } from '@nestjs/swagger';
import type { Address } from 'viem';
import { AccountService } from './account.service.js';
import type { AccountInfo, WalletInfo } from './account.service.js';
import { CustodyService } from '../custody/custody.service.js';
import { resolveTokenAddress, TOKENS, DEFAULT_CHAIN } from '../custody/custody.constants.js';

@ApiTags('Users')
@Controller('users')
export class UserController {
  constructor(
    private readonly accountService: AccountService,
    private readonly custodyService: CustodyService,
  ) {}

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
  async create(
    @Body() body: { label?: string },
  ): Promise<{ userId: string; wallet: WalletInfo }> {
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
  @ApiQuery({ name: 'chain', required: false, example: 'ethereum', description: 'Chain name (default: ethereum)' })
  @ApiOkResponse({ description: 'Wallet balances' })
  async getBalance(
    @Param('userId') userId: string,
    @Query('chain') chain?: string,
  ): Promise<{
    userId: string;
    address: string;
    chain: string;
    eth: string;
    tokens: Record<string, string>;
  }> {
    const chainName = chain || DEFAULT_CHAIN;
    const address = await this.accountService.resolveAddress(userId);

    // ETH balance
    const ethBal = await this.custodyService.getWalletBalance(address, chainName);

    // Token balances
    const chainTokens = TOKENS[chainName] ?? {};
    const tokens: Record<string, string> = {};
    for (const [symbol, tokenAddr] of Object.entries(chainTokens)) {
      try {
        const bal = await this.custodyService.getTokenBalance(
          address,
          tokenAddr as Address,
          chainName,
        );
        tokens[symbol] = bal.formatted;
      } catch {
        tokens[symbol] = '0';
      }
    }

    return {
      userId,
      address,
      chain: chainName,
      eth: ethBal.formatted,
      tokens,
    };
  }

  @Post(':userId/transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transfer tokens or ETH to another address' })
  @ApiParam({ name: 'userId' })
  async transfer(
    @Param('userId') userId: string,
    @Body() body: { to: string; asset: string; amount: string; chain?: string },
  ): Promise<unknown> {
    const chainName = body.chain || DEFAULT_CHAIN;
    const from = await this.accountService.resolveAddress(userId);

    if (body.asset.toLowerCase() === 'eth') {
      const { parseEther } = await import('viem');
      return this.custodyService.transferEth(
        from,
        body.to as Address,
        parseEther(body.amount),
        chainName,
      );
    }

    const tokenAddr = resolveTokenAddress(body.asset, chainName);
    if (!tokenAddr) {
      throw new BadRequestException(`Unknown token "${body.asset}" on "${chainName}"`);
    }
    return this.custodyService.transferToken(
      from,
      body.to as Address,
      tokenAddr,
      body.amount,
      chainName,
    );
  }
}
