/**
 * On-chain close all stuck "resizing" channels
 * Uses close state from close_channel RPC + on-chain close() with proof
 */
import WebSocket from 'ws';
import {
  createECDSAMessageSigner,
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createGetChannelsMessage,
  createCloseChannelMessage,
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

async function main() {
  const prisma = new PrismaClient();
  const aliceRow = await prisma.managedKey.findUnique({ where: { address: ALICE } });
  await prisma.$disconnect();
  const aliceKey = decrypt(aliceRow!.encryptedKey, aliceRow!.iv, aliceRow!.tag) as Hex;
  const aliceAccount = privateKeyToAccount(aliceKey);
  const aliceSigner = createECDSAMessageSigner(aliceKey);
  const publicClient = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });
  const aliceWC = createWalletClient({ account: aliceAccount, chain: mainnet, transport: http(ETH_RPC) });

  const rpc = new RPC();
  await rpc.connect(CLEARNODE_URL);
  await authUser(rpc, ALICE, aliceAccount);

  const channels = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
  const resizing = channels.channels?.filter((c: any) => c.status === 'resizing') || [];
  console.log(`Closing ${resizing.length} resizing channels on-chain\n`);

  for (const ch of resizing) {
    const channelId = ch.channel_id as Hex;
    console.log(`Channel: ${channelId.slice(0, 14)}...`);

    try {
      // Get close state from ClearNode
      const closeResult = await rpc.call(
        (s, id) => createCloseChannelMessage(s, channelId, ALICE, id),
        aliceSigner,
      );
      const closeState = closeResult.state;
      const serverSig = closeResult.server_signature as Hex;

      // Get on-chain initial state for proof
      const chainData = await publicClient.readContract({
        address: CUSTODY, abi: custodyAbi, functionName: 'getChannelData',
        args: [channelId],
      }) as any;
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

      // Build close candidate
      const allocations = closeState.allocations.map((a: any) => ({
        destination: a.destination as Address,
        token: a.token as Address,
        amount: BigInt(a.amount),
      }));
      const unsignedClose = {
        intent: closeState.intent as number,
        version: BigInt(closeState.version),
        data: (closeState.state_data || '0x') as Hex,
        allocations,
      };
      const packed = getPackedState(channelId, unsignedClose);
      const aliceSig = await aliceAccount.signMessage({ message: { raw: packed } });

      const candidate = { ...unsignedClose, sigs: [aliceSig, serverSig] };

      // On-chain close
      const { request } = await publicClient.simulateContract({
        address: CUSTODY, abi: custodyAbi, functionName: 'close',
        args: [channelId, candidate, [initProof]],
        account: aliceAccount,
      });
      const txHash = await aliceWC.writeContract(request);
      console.log(`  tx: ${txHash}`);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      console.log('  Closed on-chain');
    } catch (e) {
      console.log(`  Error: ${(e as Error).message.slice(0, 300)}`);
    }
  }

  // Wait for ClearNode to process
  console.log('\nWaiting for ClearNode...');
  for (let i = 1; i <= 12; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const ch2 = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
    const stillResizing = ch2.channels?.filter((c: any) => c.status === 'resizing')?.length || 0;
    console.log(`  ${i * 10}s: ${stillResizing} still resizing`);
    if (stillResizing === 0) break;
  }

  // Final status
  const finalCh = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
  console.log('\n=== Final Channels ===');
  for (const c of finalCh.channels || []) {
    console.log(`  ${c.channel_id.slice(0, 14)}... status=${c.status} amount=${c.amount}`);
  }

  rpc.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
