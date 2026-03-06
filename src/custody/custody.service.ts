import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseUnits,
} from 'viem';
import type { Address, Hex, PublicClient, Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CustodyAbi, Erc20Abi } from '@erc7824/nitrolite';
import {
  CUSTODY_ADDRESS,
  ETH_TOKEN,
  CHAIN_CONFIG,
} from './custody.constants';

@Injectable()
export class CustodyService {
  private readonly logger = new Logger(CustodyService.name);

  constructor(private readonly config: ConfigService) {}

  /** Resolve wallet "A" or "B" to private key from env. */
  resolveWallet(wallet: string): { privateKey: Hex; address: Address } {
    const key =
      wallet.toUpperCase() === 'B'
        ? this.config.get<string>('YELLOW_SIGNER_PRIVATE_KEY_B')
        : this.config.get<string>('YELLOW_SIGNER_PRIVATE_KEY');
    if (!key) {
      throw new BadRequestException(`Private key for wallet ${wallet} not configured`);
    }
    const account = privateKeyToAccount(key as Hex);
    return { privateKey: key as Hex, address: account.address };
  }

  /** Resolve RPC URL for a chain (from env or default public). */
  private getRpcUrl(chainName: string): string | undefined {
    const cfg = CHAIN_CONFIG[chainName];
    if (cfg?.rpcEnvKey) {
      return this.config.get<string>(cfg.rpcEnvKey);
    }
    return undefined;
  }

  /** Create a public client for a given chain name. */
  private getPublicClient(chainName: string): PublicClient {
    const cfg = CHAIN_CONFIG[chainName];
    if (!cfg) {
      throw new BadRequestException(
        `Unknown chain: ${chainName}. Supported: ${Object.keys(CHAIN_CONFIG).join(', ')}`,
      );
    }
    const rpcUrl = this.getRpcUrl(chainName);
    return createPublicClient({
      chain: cfg.chain,
      transport: http(rpcUrl),
    });
  }

  /** Get native ETH balance of a wallet. */
  async getWalletBalance(
    address: Address,
    chainName: string,
  ): Promise<{ balance: string; formatted: string }> {
    const client = this.getPublicClient(chainName);
    const balance = await client.getBalance({ address });
    return {
      balance: balance.toString(),
      formatted: formatEther(balance),
    };
  }

  /** Get balance inside Custody contract. */
  async getCustodyBalance(
    address: Address,
    token: Address,
    chainName: string,
  ): Promise<{ balance: string }> {
    const client = this.getPublicClient(chainName);
    const result = await client.readContract({
      address: CUSTODY_ADDRESS,
      abi: CustodyAbi,
      functionName: 'getAccountsBalances',
      args: [[address], [token]],
    });
    const balances = result as bigint[][];
    const bal = balances[0]?.[0] ?? 0n;
    return { balance: bal.toString() };
  }

  /** Deposit tokens (or ETH) into Custody contract. */
  async deposit(
    wallet: string,
    token: Address,
    amount: string,
    chainName: string,
  ): Promise<{ txHash: Hash; amount: string; token: Address }> {
    const { privateKey, address } = this.resolveWallet(wallet);
    const cfg = CHAIN_CONFIG[chainName];
    if (!cfg) {
      throw new BadRequestException(`Unknown chain: ${chainName}`);
    }

    const account = privateKeyToAccount(privateKey);
    const publicClient = this.getPublicClient(chainName);
    const rpcUrl = this.getRpcUrl(chainName);
    const walletClient = createWalletClient({
      account,
      chain: cfg.chain,
      transport: http(rpcUrl),
    });

    const amountBigInt = BigInt(amount);
    const isETH = token.toLowerCase() === ETH_TOKEN.toLowerCase();

    // For ERC20: approve first
    if (!isETH) {
      const allowance = await publicClient.readContract({
        address: token,
        abi: Erc20Abi,
        functionName: 'allowance',
        args: [address, CUSTODY_ADDRESS],
      }) as bigint;

      if (allowance < amountBigInt) {
        this.logger.log(`Approving ${amount} of ${token} for Custody...`);
        const approveTx = await walletClient.writeContract({
          address: token,
          abi: Erc20Abi,
          functionName: 'approve',
          args: [CUSTODY_ADDRESS, amountBigInt],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
        this.logger.log(`Approve tx: ${approveTx}`);
      }
    }

    this.logger.log(
      `Depositing ${amount} of ${isETH ? 'ETH' : token} from ${address} on ${chainName}...`,
    );

    const txHash = await walletClient.writeContract({
      address: CUSTODY_ADDRESS,
      abi: CustodyAbi,
      functionName: 'deposit',
      args: [address, token, amountBigInt],
      ...(isETH ? { value: amountBigInt } : {}),
    });

    await publicClient.waitForTransactionReceipt({ hash: txHash });
    this.logger.log(`Deposit tx: ${txHash}`);

    return { txHash, amount, token };
  }

  /** Withdraw tokens (or ETH) from Custody contract. */
  async withdraw(
    wallet: string,
    token: Address,
    amount: string,
    chainName: string,
  ): Promise<{ txHash: Hash; amount: string; token: Address }> {
    const { privateKey } = this.resolveWallet(wallet);
    const cfg = CHAIN_CONFIG[chainName];
    if (!cfg) {
      throw new BadRequestException(`Unknown chain: ${chainName}`);
    }

    const account = privateKeyToAccount(privateKey);
    const publicClient = this.getPublicClient(chainName);
    const rpcUrl = this.getRpcUrl(chainName);
    const walletClient = createWalletClient({
      account,
      chain: cfg.chain,
      transport: http(rpcUrl),
    });

    const amountBigInt = BigInt(amount);

    this.logger.log(
      `Withdrawing ${amount} of ${token} on ${chainName}...`,
    );

    const txHash = await walletClient.writeContract({
      address: CUSTODY_ADDRESS,
      abi: CustodyAbi,
      functionName: 'withdraw',
      args: [token, amountBigInt],
    });

    await publicClient.waitForTransactionReceipt({ hash: txHash });
    this.logger.log(`Withdraw tx: ${txHash}`);

    return { txHash, amount, token };
  }
}
