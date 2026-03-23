/**
 * Fund Bob and create app session with Alice
 *
 * Alice already has 1 USDC ledger balance (channel 0xd25a).
 * Bob needs: approve USDC → depositAndCreate → resize → ledger balance.
 * Then: create_app_session with both users.
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
} from '@erc7824/nitrolite';
import type { MessageSigner } from '@erc7824/nitrolite';
import { createPublicClient, createWalletClient, http, parseAbi, type Hex, type Address } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { getPackedState } from '@erc7824/nitrolite/dist/utils/state.js';
import { custodyAbi } from '@erc7824/nitrolite/dist/abis/generated.js';

const CLEARNODE_URL = process.env.CLEARNODE_URL || 'wss://clearnet.yellow.com/ws';
const ETH_RPC = process.env.ETHEREUM_RPC_URL!;
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY!, 'hex');
const ALICE = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325' as Address;
const BOB = '0x772ddE0ba5C672b72b4FB740c2FaB5F1Bcf6Cc2C' as Address;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
const DEPOSIT = 1_000000n; // 1 USDC

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

function decrypt(enc: string, iv: string, tag: string): string {
  const d = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(enc, 'hex')), d.final()]).toString('utf8');
}

type Pending = { resolve: (r: any) => void; reject: (e: Error) => void };
class RPC {
  private ws!: WebSocket;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  async connect(url: string) {
    return new Promise<void>((res, rej) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => res());
      this.ws.on('error', rej);
      this.ws.on('message', (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString());
        if (msg.res) {
          const [id, method, result] = msg.res;
          const p = this.pending.get(id);
          if (p) { this.pending.delete(id); result?.error ? p.reject(new Error(`${method}: ${result.error}`)) : p.resolve(result); }
        }
      });
    });
  }
  sendRaw(id: number, msg: string): Promise<any> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout')); }, 30000);
      this.pending.set(id, { resolve: r => { clearTimeout(t); res(r); }, reject: e => { clearTimeout(t); rej(e); } });
      this.ws.send(msg);
    });
  }
  async call(build: (s: MessageSigner, id: number) => Promise<string>, signer: MessageSigner) {
    const id = this.nextId++;
    return this.sendRaw(id, await build(signer, id));
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
  console.log(`  Auth ${address.slice(0, 10)}...`);
}

async function waitForChannel(rpc: RPC, signer: MessageSigner, address: Address, channelId: string, status = 'open', maxSec = 120) {
  for (let i = 1; i <= maxSec / 5; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const ch = await rpc.call((s, id) => createGetChannelsMessage(s, address, undefined, id), signer);
    const found = ch.channels?.find((c: any) => c.channel_id === channelId && c.status === status);
    if (found) { console.log(`  Detected (${status}) after ${i * 5}s`); return found; }
    if (i % 6 === 0) console.log(`  Still waiting... (${i * 5}s)`);
  }
  throw new Error(`Channel ${channelId.slice(0, 14)} not ${status} after ${maxSec}s`);
}

async function fundUser(
  rpc: RPC,
  signer: MessageSigner,
  account: any,
  key: Hex,
  address: Address,
  publicClient: any,
  custody: Address,
  adjudicator: Address,
) {
  const walletClient = createWalletClient({ account, chain: mainnet, transport: http(ETH_RPC) });

  // 1. Approve USDC for Custody (if needed)
  const allowance = await publicClient.readContract({
    address: USDC, abi: ERC20_ABI, functionName: 'allowance',
    args: [address, custody],
  });
  if (allowance < DEPOSIT) {
    console.log('  Approving USDC...');
    const approveTx = await walletClient.writeContract({
      address: USDC, abi: ERC20_ABI, functionName: 'approve',
      args: [custody, DEPOSIT * 100n], // approve extra for future
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log('  Approved');
  }

  // 2. create_channel RPC
  console.log('  create_channel...');
  const chResult = await rpc.call(
    (s, id) => createCreateChannelMessage(s, { chain_id: 1, token: USDC }, id),
    signer,
  );
  const channelId = chResult.channel_id as Hex;
  console.log(`  channel_id: ${channelId.slice(0, 14)}...`);

  // 3. On-chain depositAndCreateChannel
  console.log('  on-chain depositAndCreate...');
  const nitrolite = new NitroliteClient({
    publicClient, walletClient,
    stateSigner: new WalletStateSigner(walletClient),
    addresses: { custody, adjudicator },
    chainId: 1, challengeDuration: BigInt(chResult.channel.challenge),
  });

  const createParams = {
    channel: {
      participants: chResult.channel.participants.map((p: string) => p as Address),
      adjudicator: chResult.channel.adjudicator as Address,
      challenge: BigInt(chResult.channel.challenge),
      nonce: BigInt(chResult.channel.nonce),
    },
    unsignedInitialState: {
      intent: chResult.state.intent as number,
      version: BigInt(chResult.state.version),
      data: (chResult.state.state_data || '0x') as Hex,
      allocations: chResult.state.allocations.map((a: any) => ({
        destination: a.destination as Address,
        token: a.token as Address,
        amount: BigInt(a.amount),
      })),
    },
    serverSignature: chResult.server_signature as Hex,
  };

  const { txHash: createTx } = await nitrolite.depositAndCreateChannel(USDC, DEPOSIT, createParams);
  console.log(`  tx: ${createTx}`);
  await publicClient.waitForTransactionReceipt({ hash: createTx });

  // 4. Wait for ClearNode
  console.log('  waiting for ClearNode...');
  await waitForChannel(rpc, signer, address, channelId);

  // 5. resize_channel RPC
  console.log('  resize_channel...');
  const resizeResult = await rpc.call(
    (s, id) => createResizeChannelMessage(s, {
      channel_id: channelId,
      resize_amount: DEPOSIT,
      funds_destination: address,
    }, id),
    signer,
  );
  const serverSig = resizeResult.server_signature as Hex;

  // 6. On-chain resize with proof
  console.log('  on-chain resize...');
  const chainData = await nitrolite.getChannelData(channelId);
  const initProof = {
    intent: chainData.lastValidState.intent,
    version: chainData.lastValidState.version,
    data: chainData.lastValidState.data as Hex,
    allocations: chainData.lastValidState.allocations.map((a: any) => ({
      destination: a.destination as Address,
      token: a.token as Address,
      amount: a.amount,
    })),
    sigs: [...chainData.lastValidState.sigs] as Hex[],
  };

  const rs = resizeResult.state;
  const unsignedResize = {
    intent: rs.intent as number,
    version: BigInt(rs.version),
    data: (rs.state_data || '0x') as Hex,
    allocations: rs.allocations.map((a: any) => ({
      destination: a.destination as Address,
      token: a.token as Address,
      amount: BigInt(a.amount),
    })),
  };
  const packed = getPackedState(channelId, unsignedResize);
  const userSig = await account.signMessage({ message: { raw: packed } });

  const { request } = await publicClient.simulateContract({
    address: custody, abi: custodyAbi, functionName: 'resize',
    args: [channelId, { ...unsignedResize, sigs: [userSig, serverSig] }, [initProof]],
    account,
  });
  const resizeTx = await walletClient.writeContract(request);
  console.log(`  resize tx: ${resizeTx}`);
  await publicClient.waitForTransactionReceipt({ hash: resizeTx });
  console.log('  Resize confirmed');

  // 7. Wait for ledger update
  console.log('  waiting for ledger...');
  for (let i = 1; i <= 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const bal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), signer);
    if (bal.ledger_balances?.length > 0) {
      console.log(`  Ledger updated after ${i * 5}s:`, JSON.stringify(bal));
      return channelId;
    }
    if (i % 4 === 0) console.log(`  Still waiting... (${i * 5}s)`);
  }
  console.log('  WARNING: ledger still empty after 60s');
  return channelId;
}

async function main() {
  const prisma = new PrismaClient();
  const aliceRow = await prisma.managedKey.findUnique({ where: { address: ALICE } });
  const bobRow = await prisma.managedKey.findUnique({ where: { address: BOB } });
  await prisma.$disconnect();
  const aliceKey = decrypt(aliceRow!.encryptedKey, aliceRow!.iv, aliceRow!.tag) as Hex;
  const bobKey = decrypt(bobRow!.encryptedKey, bobRow!.iv, bobRow!.tag) as Hex;
  const aliceAccount = privateKeyToAccount(aliceKey);
  const bobAccount = privateKeyToAccount(bobKey);
  const aliceSigner = createECDSAMessageSigner(aliceKey);
  const bobSigner = createECDSAMessageSigner(bobKey);
  const publicClient = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });

  // Get config
  const rpcConf = new RPC();
  await rpcConf.connect(CLEARNODE_URL);
  await authUser(rpcConf, ALICE, aliceAccount);
  const config = await rpcConf.call((s, id) => createGetConfigMessage(s, id), aliceSigner);
  const ethNetwork = config.networks?.find((n: any) => n.chain_id === 1);
  const CUSTODY = ethNetwork!.custody_address as Address;
  const ADJUDICATOR = ethNetwork!.adjudicator_address as Address;
  console.log(`Custody: ${CUSTODY}\n`);

  // Check Alice's current ledger
  const aliceLedger = await rpcConf.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  console.log('Alice ledger now:', JSON.stringify(aliceLedger));
  rpcConf.close();

  // ─── Fund Bob ─────────────────────────────────────────────────
  console.log('\n=== Fund Bob ===');
  const rpcBob = new RPC();
  await rpcBob.connect(CLEARNODE_URL);
  await authUser(rpcBob, BOB, bobAccount);
  await fundUser(rpcBob, bobSigner, bobAccount, bobKey, BOB, publicClient, CUSTODY, ADJUDICATOR);
  rpcBob.close();

  // ─── Create App Session ──────────────────────────────────────
  console.log('\n=== Create App Session ===');
  const rpcSession = new RPC();
  await rpcSession.connect(CLEARNODE_URL);
  await authUser(rpcSession, ALICE, aliceAccount);

  // Check both ledgers
  const alBal = await rpcSession.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  console.log('Alice ledger:', JSON.stringify(alBal));

  // Auth Bob on same connection for co-signed app session
  // Actually, let's try with just Alice's sig first
  console.log('  Creating app session...');
  try {
    const appResult = await rpcSession.call(
      (s, id) => createAppSessionMessage(s, {
        participants: [ALICE, BOB],
        allocations: [
          { destination: ALICE, token: USDC, amount: Number(DEPOSIT) },
          { destination: BOB, token: USDC, amount: Number(DEPOSIT) },
        ],
      }, id),
      aliceSigner,
    );
    console.log('  App session result:', JSON.stringify(appResult, null, 2));
  } catch (e) {
    console.log('  App session error:', (e as Error).message);
    console.log('  Trying with co-signed message (Alice + Bob)...');

    // Need to manually co-sign: build message, then add both sigs
    const id = 999;
    const msg = await createAppSessionMessage(aliceSigner, {
      participants: [ALICE, BOB],
      allocations: [
        { destination: ALICE, token: USDC, amount: Number(DEPOSIT) },
        { destination: BOB, token: USDC, amount: Number(DEPOSIT) },
      ],
    }, id);
    const parsed = JSON.parse(msg);
    const bobSigForReq = await bobSigner(parsed.req);
    parsed.sig = [parsed.sig[0], bobSigForReq];
    try {
      const result = await rpcSession.sendRaw(id, JSON.stringify(parsed));
      console.log('  Co-signed app session result:', JSON.stringify(result, null, 2));
    } catch (e2) {
      console.log('  Co-signed error:', (e2 as Error).message);
    }
  }

  rpcSession.close();
  console.log('\nDone!');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
