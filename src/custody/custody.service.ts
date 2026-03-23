import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, createWalletClient, http, formatEther } from 'viem';
import type { Address, Hex, PublicClient, Hash } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { CustodyAbi, Erc20Abi, NitroliteClient, WalletStateSigner } from '@erc7824/nitrolite';
import { getPackedState } from '@erc7824/nitrolite/dist/utils/state.js';
import { KeyProvider } from '../key-provider/index.js';
import { CHAIN_CONFIG, type ChainConfig } from './custody.constants.js';

/** Resolved chain context with viem clients ready to use. */
interface ChainClients {
  cfg: ChainConfig;
  account: PrivateKeyAccount;
  publicClient: PublicClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walletClient: any;
}

/** Allocations in the on-chain state format. */
interface OnchainAllocation {
  destination: Address;
  token: Address;
  amount: bigint;
}

@Injectable()
export class CustodyService {
  private readonly logger = new Logger(CustodyService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly keyProvider: KeyProvider,
  ) {}

  // ─── Shared helpers ─────────────────────────────────────

  /** Resolve an address to its private key via the key provider. */
  resolveWallet(address: Address): { privateKey: Hex; address: Address } {
    const key = this.keyProvider.getKey(address);
    if (!key) {
      throw new BadRequestException(`No managed key for address ${address}`);
    }
    return { privateKey: key, address };
  }

  /** Validate and return chain config; throws on unknown chain. */
  private getChainConfig(chainName: string): ChainConfig {
    const cfg = CHAIN_CONFIG[chainName];
    if (!cfg) {
      throw new BadRequestException(
        `Unknown chain: ${chainName}. Supported: ${Object.keys(CHAIN_CONFIG).join(', ')}`,
      );
    }
    return cfg;
  }

  /** Create a public client for a given chain name. */
  private getPublicClient(chainName: string): PublicClient {
    const cfg = this.getChainConfig(chainName);
    const rpcUrl = cfg.rpcEnvKey ? this.config.get<string>(cfg.rpcEnvKey) : undefined;
    return createPublicClient({ chain: cfg.chain, transport: http(rpcUrl) });
  }

  /**
   * Create public + wallet clients for a managed address on a chain.
   * Eliminates the repeated pattern of resolveWallet → account → clients.
   */
  private createClients(address: Address, chainName: string): ChainClients {
    const { privateKey } = this.resolveWallet(address);
    const cfg = this.getChainConfig(chainName);
    const account = privateKeyToAccount(privateKey);
    const rpcUrl = cfg.rpcEnvKey ? this.config.get<string>(cfg.rpcEnvKey) : undefined;
    const publicClient = createPublicClient({
      chain: cfg.chain,
      transport: http(rpcUrl),
    });
    const walletClient = createWalletClient({
      account,
      chain: cfg.chain,
      transport: http(rpcUrl),
    });
    return { cfg, account, publicClient, walletClient };
  }

  /** Parse RPC allocations into typed on-chain format. */
  private toOnchainAllocations(raw: any[]): OnchainAllocation[] {
    return raw.map((a: any) => ({
      destination: a.destination as Address,
      token: a.token as Address,
      amount: BigInt(a.amount),
    }));
  }

  // ─── Balance queries ────────────────────────────────────

  /** Get native ETH balance of a wallet. */
  async getWalletBalance(
    address: Address,
    chainName: string,
  ): Promise<{ balance: string; formatted: string }> {
    const client = this.getPublicClient(chainName);
    const balance = await client.getBalance({ address });
    return { balance: balance.toString(), formatted: formatEther(balance) };
  }

  /** Get ERC20 token balance of a wallet. */
  async getTokenBalance(
    address: Address,
    token: Address,
    chainName: string,
  ): Promise<{ balance: string; formatted: string }> {
    const client = this.getPublicClient(chainName);
    const balance = (await client.readContract({
      address: token,
      abi: Erc20Abi,
      functionName: 'balanceOf',
      args: [address],
    })) as bigint;
    const decimals = (await client
      .readContract({
        address: token,
        abi: Erc20Abi,
        functionName: 'decimals',
      })
      .catch(() => 6)) as number;
    return {
      balance: balance.toString(),
      formatted: (Number(balance) / 10 ** decimals).toString(),
    };
  }

