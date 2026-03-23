/**
 * Check ClearNode state after on-chain resize
 */
import WebSocket from 'ws';
import {
  createECDSAMessageSigner,
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createGetChannelsMessage,
  createGetLedgerBalancesMessage,
} from '@erc7824/nitrolite';
import type { MessageSigner } from '@erc7824/nitrolite';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const CLEARNODE_URL = process.env.CLEARNODE_URL || 'wss://clearnet.yellow.com/ws';
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY!, 'hex');
const ALICE2 = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325' as Address;

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
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout')); }, 15000);
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
  const aliceRow = await prisma.managedKey.findUnique({ where: { address: ALICE2 } });
  await prisma.$disconnect();
  const aliceKey = decrypt(aliceRow!.encryptedKey, aliceRow!.iv, aliceRow!.tag) as Hex;
  const aliceAccount = privateKeyToAccount(aliceKey);
  const aliceSigner = createECDSAMessageSigner(aliceKey);

  const rpc = new RPC();
  await rpc.connect(CLEARNODE_URL);
  await authUser(rpc, ALICE2, aliceAccount);

  // Check channels
  const channels = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE2, undefined, id), aliceSigner);
  console.log('=== Channels ===');
  for (const c of channels.channels || []) {
    console.log(`  ${c.channel_id.slice(0, 14)}... status=${c.status} amount=${c.amount}`);
  }

  // Check ledger
  const ledger = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  console.log('\n=== Ledger Balances ===');
  console.log(JSON.stringify(ledger, null, 2));

  // Poll for a bit in case ClearNode hasn't caught up yet
  if (!ledger.ledger_balances?.length) {
    console.log('\nWaiting for ClearNode to process...');
    for (let i = 1; i <= 12; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const bal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
      const ch = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE2, undefined, id), aliceSigner);
      const d25a = ch.channels?.find((c: any) => c.channel_id.startsWith('0xd25a'));
      console.log(`  ${i * 10}s: ledger=${bal.ledger_balances?.length || 0} entries, d25a status=${d25a?.status}`);
      if (bal.ledger_balances?.length > 0) {
        console.log('  Ledger:', JSON.stringify(bal, null, 2));
        break;
      }
    }
  }

  rpc.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
