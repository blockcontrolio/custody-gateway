/**
 * Continue from existing channel 0x97e1... — resize, de-allocate, session.
 */
import WebSocket from 'ws';
import {
  createECDSAMessageSigner,
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createGetChannelsMessage,
  createGetLedgerBalancesMessage,
  createResizeChannelMessage,
  createAppSessionMessage,
  RPCProtocolVersion,
} from '@erc7824/nitrolite';
import type { MessageSigner } from '@erc7824/nitrolite';
import { createPublicClient, createWalletClient, http, type Hex, type Address } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { custodyAbi } from '@erc7824/nitrolite/dist/abis/generated.js';
import { getPackedState } from '@erc7824/nitrolite/dist/utils/state.js';

const CLEARNODE_URL = process.env.CLEARNODE_URL || 'wss://clearnet.yellow.com/ws';
const ETH_RPC = process.env.ETHEREUM_RPC_URL!;
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY!, 'hex');
const ALICE = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325' as Address;
const BOB = '0x772ddE0ba5C672b72b4FB740c2FaB5F1Bcf6Cc2C' as Address;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
const CUSTODY = '0x6F71a38d919ad713D0AfE0eB712b95064Fc2616f' as Address;
const DEPOSIT = 1_000000n;

function decrypt(enc: string, iv: string, tag: string): string {
  const d = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(enc, 'hex')), d.final()]).toString('utf8');
}

