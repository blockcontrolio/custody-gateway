/**
 * Create app session between Alice (1 USDC) and Bob (1 USDC)
 * Both already funded with ledger balances.
 */
import WebSocket from 'ws';
import {
  createECDSAMessageSigner,
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createGetLedgerBalancesMessage,
  createAppSessionMessage,
  createGetAppSessionsMessage,
  createSubmitAppStateMessage,
  createCloseAppSessionMessage,
  RPCProtocolVersion,
} from '@erc7824/nitrolite';
import type { MessageSigner } from '@erc7824/nitrolite';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const CLEARNODE_URL = process.env.CLEARNODE_URL || 'wss://clearnet.yellow.com/ws';
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY!, 'hex');
const ALICE = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325' as Address;
const BOB = '0x772ddE0ba5C672b72b4FB740c2FaB5F1Bcf6Cc2C' as Address;

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
  console.log(`Auth ${address.slice(0, 10)}...`);
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

  const rpc = new RPC();
  await rpc.connect(CLEARNODE_URL);
  await authUser(rpc, ALICE, aliceAccount);

  // Check ledger
  const aliceBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  console.log('Alice ledger:', JSON.stringify(aliceBal));

  // Create app session with proper format
  console.log('\n=== Create App Session ===');

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
      { asset: 'usdc', amount: '1', participant: ALICE },
      { asset: 'usdc', amount: '1', participant: BOB },
    ],
  };

  // Build message with Alice's sig, then add Bob's
  const id = 42;
  const msg = await createAppSessionMessage(aliceSigner, sessionParams, id);
  const parsed = JSON.parse(msg);
  console.log('Request:', JSON.stringify(parsed.req, null, 2));

  // Add Bob's co-signature
  const bobSigForReq = await bobSigner(parsed.req);
  parsed.sig = [parsed.sig[0], bobSigForReq];
  console.log(`Sending with ${parsed.sig.length} signatures`);

  try {
    const result = await rpc.sendRaw(id, JSON.stringify(parsed));
    console.log('Result:', JSON.stringify(result, null, 2));

    // Check sessions
    if (result?.app_session_id) {
      console.log(`\nApp session created: ${result.app_session_id}`);

      // Submit state update: Alice 1.2, Bob 0.8
      console.log('\n=== Submit State Update: Alice 1.2, Bob 0.8 ===');
      const stateId = 43;
      const stateMsg = await createSubmitAppStateMessage(aliceSigner, {
        app_session_id: result.app_session_id,
        intent: 'operate' as any,
        version: 1,
        allocations: [
          { asset: 'usdc', amount: '1.2', participant: ALICE },
          { asset: 'usdc', amount: '0.8', participant: BOB },
        ],
      }, stateId);
      const stateParsed = JSON.parse(stateMsg);
      const bobStateSig = await bobSigner(stateParsed.req);
      stateParsed.sig = [stateParsed.sig[0], bobStateSig];
      const stateResult = await rpc.sendRaw(stateId, JSON.stringify(stateParsed));
      console.log('State result:', JSON.stringify(stateResult, null, 2));

      // Close session
      console.log('\n=== Close App Session ===');
      const closeId = 44;
      const closeMsg = await createCloseAppSessionMessage(aliceSigner, {
        app_session_id: result.app_session_id,
        allocations: [
          { asset: 'usdc', amount: '1.2', participant: ALICE },
          { asset: 'usdc', amount: '0.8', participant: BOB },
        ],
      }, closeId);
      const closeParsed = JSON.parse(closeMsg);
      const bobCloseSig = await bobSigner(closeParsed.req);
      closeParsed.sig = [closeParsed.sig[0], bobCloseSig];
      const closeResult = await rpc.sendRaw(closeId, JSON.stringify(closeParsed));
      console.log('Close result:', JSON.stringify(closeResult, null, 2));

      // Check final ledger balances
      console.log('\n=== Final Ledger ===');
      const finalAlice = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
      console.log('Alice:', JSON.stringify(finalAlice));

      // Auth Bob to check his balance
      await authUser(rpc, BOB, bobAccount);
      const finalBob = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), bobSigner);
      console.log('Bob:', JSON.stringify(finalBob));
    }
  } catch (e) {
    console.log('Error:', (e as Error).message);
  }

  rpc.close();
  console.log('\nDone!');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
