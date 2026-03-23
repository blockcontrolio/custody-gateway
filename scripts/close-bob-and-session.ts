/**
 * 1. Close Bob's stuck resizing channel
 * 2. Try create_app_session
 */
import WebSocket from 'ws';
import {
  createECDSAMessageSigner,
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createGetChannelsMessage,
  createGetLedgerBalancesMessage,
  createCloseChannelMessage,
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
const CUSTODY = '0x6F71a38d919ad713D0AfE0eB712b95064Fc2616f' as Address;

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
}

async function onchainClose(rpc: RPC, signer: MessageSigner, account: any, channelId: Hex, fundsAddr: Address, publicClient: any, walletClient: any) {
  const closeResult = await rpc.call(
    (s, id) => createCloseChannelMessage(s, channelId, fundsAddr, id),
    signer,
  );
  const closeState = closeResult.state;
  const serverSig = closeResult.server_signature as Hex;
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
  const unsignedClose = {
    intent: closeState.intent as number, version: BigInt(closeState.version),
    data: (closeState.state_data || '0x') as Hex,
    allocations: closeState.allocations.map((a: any) => ({ destination: a.destination as Address, token: a.token as Address, amount: BigInt(a.amount) })),
  };
  const packed = getPackedState(channelId, unsignedClose);
  const userSig = await account.signMessage({ message: { raw: packed } });
  const { request } = await publicClient.simulateContract({
    address: CUSTODY, abi: custodyAbi, functionName: 'close',
    args: [channelId, { ...unsignedClose, sigs: [userSig, serverSig] }, [initProof]],
    account,
  });
  const txHash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
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
  const bobWC = createWalletClient({ account: bobAccount, chain: mainnet, transport: http(ETH_RPC) });

  // 1. Close Bob's stuck resizing channel
  console.log('=== Close Bob resizing channel ===');
  const rpc1 = new RPC();
  await rpc1.connect(CLEARNODE_URL);
  await authUser(rpc1, BOB, bobAccount);

  const bobCh = await rpc1.call((s, id) => createGetChannelsMessage(s, BOB, undefined, id), bobSigner);
  for (const c of bobCh.channels?.filter((c: any) => c.status === 'resizing') || []) {
    const chId = c.channel_id as Hex;
    console.log(`  Closing ${chId.slice(0, 14)}...`);
    try {
      // Check if on-chain
      const data = await publicClient.readContract({
        address: CUSTODY, abi: custodyAbi, functionName: 'getChannelData', args: [chId],
      }) as any;
      if (data[1] === 0) {
        console.log('  Not on-chain, skip');
        continue;
      }
      const tx = await onchainClose(rpc1, bobSigner, bobAccount, chId, BOB, publicClient, bobWC);
      console.log(`  Closed: ${tx}`);
    } catch (e) {
      console.log(`  Error: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  rpc1.close();

  // Wait for ClearNode
  await new Promise(r => setTimeout(r, 10000));

  // 2. Create app session
  console.log('\n=== Create App Session ===');
  const rpc2 = new RPC();
  await rpc2.connect(CLEARNODE_URL);
  await authUser(rpc2, ALICE, aliceAccount);

  const sessionParams = {
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
      { asset: 'usdc', amount: '0', participant: ALICE },
      { asset: 'usdc', amount: '0', participant: BOB },
    ],
  };

  const id = 42;
  const msg = await createAppSessionMessage(aliceSigner, sessionParams, id);
  const parsed = JSON.parse(msg);
  const bobSigForReq = await bobSigner(parsed.req);
  parsed.sig = [parsed.sig[0], bobSigForReq];

  try {
    const result = await rpc2.sendRaw(id, JSON.stringify(parsed));
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (e) {
    console.log('Error:', (e as Error).message);
  }

  rpc2.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