type P = { resolve: (r: any) => void; reject: (e: Error) => void };
class RPC {
  private ws!: WebSocket;
  private pending = new Map<number, P>();
  private nextId = 1;
  async connect(url: string) {
    return new Promise<void>((res, rej) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => res());
      this.ws.on('error', rej);
      this.ws.on('ping', () => this.ws.pong());
      this.ws.on('message', (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString());
        if (msg.req) {
          const [id, method] = msg.req;
          if (method === 'ping') {
            this.ws.send(JSON.stringify({ res: [id, 'pong', {}, Date.now()] }));
            return;
          }
        }
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
  async callCoSigned(build: (s: MessageSigner, id: number) => Promise<string>, primary: MessageSigner, cosigners: MessageSigner[]) {
    const id = this.nextId++;
    const msg = await build(primary, id);
    const parsed = JSON.parse(msg);
    const sigs = [parsed.sig[0]];
    for (const cs of cosigners) sigs.push(await cs(parsed.req));
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
}

async function onchainResize(account: any, publicClient: any, walletClient: any, channelId: Hex, resizeState: any, serverSig: Hex) {
  const chainData = await publicClient.readContract({
    address: CUSTODY, abi: custodyAbi, functionName: 'getChannelData', args: [channelId],
  }) as any;
  const lastState = chainData[4];
  const initProof = {
    intent: Number(lastState.intent), version: lastState.version,
    data: lastState.data as Hex,
    allocations: lastState.allocations.map((a: any) => ({ destination: a.destination as Address, token: a.token as Address, amount: a.amount })),
    sigs: [...lastState.sigs] as Hex[],
  };
  const unsignedResize = {
    intent: resizeState.intent as number, version: BigInt(resizeState.version),
    data: (resizeState.state_data || '0x') as Hex,
    allocations: resizeState.allocations.map((a: any) => ({ destination: a.destination as Address, token: a.token as Address, amount: BigInt(a.amount) })),
  };
  const packed = getPackedState(channelId, unsignedResize);
  const userSig = await account.signMessage({ message: { raw: packed } });
  const { request } = await publicClient.simulateContract({
    address: CUSTODY, abi: custodyAbi, functionName: 'resize',
    args: [channelId, { ...unsignedResize, sigs: [userSig, serverSig] }, [initProof]],
    account,
  });
  return await walletClient.writeContract(request);
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
  const aliceWC = createWalletClient({ account: aliceAccount, chain: mainnet, transport: http(ETH_RPC) });

  const rpc = new RPC();
  await rpc.connect(CLEARNODE_URL);
  await authUser(rpc, ALICE, aliceAccount);

  // Check current state
  const ch = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
  const bal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  console.log('Ledger:', JSON.stringify(bal));
  for (const c of ch.channels?.filter((c: any) => c.status !== 'closed') || []) {
    console.log(`Channel: ${c.channel_id.slice(0, 20)}... status=${c.status} amount=${c.amount}`);
  }

  const openCh = ch.channels?.find((c: any) => c.status === 'open');
  if (!openCh) {
    console.log('No open channel found');
    rpc.close();
    return;
  }

  const channelId = openCh.channel_id as Hex;
  console.log(`\nUsing channel: ${channelId}`);
  console.log(`  status=${openCh.status} amount=${openCh.amount}`);

  if (BigInt(openCh.amount) === 0n) {
    // Need to resize first
    console.log('\n=== Resize: add funds ===');
    const resize1 = await rpc.call(
      (s, id) => createResizeChannelMessage(s, {
        channel_id: channelId, resize_amount: DEPOSIT, funds_destination: ALICE,
      }, id),
      aliceSigner,
    );
    console.log('Resize state allocations:', JSON.stringify(resize1.state.allocations));

    const tx1 = await onchainResize(aliceAccount, publicClient, aliceWC, channelId, resize1.state, resize1.server_signature as Hex);
    console.log('On-chain resize tx:', tx1);
    await publicClient.waitForTransactionReceipt({ hash: tx1 });
    console.log('Confirmed');

    // Poll for channel to return to open
    console.log('Waiting for channel to process...');
    for (let i = 1; i <= 30; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const ch2 = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
      const found = ch2.channels?.find((c: any) => c.channel_id === channelId);
      const bal2 = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
      const ledgerAmt = bal2.ledger_balances?.find((b: any) => b.asset === 'usdc')?.amount || '0';
      if (i % 2 === 0) console.log(`  ${i * 5}s: ch.status=${found?.status} ch.amount=${found?.amount} ledger=${ledgerAmt}`);
      if (found?.status === 'open') {
        console.log(`  Channel back to open after ${i * 5}s`);
        break;
      }
    }
  }

  // Check state before de-allocate
  const ch3 = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
  const found3 = ch3.channels?.find((c: any) => c.channel_id === channelId);
  const bal3 = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  console.log(`\nBefore de-allocate: ch.status=${found3?.status} ch.amount=${found3?.amount} ledger=${JSON.stringify(bal3)}`);

  if (found3?.status === 'open' && BigInt(found3.amount) > 0n) {
    // De-allocate
    console.log('\n=== Resize: de-allocate ===');
    try {
      const resize2 = await rpc.call(
        (s, id) => createResizeChannelMessage(s, {
          channel_id: channelId, allocate_amount: -DEPOSIT, funds_destination: ALICE,
        }, id),
        aliceSigner,
      );
      console.log('De-allocate state allocations:', JSON.stringify(resize2.state.allocations));

      const tx2 = await onchainResize(aliceAccount, publicClient, aliceWC, channelId, resize2.state, resize2.server_signature as Hex);
      console.log('On-chain de-allocate tx:', tx2);
      await publicClient.waitForTransactionReceipt({ hash: tx2 });
      console.log('Confirmed');

      // Poll for channel to return to open with 0 amount
      console.log('Waiting for channel to process de-allocation...');
      for (let i = 1; i <= 30; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const ch4 = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
        const found4 = ch4.channels?.find((c: any) => c.channel_id === channelId);
        const bal4 = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
        const ledgerAmt = bal4.ledger_balances?.find((b: any) => b.asset === 'usdc')?.amount || '0';
        if (i % 2 === 0) console.log(`  ${i * 5}s: ch.status=${found4?.status} ch.amount=${found4?.amount} ledger=${ledgerAmt}`);
        if (found4?.status === 'open' && BigInt(found4?.amount || '1') === 0n) {
          console.log(`  Channel de-allocated after ${i * 5}s`);
          break;
        }
      }
    } catch (e) {
      console.log('De-allocate error:', (e as Error).message);
    }
  } else if (found3?.status === 'resizing') {
    console.log('Channel still resizing, waiting more...');
    for (let i = 1; i <= 30; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const ch4 = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
      const found4 = ch4.channels?.find((c: any) => c.channel_id === channelId);
      if (i % 2 === 0) console.log(`  ${i * 5}s: status=${found4?.status} amount=${found4?.amount}`);
      if (found4?.status === 'open') break;
    }
  }

  // Final check + try session
  console.log('\n=== Final state ===');
  const finalCh = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
  const finalBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  console.log('Ledger:', JSON.stringify(finalBal));
  for (const c of finalCh.channels?.filter((c: any) => c.status !== 'closed') || []) {
    console.log(`Channel: ${c.channel_id.slice(0, 20)}... status=${c.status} amount=${c.amount}`);
  }

  console.log('\n=== Try app session ===');
  await authUser(rpc, BOB, bobAccount);
  try {
    const result = await rpc.callCoSigned(
      (s, id) => createAppSessionMessage(s, {
        definition: {
          application: 'custody-gateway',
          protocol: RPCProtocolVersion.NitroRPC_0_4,
          participants: [ALICE, BOB] as Hex[],
          weights: [1, 1],
          quorum: 2,
          challenge: 3600,
          nonce: Date.now(),
        },
        allocations: [
          { asset: 'usdc', amount: '1', participant: ALICE },
          { asset: 'usdc', amount: '0', participant: BOB },
        ],
      }, id),
      aliceSigner, [bobSigner],
    );
    console.log('SESSION CREATED:', result.app_session_id);
  } catch (e) {
    console.log('Session error:', (e as Error).message);
  }

  rpc.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
