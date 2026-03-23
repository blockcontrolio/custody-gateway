/**
 * Full flow: fund channels for Alice and Bob, then create app session.
 *
 * Alice: 1 USDC already in Custody → createChannel (no deposit) → resize → ledger
 * Bob:   0 in Custody, 5 in wallet → depositAndCreateChannel → resize → ledger
 * Then: create_app_session with 1 USDC each
 */
import WebSocket from 'ws';
import {
  createECDSAMessageSigner,
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createGetConfigMessage,
  createGetChannelsMessage,
  createGetLedgerBalancesMessage,
  createCreateChannelMessage,
  createResizeChannelMessage,
  createAppSessionMessage,
  NitroliteClient,
  WalletStateSigner,
  RPCProtocolVersion,
} from '@erc7824/nitrolite';
import type { MessageSigner } from '@erc7824/nitrolite';
import { createPublicClient, createWalletClient, http, type Hex, type Address } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const CLEARNODE_URL = process.env.CLEARNODE_URL || 'wss://clearnet.yellow.com/ws';
const ETH_RPC = process.env.ETHEREUM_RPC_URL!;
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY!, 'hex');
const ALICE2 = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325' as Address;
const BOB = '0x772ddE0ba5C672b72b4FB740c2FaB5F1Bcf6Cc2C' as Address;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
const DEPOSIT = 1_000000n; // 1 USDC

function decrypt(encrypted: string, iv: string, tag: string): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString('utf8');
}

// ─── RPC helper ──────────────────────────────────────────────────────────────

type Pending = { resolve: (r: any) => void; reject: (e: Error) => void };

class RPC {
  private ws!: WebSocket;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  async connect(url: string) {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (data: WebSocket.Data) => {
        const text = data.toString();
        const msg = JSON.parse(text);
        if (msg.res) {
          const [id, method, result] = msg.res;
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            if (result?.error) {
              console.log(`  [RPC ERROR] id=${id} method=${method} error=${JSON.stringify(result.error)}`);
              p.reject(new Error(`${method}: ${result.error}`));
            } else {
              p.resolve(result);
            }
          }
        } else if (!msg.req) {
          // Notification or unknown format
          console.log(`  [MSG] ${text.slice(0, 200)}`);
        }
      });
    });
  }

  sendRaw(id: number, msg: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')); }, 30000);
      this.pending.set(id, {
        resolve: r => { clearTimeout(t); resolve(r); },
        reject: e => { clearTimeout(t); reject(e); },
      });
      this.ws.send(msg);
    });
  }

  async call(build: (s: MessageSigner, id: number) => Promise<string>, signer: MessageSigner) {
    const id = this.nextId++;
    const msg = await build(signer, id);
    return this.sendRaw(id, msg);
  }

  async callCoSigned(build: (s: MessageSigner, id: number) => Promise<string>, primary: MessageSigner, all: MessageSigner[]) {
    const id = this.nextId++;
    const msg = await build(primary, id);
    const parsed = JSON.parse(msg) as { req: unknown; sig: Hex[] };
    const sigs: Hex[] = [];
    for (const s of all) sigs.push(await s(parsed.req as any));
    parsed.sig = sigs;
    return this.sendRaw(id, JSON.stringify(parsed));
  }

  close() { this.ws?.close(); }
}

async function authUser(rpc: RPC, address: Address, account: any) {
  const sk = generatePrivateKey();
  const skAddr = privateKeyToAccount(sk).address;
  const params = { address, session_key: skAddr, application: 'clearnode', allowances: [] as any[], expires_at: BigInt(Math.floor(Date.now() / 1000) + 86400), scope: 'console' };
  const reqId = Math.floor(Math.random() * 1000000);
  const reqMsg = await createAuthRequestMessage(params, reqId, Date.now());
  const challenge = await rpc.sendRaw(reqId, reqMsg);
  const cm = challenge?.challenge_message || challenge?.challengeMessage;
  const wc = { account, signTypedData: (args: any) => account.signTypedData(args) } as any;
  const eip712 = createEIP712AuthMessageSigner(wc, { scope: params.scope, session_key: params.session_key, expires_at: params.expires_at, allowances: params.allowances }, { name: params.application });
  const vId = reqId + 1;
  const vMsg = await createAuthVerifyMessage(eip712, { method: 'auth_challenge' as any, params: { challengeMessage: cm } }, vId, Date.now());
  await rpc.sendRaw(vId, vMsg);
  console.log(`✅ Auth ${address.slice(0, 10)}...`);
}

