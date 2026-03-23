/**
 * Diagnose on-chain and off-chain state for Alice2 and Bob.
 * READ ONLY — no transactions, no state changes.
 */
import { createPublicClient, createWalletClient, http, erc20Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import {
  createECDSAMessageSigner,
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createGetConfigMessage,
  createGetChannelsMessage,
  createGetLedgerBalancesMessage,
  createGetAssetsMessage,
} from '@erc7824/nitrolite';
import type { MessageSigner } from '@erc7824/nitrolite';
import WebSocket from 'ws';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { generatePrivateKey } from 'viem/accounts';

const CLEARNODE_URL = process.env.CLEARNODE_URL || 'wss://clearnet.yellow.com/ws';
const ETH_RPC = process.env.ETHEREUM_RPC_URL!;
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY!, 'hex');
const ALICE2 = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325' as Address;
const BOB = '0x772ddE0ba5C672b72b4FB740c2FaB5F1Bcf6Cc2C' as Address;
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
  private nextId = 1;
  async connect(url: string) {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
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
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')); }, 15000);
      this.pending.set(id, { resolve: r => { clearTimeout(t); resolve(r); }, reject: e => { clearTimeout(t); reject(e); } });
      this.ws.send(msg);
    });
  }
  async call(build: (s: MessageSigner, id: number) => Promise<string>, signer: MessageSigner) {
    const id = this.nextId++;
    const msg = await build(signer, id);
    return this.sendRaw(id, msg);
  }
  close() { this.ws?.close(); }
}

async function authUser(rpc: RPC, address: Address, account: any, signer: MessageSigner) {
  const sk = generatePrivateKey();
  const skAddr = privateKeyToAccount(sk).address;
  const params = { address, session_key: skAddr, application: 'clearnode', allowances: [] as any[], expires_at: BigInt(Math.floor(Date.now() / 1000) + 86400), scope: 'transfer,app.create' };
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

// Custody ABI — from @erc7824/nitrolite/dist/abis/generated.js
const custodyAbi = [
  { type: 'function', name: 'getAccountsBalances', inputs: [{ name: 'accounts', type: 'address[]' }, { name: 'tokens', type: 'address[]' }], outputs: [{ name: '', type: 'uint256[][]' }], stateMutability: 'view' },
  { type: 'function', name: 'getOpenChannels', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'bytes32[]' }], stateMutability: 'view' },
] as const;

async function main() {
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

  // ─── ON-CHAIN STATE ───
  console.log('=== ON-CHAIN STATE ===\n');

  // Get config first to know custody address
  const rpc = new RPC();
  await rpc.connect(CLEARNODE_URL);
  await authUser(rpc, ALICE2, aliceAccount, aliceSigner);
  await authUser(rpc, BOB, bobAccount, bobSigner);

  const config = await rpc.call((s, id) => createGetConfigMessage(s, id), aliceSigner);
  const ethNetwork = config.networks?.find((n: any) => n.chain_id === 1);
  const CUSTODY = ethNetwork?.custody_address as Address;
  console.log('Custody contract:', CUSTODY);

  // USDC wallet balances
  const [aliceUSDC, bobUSDC] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [ALICE2] }),
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [BOB] }),
  ]);
  console.log(`Alice wallet USDC: ${aliceUSDC} (${Number(aliceUSDC) / 1e6} USDC)`);
  console.log(`Bob wallet USDC:   ${bobUSDC} (${Number(bobUSDC) / 1e6} USDC)`);

  // Custody account balances (deposited funds) — tokens is address[]
  const custodyBalances = await publicClient.readContract({
    address: CUSTODY,
    abi: custodyAbi,
    functionName: 'getAccountsBalances',
    args: [[ALICE2, BOB], [USDC]],
  });
  console.log(`Alice in Custody:  ${custodyBalances[0][0]} (${Number(custodyBalances[0][0]) / 1e6} USDC)`);
  console.log(`Bob in Custody:    ${custodyBalances[1][0]} (${Number(custodyBalances[1][0]) / 1e6} USDC)`);

  // On-chain channel queries not available on this contract version

  // ─── OFF-CHAIN STATE (ClearNode) ───
  console.log('\n=== CLEARNODE STATE ===\n');

  const aliceCh = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE2, undefined, id), aliceSigner);
  console.log('Alice channels:');
  for (const c of aliceCh.channels || []) console.log(`  ${c.channel_id.slice(0, 14)}... status=${c.status} amount=${c.amount}`);
  if (!aliceCh.channels?.length) console.log('  (none)');

  const bobCh = await rpc.call((s, id) => createGetChannelsMessage(s, BOB, undefined, id), bobSigner);
  console.log('Bob channels:');
  for (const c of bobCh.channels || []) console.log(`  ${c.channel_id.slice(0, 14)}... status=${c.status} amount=${c.amount}`);
  if (!bobCh.channels?.length) console.log('  (none)');

  const aliceBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  console.log('\nAlice ledger:', JSON.stringify(aliceBal));

  const bobBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), bobSigner);
  console.log('Bob ledger:', JSON.stringify(bobBal));

  // Assets info
  const assets = await rpc.call((s, id) => createGetAssetsMessage(s, undefined, id), aliceSigner);
  console.log('\nSupported assets:', JSON.stringify(assets));

  rpc.close();

  console.log('\n=== ANALYSIS ===');
  const aliceCustody = Number(custodyBalances[0][0]);
  const bobCustody = Number(custodyBalances[1][0]);
  const aliceOpen = aliceCh.channels?.filter((c: any) => c.status === 'open') || [];
  const bobOpen = bobCh.channels?.filter((c: any) => c.status === 'open') || [];

  if (aliceOpen.length > 0 && aliceOpen.some((c: any) => Number(c.amount) > 0)) {
    console.log('Alice: has open funded channel — ready for app session');
  } else if (aliceOpen.length > 0) {
    console.log('Alice: has open channel but amount=0 — needs resize_channel');
  } else if (aliceCustody > 0) {
    console.log('Alice: has funds in Custody but no open channel — needs create_channel + resize');
  } else if (Number(aliceUSDC) > 0) {
    console.log('Alice: has wallet USDC but nothing in Custody — needs deposit + channel + resize');
  } else {
    console.log('Alice: NO FUNDS anywhere');
  }

  if (bobOpen.length > 0 && bobOpen.some((c: any) => Number(c.amount) > 0)) {
    console.log('Bob: has open funded channel — ready for app session');
  } else if (bobOpen.length > 0) {
    console.log('Bob: has open channel but amount=0 — needs resize_channel');
  } else if (bobCustody > 0) {
    console.log('Bob: has funds in Custody but no open channel — needs create_channel + resize');
  } else if (Number(bobUSDC) > 0) {
    console.log('Bob: has wallet USDC but nothing in Custody — needs deposit + channel + resize');
  } else {
    console.log('Bob: NO FUNDS anywhere — need to send USDC first');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
