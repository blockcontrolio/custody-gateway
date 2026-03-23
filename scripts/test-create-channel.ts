/**
 * Minimal test: try create_channel and debug the signature issue.
 */
import WebSocket from 'ws';
import {
  createECDSAMessageSigner,
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createCreateChannelMessage,
  createGetChannelsMessage,
  createCloseChannelMessage,
} from '@erc7824/nitrolite';
import type { MessageSigner } from '@erc7824/nitrolite';
import { toHex, keccak256 } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const CLEARNODE_URL = process.env.CLEARNODE_URL || 'wss://clearnet.yellow.com/ws';
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY!, 'hex');
const ALICE2 = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325' as Address;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;

function decrypt(encrypted: string, iv: string, tag: string): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString('utf8');
}

type Pending = { resolve: (r: any) => void; reject: (e: Error) => void };

class RPC {
  private ws!: WebSocket;
  private pending = new Map<number, Pending>();

  async connect(url: string) {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (data: WebSocket.Data) => {
        const text = data.toString();
        console.log('  [RAW]', text.slice(0, 300));
        const msg = JSON.parse(text);
        if (msg.res) {
          const [id, method, result] = msg.res;
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            result?.error ? p.reject(new Error(`${method}: ${result.error}`)) : p.resolve(result);
          }
        }
      });
    });
  }

  sendRaw(id: number, msg: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')); }, 15000);
      this.pending.set(id, {
        resolve: r => { clearTimeout(t); resolve(r); },
        reject: e => { clearTimeout(t); reject(e); },
      });
      console.log(`  [SEND id=${id}]`, msg.slice(0, 300));
      this.ws.send(msg);
    });
  }

  close() { this.ws?.close(); }
}

async function main() {
  const prisma = new PrismaClient();
  const aliceRow = await prisma.managedKey.findUnique({ where: { address: ALICE2 } });
  await prisma.$disconnect();
  const aliceKey = decrypt(aliceRow!.encryptedKey, aliceRow!.iv, aliceRow!.tag) as Hex;
  const aliceAccount = privateKeyToAccount(aliceKey);
  const aliceSigner = createECDSAMessageSigner(aliceKey);

  console.log('Alice address:', aliceAccount.address);

  const rpc = new RPC();
  await rpc.connect(CLEARNODE_URL);
  console.log('Connected\n');

  // Auth
  const sk = generatePrivateKey();
  const skAddr = privateKeyToAccount(sk).address;
  const params = { address: ALICE2, session_key: skAddr, application: 'clearnode', allowances: [] as any[], expires_at: BigInt(Math.floor(Date.now() / 1000) + 86400), scope: 'console' };
  const reqId = 100;
  const reqMsg = await createAuthRequestMessage(params, reqId, Date.now());
  const challenge = await rpc.sendRaw(reqId, reqMsg);
  const cm = challenge?.challenge_message || challenge?.challengeMessage;
  const wc = { account: aliceAccount, signTypedData: (args: any) => aliceAccount.signTypedData(args) } as any;
  const eip712 = createEIP712AuthMessageSigner(wc, { scope: params.scope, session_key: params.session_key, expires_at: params.expires_at, allowances: params.allowances }, { name: params.application });
  const vId = 101;
  const vMsg = await createAuthVerifyMessage(eip712, { method: 'auth_challenge' as any, params: { challengeMessage: cm } }, vId, Date.now());
  await rpc.sendRaw(vId, vMsg);
  console.log('Auth done\n');

  // Test 1: get_channels (unsigned, should work)
  console.log('=== Test 1: get_channels (unsigned) ===');
  const chMsg = await createGetChannelsMessage(aliceSigner, ALICE2, undefined, 200);
  console.log('Message:', chMsg.slice(0, 200));
  try {
    const result = await rpc.sendRaw(200, chMsg);
    console.log('OK\n');
  } catch (e) { console.log('ERROR:', (e as Error).message, '\n'); }

  // Test 2: create_channel via nitrolite (signed, fails)
  console.log('=== Test 2: create_channel via nitrolite ===');
  const ccMsg = await createCreateChannelMessage(aliceSigner, { chain_id: 1, token: USDC }, 300);
  console.log('Message:', ccMsg.slice(0, 400));
  try {
    const result = await rpc.sendRaw(300, ccMsg);
    console.log('OK:', JSON.stringify(result).slice(0, 200), '\n');
  } catch (e) { console.log('ERROR:', (e as Error).message, '\n'); }

  // Test 3: manually build create_channel with different signing
  console.log('=== Test 3: manual create_channel ===');
  const ts = Date.now();
  const reqArray = [400, 'create_channel', { chain_id: 1, token: USDC }, ts];
  // Sign same way as nitrolite
  const payloadStr = JSON.stringify(reqArray, (_, v) => typeof v === 'bigint' ? v.toString() : v);
  const payloadHex = toHex(payloadStr);
  const hash = keccak256(payloadHex);
  const sig = await aliceAccount.sign({ hash });
  const manualMsg = JSON.stringify({ req: reqArray, sig: [sig] });
  console.log('Message:', manualMsg.slice(0, 400));
  try {
    const result = await rpc.sendRaw(400, manualMsg);
    console.log('OK:', JSON.stringify(result).slice(0, 200), '\n');
  } catch (e) { console.log('ERROR:', (e as Error).message, '\n'); }

  // Test 4: try with chain_id as string
  console.log('=== Test 4: create_channel chain_id as string ===');
  const reqArray4 = [500, 'create_channel', { chain_id: '1', token: USDC }, Date.now()];
  const payloadStr4 = JSON.stringify(reqArray4);
  const payloadHex4 = toHex(payloadStr4);
  const hash4 = keccak256(payloadHex4);
  const sig4 = await aliceAccount.sign({ hash: hash4 });
  const manualMsg4 = JSON.stringify({ req: reqArray4, sig: [sig4] });
  console.log('Message:', manualMsg4.slice(0, 400));
  try {
    const result = await rpc.sendRaw(500, manualMsg4);
    console.log('OK:', JSON.stringify(result).slice(0, 200), '\n');
  } catch (e) { console.log('ERROR:', (e as Error).message, '\n'); }

  // Test 5: try with params as array [chain_id, token]
  console.log('=== Test 5: create_channel params as array ===');
  const reqArray5 = [600, 'create_channel', [{ chain_id: 1, token: USDC }], Date.now()];
  const payloadStr5 = JSON.stringify(reqArray5);
  const payloadHex5 = toHex(payloadStr5);
  const hash5 = keccak256(payloadHex5);
  const sig5 = await aliceAccount.sign({ hash: hash5 });
  const manualMsg5 = JSON.stringify({ req: reqArray5, sig: [sig5] });
  console.log('Message:', manualMsg5.slice(0, 400));
  try {
    const result = await rpc.sendRaw(600, manualMsg5);
    console.log('OK:', JSON.stringify(result).slice(0, 200), '\n');
  } catch (e) { console.log('ERROR:', (e as Error).message, '\n'); }

  rpc.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
