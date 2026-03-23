/**
 * Full funded flow test using @erc7824/nitrolite only.
 *
 * Steps:
 * 1. Connect to ClearNode, auth
 * 2. get_config → ChannelHub address, node address
 * 3. get_assets → USDC token address for chain 1
 * 4. get_channels → check existing channels
 * 5. get_ledger_balances → check ClearNode-side balances
 * 6. create_channel → create channel for Alice2
 * 7. On-chain: approve + deposit via NitroliteClient
 * 8. create_app_session with real allocations
 */
import WebSocket from 'ws';
import { createECDSAMessageSigner } from '@erc7824/nitrolite';
import type { MessageSigner } from '@erc7824/nitrolite';
import { createPublicClient, createWalletClient, http, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

// ─── Config ──────────────────────────────────────────────────────────────────

const CLEARNODE_URL = process.env.CLEARNODE_URL || 'wss://clearnet.yellow.com/ws';
const ETH_RPC = process.env.ETHEREUM_RPC_URL!;
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY!, 'hex');

// Alice2 and Bob addresses (keys in DB)
const ALICE2 = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325' as Address;
const BOB = '0x772ddE0ba5C672b72b4FB740c2FaB5F1Bcf6Cc2C' as Address;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function decrypt(encrypted: string, iv: string, tag: string): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString('utf8');
}

async function getPrivateKey(address: string): Promise<Hex> {
  const prisma = new PrismaClient();
  const row = await prisma.managedKey.findUnique({ where: { address } });
  await prisma.$disconnect();
  if (!row) throw new Error(`No key found for ${address}`);
  return decrypt(row.encryptedKey, row.iv, row.tag) as Hex;
}

// ─── ClearNode RPC helper ────────────────────────────────────────────────────

type PendingRequest = {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
};

class ClearNodeRPC {
  private ws!: WebSocket;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;

