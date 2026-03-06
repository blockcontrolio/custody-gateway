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
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import type { Address } from 'viem';
import { CustodyService } from './custody.service';
import { DepositDto, WithdrawDto } from './dto';

@ApiTags('Custody')
@Controller('custody')
export class CustodyController {
  constructor(private readonly custodyService: CustodyService) {}

  @Get('wallet-balance')
  @ApiOperation({ summary: 'Get native ETH balance of a wallet' })
  @ApiQuery({ name: 'wallet', example: 'A', description: 'A or B' })
  @ApiQuery({ name: 'chain', example: 'ethereum_sepolia' })
  @ApiOkResponse({ description: 'Wallet ETH balance' })
  async getWalletBalance(
    @Query('wallet') wallet: string,
    @Query('chain') chain: string,
  ) {
    if (!wallet || !chain) {
      throw new BadRequestException('wallet and chain are required');
    }
    const { address } = this.custodyService.resolveWallet(wallet);
    const result = await this.custodyService.getWalletBalance(address, chain);
    return { address, chain, ...result };
  }

  @Get('balance')
  @ApiOperation({ summary: 'Get balance inside Custody contract' })
  @ApiQuery({ name: 'wallet', example: 'A', description: 'A or B' })
  @ApiQuery({
    name: 'token',
    example: '0x0000000000000000000000000000000000000000',
    description: 'Token address (zero for ETH)',
  })
  @ApiQuery({ name: 'chain', example: 'ethereum_sepolia' })
  @ApiOkResponse({ description: 'Custody contract balance' })
  async getCustodyBalance(
    @Query('wallet') wallet: string,
    @Query('token') token: string,
    @Query('chain') chain: string,
  ) {
    if (!wallet || !token || !chain) {
      throw new BadRequestException('wallet, token and chain are required');
    }
    const { address } = this.custodyService.resolveWallet(wallet);
    const result = await this.custodyService.getCustodyBalance(
      address,
      token as Address,
      chain,
    );
    return { address, token, chain, ...result };
  }

  @Post('deposit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deposit tokens/ETH into Custody contract' })
  @ApiBody({ type: DepositDto })
  @ApiOkResponse({ description: 'Deposit tx hash' })
  async deposit(@Body() body: DepositDto) {
    if (!body.wallet || !body.token || !body.amount || !body.chain) {
      throw new BadRequestException(
        'wallet, token, amount and chain are required',
      );
    }
    return this.custodyService.deposit(
      body.wallet,
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
    if (!body.wallet || !body.token || !body.amount || !body.chain) {
      throw new BadRequestException(
        'wallet, token, amount and chain are required',
      );
    }
    return this.custodyService.withdraw(
      body.wallet,
      body.token as Address,
      body.amount,
      body.chain,
    );
  }
}