  /** Get balance inside Custody contract. */
  async getCustodyBalance(
    address: Address,
    token: Address,
    chainName: string,
  ): Promise<{ balance: string }> {
    const client = this.getPublicClient(chainName);
    const cfg = this.getChainConfig(chainName);
    const result = await client.readContract({
      address: cfg.custody,
      abi: CustodyAbi,
      functionName: 'getAccountsBalances',
      args: [[address], [token]],
    });
    const bal = (result as bigint[][])[0]?.[0] ?? 0n;
    return { balance: bal.toString() };
  }

  // ─── Transfers ──────────────────────────────────────────

  /** Transfer ERC20 tokens between managed wallets. */
  async transferToken(
    from: Address,
    to: Address,
    token: Address,
    amount: string,
    chainName: string,
  ): Promise<{ txHash: Hash }> {
    const { publicClient, walletClient } = this.createClients(from, chainName);
    const txHash = await walletClient.writeContract({
      address: token,
      abi: Erc20Abi,
      functionName: 'transfer',
      args: [to, BigInt(amount)],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    this.logger.log(`Transfer ${amount} of ${token}: ${from} → ${to} tx=${txHash}`);
    return { txHash };
  }

  /** Transfer native ETH between managed wallets. */
  async transferEth(
    from: Address,
    to: Address,
    amount: bigint,
    chainName: string,
  ): Promise<{ txHash: Hash }> {
    const { publicClient, walletClient } = this.createClients(from, chainName);
    const txHash = await walletClient.sendTransaction({ to, value: amount });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    this.logger.log(`Transfer ETH ${amount}: ${from} → ${to} tx=${txHash}`);
    return { txHash };
  }

  // ─── Custody contract operations ────────────────────────

  /** Approve + deposit ERC20 tokens into Custody contract. */
  async depositToCustody(
    address: Address,
    token: Address,
    amount: bigint,
    chainName: string,
  ): Promise<{ txHash: Hash }> {
    const { cfg, publicClient, walletClient } = this.createClients(address, chainName);

    // Approve if needed
    const allowance = (await publicClient.readContract({
      address: token,
      abi: Erc20Abi,
      functionName: 'allowance',
      args: [address, cfg.custody],
    })) as bigint;
    if (allowance < amount) {
      const approveTx = await walletClient.writeContract({
        address: token,
        abi: Erc20Abi,
        functionName: 'approve',
        args: [cfg.custody, amount],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
      this.logger.log(`Approved ${amount} of ${token} for Custody`);
    }

    // Deposit
    const txHash = await walletClient.writeContract({
      address: cfg.custody,
      abi: CustodyAbi,
      functionName: 'deposit',
      args: [address, token, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    this.logger.log(`Deposited ${amount} of ${token} into Custody tx=${txHash}`);
    return { txHash };
  }

  /** Withdraw tokens from Custody contract back to wallet. */
  async withdraw(
    address: Address,
    token: Address,
    amount: string,
    chainName: string,
  ): Promise<{ txHash: Hash; amount: string; token: Address }> {
    const { cfg, publicClient, walletClient } = this.createClients(address, chainName);
    this.logger.log(`Withdrawing ${amount} of ${token} on ${chainName}...`);
    const txHash = await walletClient.writeContract({
      address: cfg.custody,
      abi: CustodyAbi,
      functionName: 'withdraw',
      args: [token, BigInt(amount)],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    this.logger.log(`Withdraw tx: ${txHash}`);
    return { txHash, amount, token };
  }

  // ─── Channel on-chain operations ────────────────────────

  /**
   * Create channel on-chain. Uses existing Custody balance (no new deposit).
   */
  async onchainCreateChannel(
    address: Address,
    channelData: {
      channel: { participants: string[]; adjudicator: string; challenge: number; nonce: number };
      state: { intent: number; version: number; state_data: string; allocations: any[] };
      server_signature: string;
    },
    chainName: string,
  ): Promise<{ txHash: Hash; channelId: Hex }> {
    const { cfg, publicClient, walletClient } = this.createClients(address, chainName);

    const nitrolite = new NitroliteClient({
      publicClient,
      walletClient,
      stateSigner: new WalletStateSigner(walletClient),
      addresses: { custody: cfg.custody, adjudicator: cfg.adjudicator },
      chainId: cfg.chainId,
      challengeDuration: BigInt(channelData.channel.challenge),
    });

    const createParams = {
      channel: {
        participants: channelData.channel.participants.map((p) => p as Address),
        adjudicator: channelData.channel.adjudicator as Address,
        challenge: BigInt(channelData.channel.challenge),
        nonce: BigInt(channelData.channel.nonce),
      },
      unsignedInitialState: {
        intent: channelData.state.intent,
        version: BigInt(channelData.state.version),
        data: (channelData.state.state_data || '0x') as Hex,
        allocations: this.toOnchainAllocations(channelData.state.allocations),
      },
      serverSignature: channelData.server_signature as Hex,
    };

    try {
      const result = await nitrolite.createChannel(createParams);
      await publicClient.waitForTransactionReceipt({ hash: result.txHash });
      this.logger.log(`Channel created on-chain: ${result.channelId} tx=${result.txHash}`);
      return { txHash: result.txHash, channelId: result.channelId as Hex };
    } catch {
      // Fallback: depositAndCreateChannel with 0 deposit
      this.logger.debug('createChannel failed, trying depositAndCreateChannel with 0');
      const token = channelData.state.allocations[0]?.token as Address;
      const result = await nitrolite.depositAndCreateChannel(token, 0n, createParams);
      await publicClient.waitForTransactionReceipt({ hash: result.txHash });
      this.logger.log(`Channel created (depositAndCreate) tx=${result.txHash}`);
      return { txHash: result.txHash, channelId: result.channelId as Hex };
    }
  }

  /**
   * Resize channel on-chain with proof from current on-chain state.
   */
  async onchainResize(
    address: Address,
    channelId: Hex,
    resizeState: { intent: number; version: number; state_data: string; allocations: any[] },
    serverSignature: Hex,
    chainName: string,
  ): Promise<{ txHash: Hash }> {
    const { cfg, account, publicClient, walletClient } = this.createClients(address, chainName);

    // Build proof from current on-chain state
    const chainData = (await publicClient.readContract({
      address: cfg.custody,
      abi: CustodyAbi,
      functionName: 'getChannelData',
      args: [channelId],
    })) as any;
    const lastState = chainData[4];
    const initProof = {
      intent: Number(lastState.intent),
      version: lastState.version,
      data: lastState.data as Hex,
      allocations: lastState.allocations.map((a: any) => ({
        destination: a.destination as Address,
        token: a.token as Address,
        amount: a.amount,
      })),
      sigs: [...lastState.sigs] as Hex[],
    };

    // Build unsigned resize state
    const unsignedResize = {
      intent: resizeState.intent,
      version: BigInt(resizeState.version),
      data: (resizeState.state_data || '0x') as Hex,
      allocations: this.toOnchainAllocations(resizeState.allocations),
    };

    // Sign and submit
    const packed = getPackedState(channelId, unsignedResize);
    const userSig = await account.signMessage({ message: { raw: packed } });
    const { request } = await publicClient.simulateContract({
      address: cfg.custody,
      abi: CustodyAbi,
      functionName: 'resize',
      args: [channelId, { ...unsignedResize, sigs: [userSig, serverSignature] }, [initProof]],
      account,
    });
    const txHash = await walletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    this.logger.log(`Channel resized on-chain: ${channelId} tx=${txHash}`);
    return { txHash };
  }
}
