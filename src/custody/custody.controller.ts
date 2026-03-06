import {
  Controller,
  Post,
  Get,
  Body,
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
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import type { Address } from 'viem';
import { KeyProvider } from '../key-provider';
import { CustodyService } from './custody.service';
import { DepositDto, WithdrawDto } from './dto';

@ApiTags('Custody')
@Controller('custody')
export class CustodyController {
  constructor(
    private readonly custodyService: CustodyService,
    private readonly keyProvider: KeyProvider,
  ) {}

  /* ───── Account management ───── */

  @Post('accounts')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new managed wallet' })
  @ApiCreatedResponse({ description: 'Newly created wallet address' })
  createAccount(): { address: string } {
    const address = this.keyProvider.generateKey();
    return { address };
  }

  @Get('accounts')
  @ApiOperation({ summary: 'List all managed wallet addresses' })
  @ApiOkResponse({ description: 'List of addresses' })
  listAccounts(): { addresses: string[] } {
    return { addresses: this.keyProvider.listAddresses() };
  }

  /* ───── Balance queries ───── */

  @Get('wallet-balance')
  @ApiOperation({ summary: 'Get native ETH balance of a wallet' })
  @ApiQuery({ name: 'address', example: '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2' })
  @ApiQuery({ name: 'chain', example: 'ethereum_sepolia' })
  @ApiOkResponse({ description: 'Wallet ETH balance' })
  async getWalletBalance(
    @Query('address') address: string,
    @Query('chain') chain: string,
  ) {
    if (!address || !chain) {
      throw new BadRequestException('address and chain are required');
    }
    const result = await this.custodyService.getWalletBalance(
      address as Address,
      chain,
    );
    return { address, chain, ...result };
  }

  @Get('balance')
  @ApiOperation({ summary: 'Get balance inside Custody contract' })
  @ApiQuery({ name: 'address', example: '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2' })
  @ApiQuery({
    name: 'token',
    example: '0x0000000000000000000000000000000000000000',
    description: 'Token address (zero for ETH)',
  })
  @ApiQuery({ name: 'chain', example: 'ethereum_sepolia' })
  @ApiOkResponse({ description: 'Custody contract balance' })
  async getCustodyBalance(
    @Query('address') address: string,
    @Query('token') token: string,
    @Query('chain') chain: string,
  ) {
    if (!address || !token || !chain) {
      throw new BadRequestException('address, token and chain are required');
    }
    const result = await this.custodyService.getCustodyBalance(
      address as Address,
      token as Address,
      chain,
    );
    return { address, token, chain, ...result };
  }

  /* ───── Deposit / Withdraw ───── */

  @Post('deposit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deposit tokens/ETH into Custody contract' })
  @ApiBody({ type: DepositDto })
  @ApiOkResponse({ description: 'Deposit tx hash' })
  async deposit(@Body() body: DepositDto) {
    if (!body.address || !body.token || !body.amount || !body.chain) {
      throw new BadRequestException(
        'address, token, amount and chain are required',
      );
    }
    return this.custodyService.deposit(
      body.address as Address,
      body.token as Address,
      body.amount,
      body.chain,
    );
  }

  @Post('withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw tokens/ETH from Custody contract' })
  @ApiBody({ type: WithdrawDto })
  @ApiOkResponse({ description: 'Withdraw tx hash' })
  async withdraw(@Body() body: WithdrawDto) {
    if (!body.address || !body.token || !body.amount || !body.chain) {
      throw new BadRequestException(
        'address, token, amount and chain are required',
      );
    }
    return this.custodyService.withdraw(
      body.address as Address,
      body.token as Address,
      body.amount,
      body.chain,
    );
  }
}
