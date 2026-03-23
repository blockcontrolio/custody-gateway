/**
 * Diagnostic: check current state, fund if needed, then test allocate_amount
 * to see if we can zero out channel allocation while keeping ledger balance.
 *
 * Theory: resize_channel has both resize_amount (on-chain) and allocate_amount.
 * Maybe allocate_amount moves funds between channel allocation and ledger
 * WITHOUT an on-chain tx.
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
  createGetAppSessionsMessage,
  NitroliteClient,
  WalletStateSigner,
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
const DEPOSIT = 1_000000n; // 1 USDC

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
  console.log(`Auth OK: ${address.slice(0, 10)}...`);
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

  // ── 1. Check on-chain state ──
  console.log('=== ON-CHAIN STATE ===');
  const CUSTODY = '0x6F71a38d919ad713D0AfE0eB712b95064Fc2616f' as Address;
  const acctBals = await publicClient.readContract({
    address: CUSTODY, abi: custodyAbi, functionName: 'getAccountsBalances',
    args: [[ALICE, BOB], [USDC]],
  }) as any;
  console.log(`Alice Custody USDC: ${acctBals[0][0]}`);
  console.log(`Bob Custody USDC:   ${acctBals[1][0]}`);

  const aliceUSDC = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [ALICE] });
  const bobUSDC = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [BOB] });
  console.log(`Alice wallet USDC:  ${aliceUSDC}`);
  console.log(`Bob wallet USDC:    ${bobUSDC}`);

  // ── 2. Check ClearNode state ──
  console.log('\n=== CLEARNODE STATE ===');
  const rpc = new RPC();
  await rpc.connect(CLEARNODE_URL);
  await authUser(rpc, ALICE, aliceAccount);

  const config = await rpc.call((s, id) => createGetConfigMessage(s, id), aliceSigner);
  const ethNet = config.networks?.find((n: any) => n.chain_id === 1);
  console.log(`Custody: ${ethNet.custody_address}`);
  console.log(`Adjudicator: ${ethNet.adjudicator_address}`);

  const aliceCh = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
  const aliceBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  const aliceSessions = await rpc.call((s, id) => createGetAppSessionsMessage(s, ALICE, undefined, id), aliceSigner);
  console.log(`\nAlice ledger: ${JSON.stringify(aliceBal)}`);
  console.log(`Alice channels:`);
  for (const c of aliceCh.channels || []) {
    if (c.status !== 'closed') console.log(`  ${c.channel_id.slice(0, 20)}... status=${c.status} amount=${c.amount}`);
  }
  const openAliceSessions = aliceSessions?.app_sessions?.filter((s: any) => s.status === 'open') || [];
  console.log(`Alice open sessions: ${openAliceSessions.length}`);

  // Auth Bob on same connection
  await authUser(rpc, BOB, bobAccount);
  const bobCh = await rpc.call((s, id) => createGetChannelsMessage(s, BOB, undefined, id), bobSigner);
  const bobBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), bobSigner);
  console.log(`\nBob ledger: ${JSON.stringify(bobBal)}`);
  console.log(`Bob channels:`);
  for (const c of bobCh.channels || []) {
    if (c.status !== 'closed') console.log(`  ${c.channel_id.slice(0, 20)}... status=${c.status} amount=${c.amount}`);
  }

  // ── 3. Test: resize with allocate_amount only (no resize_amount) ──
  // Find Alice's open channel with 0 amount, or create one
  const aliceOpenCh = aliceCh.channels?.find((c: any) => c.status === 'open');

  if (!aliceOpenCh) {
    console.log('\n=== No open channel for Alice, creating one ===');
    // Re-auth Alice
    await authUser(rpc, ALICE, aliceAccount);

    const chResult = await rpc.call(
      (s, id) => createCreateChannelMessage(s, { chain_id: 1, token: USDC }, id),
      aliceSigner,
    );
    console.log(`Created channel: ${chResult.channel_id}`);
    console.log(`Channel: ${JSON.stringify(chResult.channel)}`);
    console.log(`State: ${JSON.stringify(chResult.state)}`);

    // On-chain create (Alice has USDC in Custody already)
    const ADJUDICATOR = ethNet.adjudicator_address as Address;
    const aliceWC = createWalletClient({ account: aliceAccount, chain: mainnet, transport: http(ETH_RPC) });
    const nitrolite = new NitroliteClient({
      publicClient,
      walletClient: aliceWC,
      stateSigner: new WalletStateSigner(aliceWC),
      addresses: { custody: CUSTODY, adjudicator: ADJUDICATOR },
      chainId: 1,
      challengeDuration: BigInt(chResult.channel.challenge),
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

    try {
      const { txHash, channelId } = await nitrolite.createChannel(createParams);
      console.log(`On-chain create tx: ${txHash}`);
      console.log(`channelId: ${channelId}`);
    } catch (e) {
      console.log(`createChannel failed, trying depositAndCreateChannel: ${(e as Error).message.slice(0, 200)}`);
      const { txHash } = await nitrolite.depositAndCreateChannel(USDC, 0n, createParams);
      console.log(`On-chain depositAndCreate tx: ${txHash}`);
    }

    // Wait for ClearNode to detect
    console.log('Waiting for ClearNode...');
    for (let i = 1; i <= 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const ch = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
      const found = ch.channels?.find((c: any) => c.channel_id === chResult.channel_id && c.status === 'open');
      if (found) {
        console.log(`Detected after ${i * 5}s`);
        break;
      }
      if (i === 24) throw new Error('Channel not detected');
    }

    // Now resize with resize_amount to bring funds on-chain
    console.log('\nResize with resize_amount...');
    const resizeResult = await rpc.call(
      (s, id) => createResizeChannelMessage(s, {
        channel_id: chResult.channel_id as Hex,
        resize_amount: DEPOSIT,
        funds_destination: ALICE,
      }, id),
      aliceSigner,
    );
    console.log(`Resize result: ${JSON.stringify(resizeResult).slice(0, 300)}`);

    // On-chain resize with proof
    const channelId = chResult.channel_id as Hex;
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
    const resizeState = resizeResult.state;
    const unsignedResize = {
      intent: resizeState.intent as number, version: BigInt(resizeState.version),
      data: (resizeState.state_data || '0x') as Hex,
      allocations: resizeState.allocations.map((a: any) => ({ destination: a.destination as Address, token: a.token as Address, amount: BigInt(a.amount) })),
    };
    const packed = getPackedState(channelId, unsignedResize);
    const userSig = await aliceAccount.signMessage({ message: { raw: packed } });
    const { request } = await publicClient.simulateContract({
      address: CUSTODY, abi: custodyAbi, functionName: 'resize',
      args: [channelId, { ...unsignedResize, sigs: [userSig, resizeResult.server_signature as Hex] }, [initProof]],
      account: aliceAccount,
    });
    const txHash = await createWalletClient({ account: aliceAccount, chain: mainnet, transport: http(ETH_RPC) }).writeContract(request);
    console.log(`On-chain resize tx: ${txHash}`);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    // Wait for ClearNode to detect resize
    console.log('Waiting for ClearNode to detect resize...');
    for (let i = 1; i <= 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const bal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
      if (bal.ledger_balances?.length > 0) {
        console.log(`Ledger updated after ${i * 5}s: ${JSON.stringify(bal)}`);
        break;
      }
    }
  }

  // ── 4. Now try allocate_amount to zero channel allocation ──
  console.log('\n=== TEST: resize_channel with allocate_amount ===');
  // Re-check Alice's state
  await authUser(rpc, ALICE, aliceAccount);
  const aliceCh2 = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
  const aliceBal2 = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  console.log(`Alice channels:`);
  for (const c of aliceCh2.channels || []) {
    if (c.status !== 'closed') console.log(`  ${c.channel_id.slice(0, 20)}... status=${c.status} amount=${c.amount}`);
  }
  console.log(`Alice ledger: ${JSON.stringify(aliceBal2)}`);

  const openCh = aliceCh2.channels?.find((c: any) => c.status === 'open' && BigInt(c.amount) > 0n);
  if (openCh) {
    console.log(`\nTrying allocate_amount=-${DEPOSIT} on channel ${openCh.channel_id.slice(0, 20)}...`);
    try {
      const result = await rpc.call(
        (s, id) => createResizeChannelMessage(s, {
          channel_id: openCh.channel_id as Hex,
          allocate_amount: -DEPOSIT,
          funds_destination: ALICE,
        }, id),
        aliceSigner,
      );
      console.log(`allocate_amount=-DEPOSIT result: ${JSON.stringify(result).slice(0, 300)}`);
    } catch (e) {
      console.log(`allocate_amount=-DEPOSIT error: ${(e as Error).message}`);
    }

    // Try positive allocate_amount
    console.log(`\nTrying allocate_amount=${DEPOSIT}...`);
    try {
      const result = await rpc.call(
        (s, id) => createResizeChannelMessage(s, {
          channel_id: openCh.channel_id as Hex,
          allocate_amount: DEPOSIT,
          funds_destination: ALICE,
        }, id),
        aliceSigner,
      );
      console.log(`allocate_amount=+DEPOSIT result: ${JSON.stringify(result).slice(0, 300)}`);
    } catch (e) {
      console.log(`allocate_amount=+DEPOSIT error: ${(e as Error).message}`);
    }

    // Try allocate_amount=0 with resize_amount=-DEPOSIT (withdraw from channel)
    console.log(`\nTrying resize_amount=-${DEPOSIT}, allocate_amount=0...`);
    try {
      const result = await rpc.call(
        (s, id) => createResizeChannelMessage(s, {
          channel_id: openCh.channel_id as Hex,
          resize_amount: -DEPOSIT,
          allocate_amount: 0n,
          funds_destination: ALICE,
        }, id),
        aliceSigner,
      );
      console.log(`resize=-DEPOSIT allocate=0 result: ${JSON.stringify(result).slice(0, 300)}`);
    } catch (e) {
      console.log(`resize=-DEPOSIT allocate=0 error: ${(e as Error).message}`);
    }
  }

  // ── 5. Regardless of allocate results, try app session now ──
  console.log('\n=== Try create_app_session ===');
  // Re-check state
  const aliceBal3 = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
  const aliceCh3 = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
  console.log(`Alice ledger: ${JSON.stringify(aliceBal3)}`);
  console.log(`Alice non-closed channels:`);
  for (const c of aliceCh3.channels || []) {
    if (c.status !== 'closed') console.log(`  ${c.channel_id.slice(0, 20)}... status=${c.status} amount=${c.amount}`);
  }

  // Try creating session with allocations
  try {
    await authUser(rpc, BOB, bobAccount);
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
          { asset: 'usdc', amount: '1', participant: BOB },
        ],
      }, id),
      aliceSigner, [bobSigner],
    );
    console.log('Session created!', result.app_session_id);
  } catch (e) {
    console.log('Session error:', (e as Error).message);

    // Try with only Alice allocation (asymmetric)
    console.log('\nTrying asymmetric allocation (Alice only)...');
    try {
      await authUser(rpc, ALICE, aliceAccount);
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
      console.log('Asymmetric session created!', result.app_session_id);
    } catch (e2) {
      console.log('Asymmetric session error:', (e2 as Error).message);
    }

    // Try with 0 allocations
    console.log('\nTrying 0 allocations...');
    try {
      await authUser(rpc, ALICE, aliceAccount);
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
            { asset: 'usdc', amount: '0', participant: ALICE },
            { asset: 'usdc', amount: '0', participant: BOB },
          ],
        }, id),
        aliceSigner, [bobSigner],
      );
      console.log('Zero-alloc session created!', result.app_session_id);
    } catch (e3) {
      console.log('Zero-alloc session error:', (e3 as Error).message);
    }
  }

  rpc.close();
  console.log('\nDone!');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