  async connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (data: WebSocket.Data) => {
        const text = data.toString();
        try {
          const msg = JSON.parse(text);
          if (msg.res && Array.isArray(msg.res)) {
            const [requestId, method, result] = msg.res;
            const p = this.pending.get(requestId);
            if (p) {
              this.pending.delete(requestId);
              if (result?.error) p.reject(new Error(`${method}: ${result.error}`));
              else p.resolve(result);
            }
          }
        } catch (e) {
          console.error('Parse error:', e);
        }
      });
    });
  }

  /** Send a pre-built message string and wait for response */
  sendRaw(requestId: number, msgStr: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Request ${requestId} timed out`));
      }, 15000);

      this.pending.set(requestId, {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      this.ws.send(msgStr);
    });
  }

  /** Generic RPC call using nitrolite message builders */
  async call(
    buildMessage: (signer: MessageSigner, requestId: number) => Promise<string>,
    signer: MessageSigner,
  ): Promise<any> {
    const requestId = this.nextId++;
    const msg = await buildMessage(signer, requestId);
    return this.sendRaw(requestId, msg);
  }

  /** Call with co-signatures from multiple participants */
  async callCoSigned(
    buildMessage: (signer: MessageSigner, requestId: number) => Promise<string>,
    primarySigner: MessageSigner,
    allSigners: MessageSigner[],
  ): Promise<any> {
    const requestId = this.nextId++;
    const msg = await buildMessage(primarySigner, requestId);

    // Add co-signatures
    const parsed = JSON.parse(msg) as { req: unknown; sig: Hex[] };
    const sigs: Hex[] = [];
    for (const s of allSigners) {
      sigs.push(await s(parsed.req as any));
    }
    parsed.sig = sigs;

    return this.sendRaw(requestId, JSON.stringify(parsed));
  }

  close() {
    this.ws?.close();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Get private keys from DB
  console.log('=== Loading keys ===');
  const aliceKey = await getPrivateKey(ALICE2);
  const bobKey = await getPrivateKey(BOB);
  const aliceAccount = privateKeyToAccount(aliceKey);
  const bobAccount = privateKeyToAccount(bobKey);
  console.log('Alice2:', aliceAccount.address);
  console.log('Bob:', bobAccount.address);

  const aliceSigner = createECDSAMessageSigner(aliceKey);
  const bobSigner = createECDSAMessageSigner(bobKey);

  // 2. Connect to ClearNode
  console.log('\n=== Connecting to ClearNode ===');
  const rpc = new ClearNodeRPC();
  await rpc.connect(CLEARNODE_URL);
  console.log('✅ Connected');

  // 3. Auth Alice2 (EIP-712)
  console.log('\n=== Auth Alice2 ===');
  const {
    createAuthRequestMessage,
    createAuthVerifyMessage,
    createEIP712AuthMessageSigner,
  } = await import('@erc7824/nitrolite');
  const { generatePrivateKey } = await import('viem/accounts');
  const { createWalletClient: createWC } = await import('viem');

  const sessionKeyPrivate = generatePrivateKey();
  const sessionKeyAddress = privateKeyToAccount(sessionKeyPrivate).address;

  const authParams = {
    address: ALICE2,
    session_key: sessionKeyAddress,
    application: 'clearnode',
    allowances: [] as any[],
    expires_at: BigInt(Math.floor(Date.now() / 1000) + 86400),
    scope: 'transfer,app.create',
  };

  const authReqId = 100;
  const authReqMsg = await createAuthRequestMessage(authParams, authReqId, Date.now());
  const authChallenge = await rpc.sendRaw(authReqId, authReqMsg);
  console.log('Challenge:', JSON.stringify(authChallenge).slice(0, 100));

  const challengeMessage = authChallenge?.challenge_message || authChallenge?.challengeMessage;
  if (!challengeMessage) {
    console.error('No challenge message in response:', authChallenge);
    process.exit(1);
  }

  // EIP-712 auth verify
  const partialMessage = {
    scope: authParams.scope,
    session_key: authParams.session_key,
    expires_at: authParams.expires_at,
    allowances: authParams.allowances,
  };
  const domain = { name: authParams.application };
  const walletLikeClient = {
    account: aliceAccount,
    signTypedData: (args: any) => aliceAccount.signTypedData(args),
  } as any;
  const eip712Signer = createEIP712AuthMessageSigner(walletLikeClient, partialMessage, domain);

  const challengeResponse = {
    method: 'auth_challenge' as any,
    params: { challengeMessage },
  };
  const authVerifyId = 101;
  const authVerifyMsg = await createAuthVerifyMessage(eip712Signer, challengeResponse, authVerifyId, Date.now());
  const authResult = await rpc.sendRaw(authVerifyId, authVerifyMsg);
  console.log('✅ Auth result:', JSON.stringify(authResult).slice(0, 100));

  // 4. Get config
  console.log('\n=== Get Config ===');
  const { createGetConfigMessage } = await import('@erc7824/nitrolite');
  const config = await rpc.call(
    (s, id) => createGetConfigMessage(s, id),
    aliceSigner,
  );
  console.log('Config:', JSON.stringify(config, null, 2));

  // 5. Get assets
  console.log('\n=== Get Assets ===');
  const { createGetAssetsMessage } = await import('@erc7824/nitrolite');
  const assets = await rpc.call(
    (s, id) => createGetAssetsMessage(s, undefined, id),
    aliceSigner,
  );
  console.log('Assets:', JSON.stringify(assets, null, 2));

  // 6. Get channels for Alice2
  console.log('\n=== Get Channels (Alice2) ===');
  const { createGetChannelsMessage } = await import('@erc7824/nitrolite');
  const channels = await rpc.call(
    (s, id) => createGetChannelsMessage(s, ALICE2, undefined, id),
    aliceSigner,
  );
  console.log('Channels:', JSON.stringify(channels, null, 2));

  // 7. Get ledger balances for Alice2
  console.log('\n=== Get Ledger Balances (Alice2) ===');
  const { createGetLedgerBalancesMessage } = await import('@erc7824/nitrolite');
  const balances = await rpc.call(
    (s, id) => createGetLedgerBalancesMessage(s, undefined, id),
    aliceSigner,
  );
  console.log('Balances:', JSON.stringify(balances, null, 2));

  // ─── Parse config ───
  const USDC_MAINNET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
  const ethNetwork = config.networks.find((n: any) => n.chain_id === 1);
  if (!ethNetwork) { console.error('No Ethereum mainnet in config'); process.exit(1); }
  const CUSTODY_ADDRESS = ethNetwork.custody_address as Address;
  const ADJUDICATOR_ADDRESS = ethNetwork.adjudicator_address as Address;
  const BROKER = config.broker_address as Address;
  console.log('Custody:', CUSTODY_ADDRESS, 'Broker:', BROKER);

  const DEPOSIT_AMOUNT = 1_000000n; // 1 USDC (6 decimals)

  const { createCreateChannelMessage, createResizeChannelMessage, createAppSessionMessage } = await import('@erc7824/nitrolite');
  const { NitroliteClient, WalletStateSigner } = await import('@erc7824/nitrolite');

  const publicClient = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });

  // ─── Helper: ensure funded channel for a participant ───
  async function ensureFundedChannel(
    name: string,
    address: Address,
    key: Hex,
    account: any,
    signer: any,
  ): Promise<string> {
    console.log(`\n=== Ensure Funded Channel (${name}: ${address}) ===`);

    // Check existing open channels
    const ch = await rpc.call(
      (s, id) => createGetChannelsMessage(s, address, undefined, id),
      signer,
    );
    let openChannel = ch.channels?.find((c: any) => c.status === 'open' && c.token === USDC_MAINNET);

    if (openChannel && BigInt(openChannel.amount) >= DEPOSIT_AMOUNT) {
      console.log(`✅ Already has funded channel: ${openChannel.channel_id} (${openChannel.amount})`);
      return openChannel.channel_id;
    }

    if (!openChannel) {
      // Create channel via RPC
      console.log('Creating channel...');
      const channelResult = await rpc.call(
        (s, id) => createCreateChannelMessage(s, { chain_id: 1, token: USDC_MAINNET }, id),
        signer,
      );
      console.log('Channel created:', channelResult.channel_id);

      // On-chain deposit + create
      const walletClient = createWalletClient({ account, chain: mainnet, transport: http(ETH_RPC) });
      const nitrolite = new NitroliteClient({
        publicClient,
        walletClient,
        stateSigner: new WalletStateSigner(walletClient),
        addresses: { custody: CUSTODY_ADDRESS, adjudicator: ADJUDICATOR_ADDRESS },
        chainId: 1,
        challengeDuration: BigInt(channelResult.channel.challenge),
      });

      const createParams = {
        channel: {
          participants: channelResult.channel.participants.map((p: string) => p as Address),
          adjudicator: channelResult.channel.adjudicator as Address,
          challenge: BigInt(channelResult.channel.challenge),
          nonce: BigInt(channelResult.channel.nonce),
        },
        unsignedInitialState: {
          intent: channelResult.state.intent as number,
          version: BigInt(channelResult.state.version),
          data: (channelResult.state.state_data || '0x') as Hex,
          allocations: channelResult.state.allocations.map((a: any) => ({
            destination: a.destination as Address,
            token: a.token as Address,
            amount: BigInt(a.amount),
          })),
        },
        serverSignature: channelResult.server_signature as Hex,
      };

      console.log('On-chain deposit + create...');
      const { txHash } = await nitrolite.depositAndCreateChannel(USDC_MAINNET, DEPOSIT_AMOUNT, createParams);
      console.log('✅ On-chain tx:', txHash);

      // Wait for ClearNode to detect
      console.log('Waiting for ClearNode to detect channel...');
      for (let i = 1; i <= 24; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const updated = await rpc.call(
          (s, id) => createGetChannelsMessage(s, address, undefined, id),
          signer,
        );
        openChannel = updated.channels?.find((c: any) => c.channel_id === channelResult.channel_id && c.status === 'open');
        if (openChannel) { console.log(`✅ Detected (${i * 5}s)`); break; }
        if (i % 6 === 0) console.log(`Still waiting... (${i * 5}s)`);
      }
      if (!openChannel) throw new Error(`Channel ${channelResult.channel_id} not detected after 2 min`);
    }

    // Resize to add on-chain deposited funds to channel
    if (BigInt(openChannel.amount) < DEPOSIT_AMOUNT) {
      console.log('Resizing channel (resize_amount) to add on-chain funds...');
      const resizeResult = await rpc.call(
        (s, id) => createResizeChannelMessage(s, {
          channel_id: openChannel.channel_id as Hex,
          resize_amount: DEPOSIT_AMOUNT,
          funds_destination: address,
        }, id),
        signer,
      );
      console.log('✅ Resize result:', JSON.stringify(resizeResult, null, 2));
      // Skip on-chain resize for now — ClearNode already allocated funds off-chain
    }

    return openChannel.channel_id;
  }

  // ─── 8. Auth Bob and ensure funded channels ───
  console.log('\n=== Auth Bob ===');
  // Need to auth Bob separately (new WS connection or same with Bob's key)
  // For simplicity, auth Bob on the same connection
  const bobSessionKey = generatePrivateKey();
  const bobSessionKeyAddr = privateKeyToAccount(bobSessionKey).address;
  const bobAuthParams = {
    address: BOB,
    session_key: bobSessionKeyAddr,
    application: 'clearnode',
    allowances: [] as any[],
    expires_at: BigInt(Math.floor(Date.now() / 1000) + 86400),
    scope: 'transfer,app.create',
  };
  const bobAuthReqId = 200;
  const bobAuthReqMsg = await createAuthRequestMessage(bobAuthParams, bobAuthReqId, Date.now());
  const bobAuthChallenge = await rpc.sendRaw(bobAuthReqId, bobAuthReqMsg);
  const bobChallengeMsg = bobAuthChallenge?.challenge_message || bobAuthChallenge?.challengeMessage;

  const bobWalletLike = { account: bobAccount, signTypedData: (args: any) => bobAccount.signTypedData(args) } as any;
  const bobEip712Signer = createEIP712AuthMessageSigner(bobWalletLike, {
    scope: bobAuthParams.scope,
    session_key: bobAuthParams.session_key,
    expires_at: bobAuthParams.expires_at,
    allowances: bobAuthParams.allowances,
  }, { name: bobAuthParams.application });
  const bobAuthVerifyId = 201;
  const bobAuthVerifyMsg = await createAuthVerifyMessage(bobEip712Signer, {
    method: 'auth_challenge' as any,
    params: { challengeMessage: bobChallengeMsg },
  }, bobAuthVerifyId, Date.now());
  const bobAuthResult = await rpc.sendRaw(bobAuthVerifyId, bobAuthVerifyMsg);
  console.log('✅ Bob auth:', JSON.stringify(bobAuthResult).slice(0, 80));

  // Ensure funded channels for both
  const aliceChannelId = await ensureFundedChannel('Alice2', ALICE2, aliceKey, aliceAccount, aliceSigner);
  const bobChannelId = await ensureFundedChannel('Bob', BOB, bobKey, bobAccount, bobSigner);

  // ─── 11. Check balances after deposit ───
  console.log('\n=== Ledger Balances After ===');
  const balancesAfter = await rpc.call(
    (s, id) => createGetLedgerBalancesMessage(s, undefined, id),
    aliceSigner,
  );
  console.log('Balances:', JSON.stringify(balancesAfter, null, 2));

  // ─── 12. Create app session with allocations ───
  console.log('\n=== Create App Session (1 USDC each) ===');

  // First do the same for Bob
  // TODO: For now, test with just Alice2 allocation
  try {
    const participants = [ALICE2, BOB] as [Address, Address];
    const appSessionResult = await rpc.callCoSigned(
      (s, id) => createAppSessionMessage(s, {
        definition: {
          protocol: 'NitroRPC/0.4' as any,
          participants,
          weights: [100, 100],
          quorum: 200,
          challenge: 86400,
          nonce: Date.now(),
          application: 'custody-gateway',
        },
        allocations: [
          { asset: 'usdc', amount: String(DEPOSIT_AMOUNT), participant: ALICE2 },
          { asset: 'usdc', amount: '0', participant: BOB },
        ],
      }, id),
      aliceSigner,
      [aliceSigner, bobSigner],
    );
    console.log('App session:', JSON.stringify(appSessionResult, null, 2));
  } catch (err) {
    console.log('App session error:', (err as Error).message);
  }

  rpc.close();
  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