async function waitForChannel(rpc: RPC, signer: MessageSigner, address: Address, channelId: string, maxWaitSec = 120): Promise<any> {
  console.log(`  Waiting for ClearNode to detect channel ${channelId.slice(0, 14)}...`);
  for (let i = 1; i <= maxWaitSec / 5; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const ch = await rpc.call((s, id) => createGetChannelsMessage(s, address, undefined, id), signer);
    const found = ch.channels?.find((c: any) => c.channel_id === channelId && c.status === 'open');
    if (found) {
      console.log(`  ✅ Detected after ${i * 5}s (amount=${found.amount})`);
      return found;
    }
    if (i % 6 === 0) console.log(`  Still waiting... (${i * 5}s)`);
  }
  throw new Error(`Channel ${channelId} not detected after ${maxWaitSec}s`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Load keys
  const prisma = new PrismaClient();
  const aliceRow = await prisma.managedKey.findUnique({ where: { address: ALICE2 } });
  const bobRow = await prisma.managedKey.findUnique({ where: { address: BOB } });
  await prisma.$disconnect();
  const aliceKey = decrypt(aliceRow!.encryptedKey, aliceRow!.iv, aliceRow!.tag) as Hex;
  const bobKey = decrypt(bobRow!.encryptedKey, bobRow!.iv, bobRow!.tag) as Hex;
  const aliceAccount = privateKeyToAccount(aliceKey);
  const bobAccount = privateKeyToAccount(bobKey);
  const aliceSigner = createECDSAMessageSigner(aliceKey);
  const bobSigner = createECDSAMessageSigner(bobKey);

  const publicClient = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });

  // Connect and auth — only Alice first (Bob later, to avoid session conflicts)
  const rpc = new RPC();
  await rpc.connect(CLEARNODE_URL);
  console.log('Connected');
  await authUser(rpc, ALICE2, aliceAccount);
  // NOTE: Bob auth deferred until needed

  // Get config
  const config = await rpc.call((s, id) => createGetConfigMessage(s, id), aliceSigner);
  const ethNetwork = config.networks?.find((n: any) => n.chain_id === 1);
  const CUSTODY = ethNetwork!.custody_address as Address;
  const ADJUDICATOR = ethNetwork!.adjudicator_address as Address;
  console.log(`Custody: ${CUSTODY}`);

  // Check existing channels (Alice only for now)
  const aliceCh = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE2, undefined, id), aliceSigner);
  const aliceOpen = aliceCh.channels?.find((c: any) => c.status === 'open');
  console.log(`Alice open channel: ${aliceOpen ? aliceOpen.channel_id.slice(0, 14) + '... amount=' + aliceOpen.amount : 'NONE'}`);
  const aliceBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  console.log(`Alice ledger: ${JSON.stringify(aliceBal.ledger_balances)}`);

  // ─── STEP 1: Fund Alice's channel ───────────────────────────────────────────
  let aliceChannelId: string;
  const aliceHasLedger = (aliceBal.ledger_balances?.length ?? 0) > 0;

  if (aliceHasLedger) {
    console.log('\n✅ Alice already has ledger balance, skipping channel creation');
    aliceChannelId = aliceOpen?.channel_id;
  } else if (aliceOpen && BigInt(aliceOpen.amount) >= DEPOSIT) {
    console.log('\n✅ Alice already has funded open channel, skipping');
    aliceChannelId = aliceOpen.channel_id;
  } else {
    console.log('\n=== STEP 1: Create + Fund Alice channel ===');

    // create_channel RPC
    console.log('1a. create_channel RPC...');
    const channelResult = await rpc.call(
      (s, id) => createCreateChannelMessage(s, { chain_id: 1, token: USDC }, id),
      aliceSigner,
    );
    aliceChannelId = channelResult.channel_id;
    console.log(`  channel_id: ${aliceChannelId}`);
    console.log(`  channel: ${JSON.stringify(channelResult.channel)}`);
    console.log(`  state allocations: ${JSON.stringify(channelResult.state?.allocations)}`);

    // Alice has 1 USDC in Custody already, so use createChannel (no new deposit)
    // But depositAndCreateChannel with 0 amount should also work
    console.log('1b. On-chain createChannel (using existing Custody balance)...');
    const aliceWalletClient = createWalletClient({ account: aliceAccount, chain: mainnet, transport: http(ETH_RPC) });
    const nitrolite = new NitroliteClient({
      publicClient,
      walletClient: aliceWalletClient,
      stateSigner: new WalletStateSigner(aliceWalletClient),
      addresses: { custody: CUSTODY, adjudicator: ADJUDICATOR },
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

    try {
      const { txHash, channelId } = await nitrolite.createChannel(createParams);
      console.log(`  ✅ On-chain tx: ${txHash}`);
      console.log(`  channelId: ${channelId}`);
    } catch (err) {
      console.log(`  createChannel failed: ${(err as Error).message}`);
      console.log('  Trying depositAndCreateChannel with 0 amount...');
      const { txHash } = await nitrolite.depositAndCreateChannel(USDC, 0n, createParams);
      console.log(`  ✅ On-chain tx: ${txHash}`);
    }

    // Wait for ClearNode to detect
    console.log('1c. Waiting for ClearNode...');
    await waitForChannel(rpc, aliceSigner, ALICE2, aliceChannelId);

    // Resize to move Custody balance to ledger
    console.log('1d. resize_channel RPC...');
    const resizeResult = await rpc.call(
      (s, id) => createResizeChannelMessage(s, {
        channel_id: aliceChannelId as Hex,
        resize_amount: DEPOSIT,
        funds_destination: ALICE2,
      }, id),
      aliceSigner,
    );
    console.log(`  ✅ Resize result: ${JSON.stringify(resizeResult).slice(0, 200)}`);
  }

  // ─── STEP 2: Fund Bob's channel ────────────────────────────────────────────
  // Auth Bob now (after Alice's channel is set up)
  await authUser(rpc, BOB, bobAccount);
  const bobCh = await rpc.call((s, id) => createGetChannelsMessage(s, BOB, undefined, id), bobSigner);
  const bobOpen = bobCh.channels?.find((c: any) => c.status === 'open');
  const bobBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), bobSigner);

  let bobChannelId: string;
  const bobHasLedger = (bobBal.ledger_balances?.length ?? 0) > 0;

  if (bobHasLedger) {
    console.log('\n✅ Bob already has ledger balance, skipping channel creation');
    bobChannelId = bobOpen?.channel_id;
  } else if (bobOpen && BigInt(bobOpen.amount) >= DEPOSIT) {
    console.log('\n✅ Bob already has funded open channel, skipping');
    bobChannelId = bobOpen.channel_id;
  } else {
    console.log('\n=== STEP 2: Create + Fund Bob channel ===');

    // create_channel RPC
    console.log('2a. create_channel RPC...');
    const channelResult = await rpc.call(
      (s, id) => createCreateChannelMessage(s, { chain_id: 1, token: USDC }, id),
      bobSigner,
    );
    bobChannelId = channelResult.channel_id;
    console.log(`  channel_id: ${bobChannelId}`);

    // Bob needs deposit — use depositAndCreateChannel
    console.log('2b. On-chain depositAndCreateChannel (1 USDC)...');
    const bobWalletClient = createWalletClient({ account: bobAccount, chain: mainnet, transport: http(ETH_RPC) });
    const nitrolite = new NitroliteClient({
      publicClient,
      walletClient: bobWalletClient,
      stateSigner: new WalletStateSigner(bobWalletClient),
      addresses: { custody: CUSTODY, adjudicator: ADJUDICATOR },
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

    const { txHash } = await nitrolite.depositAndCreateChannel(USDC, DEPOSIT, createParams);
    console.log(`  ✅ On-chain tx: ${txHash}`);

    // Wait for ClearNode
    console.log('2c. Waiting for ClearNode...');
    await waitForChannel(rpc, bobSigner, BOB, bobChannelId);

    // Resize
    console.log('2d. resize_channel RPC...');
    const resizeResult = await rpc.call(
      (s, id) => createResizeChannelMessage(s, {
        channel_id: bobChannelId as Hex,
        resize_amount: DEPOSIT,
        funds_destination: BOB,
      }, id),
      bobSigner,
    );
    console.log(`  ✅ Resize result: ${JSON.stringify(resizeResult).slice(0, 200)}`);
  }

  // ─── STEP 3: Verify ledger balances ─────────────────────────────────────────
  console.log('\n=== STEP 3: Verify ledger balances ===');
  const aliceBalAfter = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  const bobBalAfter = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), bobSigner);
  console.log(`Alice ledger: ${JSON.stringify(aliceBalAfter)}`);
  console.log(`Bob ledger:   ${JSON.stringify(bobBalAfter)}`);

  // ─── STEP 4: Create app session ─────────────────────────────────────────────
  console.log('\n=== STEP 4: Create app session (1 USDC each) ===');
  try {
    const result = await rpc.callCoSigned(
      (s, id) => createAppSessionMessage(s, {
        definition: {
          protocol: RPCProtocolVersion.NitroRPC_0_4,
          participants: [ALICE2, BOB],
          weights: [100, 100],
          quorum: 200,
          challenge: 86400,
          nonce: Date.now(),
          application: 'custody-gateway',
        },
        allocations: [
          { asset: 'usdc', amount: String(DEPOSIT), participant: ALICE2 },
          { asset: 'usdc', amount: String(DEPOSIT), participant: BOB },
        ],
      }, id),
      aliceSigner,
      [aliceSigner, bobSigner],
    );
    console.log('✅ App session created!');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.log('❌ App session error:', (err as Error).message);
  }

  // Final balances
  console.log('\n=== Final ledger balances ===');
  const aliceFinal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  const bobFinal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), bobSigner);
  console.log(`Alice: ${JSON.stringify(aliceFinal)}`);
  console.log(`Bob:   ${JSON.stringify(bobFinal)}`);

  rpc.close();
  console.log('\nDone.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
