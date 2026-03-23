/**
 * Test: direct deposit to Custody contract (no channel) and check if ClearNode credits ledger.
 * Then try app session creation without any channel allocations blocking.
 *
 * Steps:
 * 1. Close stuck resizing channel on-chain
 * 2. Direct deposit to Custody for Alice
 * 3. Check if ClearNode ledger updates
 * 4. Create app session
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
  createCloseAppSessionMessage,
  createGetAppSessionsMessage,
  RPCProtocolVersion,
} from '@erc7824/nitrolite';
import type { MessageSigner } from '@erc7824/nitrolite';
import { createPublicClient, createWalletClient, http, type Hex, type Address, erc20Abi } from 'viem';
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
  console.log(`Auth: ${address.slice(0, 10)}...`);
}

async function onchainClose(account: any, walletClient: any, publicClient: any, channelId: Hex, closeState: any, serverSig: Hex) {
  const chainData = await publicClient.readContract({
    address: CUSTODY, abi: custodyAbi, functionName: 'getChannelData', args: [channelId],
  }) as any;
  if (chainData[1] === 0) return null;
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
  const bobWC = createWalletClient({ account: bobAccount, chain: mainnet, transport: http(ETH_RPC) });

  // ── 1. Close any open/resizing channels for Alice ──
  console.log('=== Step 1: Clean up channels ===');
  const rpc = new RPC();
  await rpc.connect(CLEARNODE_URL);
  await authUser(rpc, ALICE, aliceAccount);

  const aliceCh = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
  for (const c of aliceCh.channels?.filter((c: any) => c.status !== 'closed') || []) {
    const chId = c.channel_id as Hex;
    console.log(`  Closing ${chId.slice(0, 20)}... (status=${c.status}, amount=${c.amount})`);
    try {
      const closeResult = await rpc.call(
        (s, id) => createCloseChannelMessage(s, chId, ALICE, id), aliceSigner,
      );
      const tx = await onchainClose(aliceAccount, aliceWC, publicClient, chId, closeResult.state, closeResult.server_signature as Hex);
      if (tx) {
        console.log(`  Close tx: ${tx}`);
        await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log('  Confirmed');
      }
    } catch (e) {
      console.log(`  Error: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  // Also close any open sessions
  const sessions = await rpc.call((s, id) => createGetAppSessionsMessage(s, ALICE, undefined, id), aliceSigner);
  for (const sess of sessions?.app_sessions?.filter((s: any) => s.status === 'open') || []) {
    console.log(`  Closing session ${sess.app_session_id.slice(0, 20)}...`);
    try {
      await authUser(rpc, BOB, bobAccount); // need both sigs
      await rpc.callCoSigned(
        (s, id) => createCloseAppSessionMessage(s, {
          app_session_id: sess.app_session_id,
          allocations: [
            { asset: 'usdc', amount: '0', participant: ALICE },
            { asset: 'usdc', amount: '0', participant: BOB },
          ],
        }, id),
        aliceSigner, [bobSigner],
      );
      console.log('  Session closed');
    } catch (e) {
      console.log(`  Session close error: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  // Wait for ClearNode to process closes
  console.log('\nWaiting 15s for ClearNode...');
  await new Promise(r => setTimeout(r, 15000));

  // ── 2. Check state after cleanup ──
  console.log('\n=== Step 2: State after cleanup ===');
  await authUser(rpc, ALICE, aliceAccount);
  const aliceCh2 = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
  const aliceBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  console.log(`Alice ledger: ${JSON.stringify(aliceBal)}`);
  const nonClosed = aliceCh2.channels?.filter((c: any) => c.status !== 'closed') || [];
  console.log(`Alice non-closed channels: ${nonClosed.length}`);
  for (const c of nonClosed) console.log(`  ${c.channel_id.slice(0, 20)}... status=${c.status} amount=${c.amount}`);

  // Check on-chain
  const aliceCustody = await publicClient.readContract({
    address: CUSTODY, abi: custodyAbi, functionName: 'getAccountsBalances',
    args: [[ALICE, BOB], [USDC]],
  }) as any;
  console.log(`\nAlice Custody USDC: ${aliceCustody[0][0]}`);
  console.log(`Bob Custody USDC:   ${aliceCustody[1][0]}`);

  // ── 3. Direct deposit to Custody ──
  console.log('\n=== Step 3: Direct deposit to Custody ===');
  // Approve USDC for Custody contract
  const aliceUSDC = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [ALICE] });
  console.log(`Alice wallet USDC: ${aliceUSDC}`);

  if (aliceUSDC >= DEPOSIT) {
    // Approve
    const approveTx = await aliceWC.writeContract({
      address: USDC, abi: erc20Abi, functionName: 'approve', args: [CUSTODY, DEPOSIT],
    });
    console.log(`Approve tx: ${approveTx}`);
    await publicClient.waitForTransactionReceipt({ hash: approveTx });

    // Deposit to Custody for Alice's account
    const depositTx = await aliceWC.writeContract({
      address: CUSTODY, abi: custodyAbi, functionName: 'deposit', args: [ALICE, USDC, DEPOSIT],
    });
    console.log(`Deposit tx: ${depositTx}`);
    await publicClient.waitForTransactionReceipt({ hash: depositTx });
    console.log('Deposit confirmed');

    // Check on-chain balance after deposit
    const afterBal = await publicClient.readContract({
      address: CUSTODY, abi: custodyAbi, functionName: 'getAccountsBalances',
      args: [[ALICE], [USDC]],
    }) as any;
    console.log(`Alice Custody USDC after deposit: ${afterBal[0][0]}`);
  } else {
    console.log('Alice wallet USDC too low for deposit, checking existing Custody balance...');
  }

  // ── 4. Wait for ClearNode to detect deposit ──
  console.log('\n=== Step 4: Wait for ClearNode to detect deposit ===');
  for (let i = 1; i <= 30; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const bal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
    const usdcBal = bal.ledger_balances?.find((b: any) => b.asset === 'usdc');
    const amount = usdcBal?.amount || '0';
    if (i % 3 === 0 || amount !== '0') console.log(`  ${i * 5}s: ledger usdc=${amount}`);
    if (parseFloat(amount) > 0) {
      console.log('Ledger updated!');
      break;
    }
    if (i === 30) console.log('No ledger update after 150s');
  }

  // ── 5. Try app session ──
  console.log('\n=== Step 5: Try app session ===');
  const finalBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  const finalCh = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
  console.log(`Alice ledger: ${JSON.stringify(finalBal)}`);
  const finalNonClosed = finalCh.channels?.filter((c: any) => c.status !== 'closed') || [];
  console.log(`Non-closed channels: ${finalNonClosed.length}`);

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
    console.log('Session created!', result.app_session_id);
    console.log('Full result:', JSON.stringify(result, null, 2));
  } catch (e) {
    console.log('Session error:', (e as Error).message);
  }

  rpc.close();
  console.log('\nDone!');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
