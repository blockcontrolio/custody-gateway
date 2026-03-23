import WebSocket from 'ws';
import { createECDSAMessageSigner, createAuthRequestMessage, createAuthVerifyMessage, createEIP712AuthMessageSigner, createGetConfigMessage, createGetChannelsMessage, createGetLedgerBalancesMessage, createCreateChannelMessage, createResizeChannelMessage, createCloseChannelMessage, NitroliteClient, WalletStateSigner, } from '@erc7824/nitrolite';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
const CLEARNODE_URL = process.env.CLEARNODE_URL || 'wss://clearnet.yellow.com/ws';
const ETH_RPC = process.env.ETHEREUM_RPC_URL;
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY, 'hex');
const ALICE2 = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325';
const BOB = '0x772ddE0ba5C672b72b4FB740c2FaB5F1Bcf6Cc2C';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DEPOSIT = 1000000n;
function decrypt(enc, iv, tag) {
    const d = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(iv, 'hex'));
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(enc, 'hex')), d.final()]).toString('utf8');
}
class RPC {
    ws;
    pending = new Map();
    nextId = 1;
    async connect(url) {
        return new Promise((res, rej) => {
            this.ws = new WebSocket(url);
            this.ws.on('open', () => res());
            this.ws.on('error', rej);
            this.ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
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
    sendRaw(id, msg) {
        return new Promise((res, rej) => {
            const t = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout')); }, 30000);
            this.pending.set(id, { resolve: r => { clearTimeout(t); res(r); }, reject: e => { clearTimeout(t); rej(e); } });
            this.ws.send(msg);
        });
    }
    async call(build, signer) {
        const id = this.nextId++;
        return this.sendRaw(id, await build(signer, id));
    }
    async callCoSigned(build, primary, all) {
        const id = this.nextId++;
        const msg = await build(primary, id);
        const parsed = JSON.parse(msg);
        const sigs = [];
        for (const s of all)
            sigs.push(await s(parsed.req));
        parsed.sig = sigs;
        return this.sendRaw(id, JSON.stringify(parsed));
    }
    close() { this.ws?.close(); }
}
async function authUser(rpc, address, account) {
    const sk = generatePrivateKey();
    const skAddr = privateKeyToAccount(sk).address;
    const params = { address, session_key: skAddr, application: 'clearnode', allowances: [], expires_at: BigInt(Math.floor(Date.now() / 1000) + 86400), scope: 'console' };
    const reqId = Math.floor(Math.random() * 1000000);
    const reqMsg = await createAuthRequestMessage(params, reqId, Date.now());
    const challenge = await rpc.sendRaw(reqId, reqMsg);
    const cm = challenge?.challenge_message || challenge?.challengeMessage;
    const wc = { account, signTypedData: (args) => account.signTypedData(args) };
    const eip712 = createEIP712AuthMessageSigner(wc, { scope: params.scope, session_key: params.session_key, expires_at: params.expires_at, allowances: params.allowances }, { name: params.application });
    const vId = reqId + 1;
    const vMsg = await createAuthVerifyMessage(eip712, { method: 'auth_challenge', params: { challengeMessage: cm } }, vId, Date.now());
    await rpc.sendRaw(vId, vMsg);
    console.log(`✅ Auth ${address.slice(0, 10)}...`);
}
async function waitForChannelOpen(rpc, signer, address, channelId, maxSec = 120) {
    for (let i = 1; i <= maxSec / 5; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const ch = await rpc.call((s, id) => createGetChannelsMessage(s, address, undefined, id), signer);
        const found = ch.channels?.find((c) => c.channel_id === channelId && c.status === 'open');
        if (found) {
            console.log(`  Detected after ${i * 5}s`);
            return found;
        }
        if (i % 6 === 0)
            console.log(`  Still waiting... (${i * 5}s)`);
    }
    throw new Error(`Channel not detected after ${maxSec}s`);
}
async function main() {
    const prisma = new PrismaClient();
    const aliceRow = await prisma.managedKey.findUnique({ where: { address: ALICE2 } });
    const bobRow = await prisma.managedKey.findUnique({ where: { address: BOB } });
    await prisma.$disconnect();
    const aliceKey = decrypt(aliceRow.encryptedKey, aliceRow.iv, aliceRow.tag);
    const bobKey = decrypt(bobRow.encryptedKey, bobRow.iv, bobRow.tag);
    const aliceAccount = privateKeyToAccount(aliceKey);
    const bobAccount = privateKeyToAccount(bobKey);
    const aliceSigner = createECDSAMessageSigner(aliceKey);
    const bobSigner = createECDSAMessageSigner(bobKey);
    const publicClient = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });
    const rpc = new RPC();
    await rpc.connect(CLEARNODE_URL);
    console.log('Connected');
    await authUser(rpc, ALICE2, aliceAccount);
    const config = await rpc.call((s, id) => createGetConfigMessage(s, id), aliceSigner);
    const ethNetwork = config.networks?.find((n) => n.chain_id === 1);
    const CUSTODY = ethNetwork.custody_address;
    const ADJUDICATOR = ethNetwork.adjudicator_address;
    console.log(`Custody: ${CUSTODY}`);
    console.log('\n=== STEP 0: Cleanup stuck channels ===');
    const aliceCh = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE2, undefined, id), aliceSigner);
    for (const c of aliceCh.channels?.filter((c) => c.status === 'resizing') || []) {
        console.log(`  Closing resizing channel ${c.channel_id.slice(0, 14)}...`);
        try {
            await rpc.call((s, id) => createCloseChannelMessage(s, c.channel_id, ALICE2, id), aliceSigner);
            console.log('  Closed');
        }
        catch (e) {
            console.log('  Close error:', e.message);
        }
    }
    await authUser(rpc, BOB, bobAccount);
    const bobCh = await rpc.call((s, id) => createGetChannelsMessage(s, BOB, undefined, id), bobSigner);
    for (const c of bobCh.channels?.filter((c) => c.status === 'resizing') || []) {
        console.log(`  Closing Bob's resizing channel ${c.channel_id.slice(0, 14)}...`);
        try {
            await rpc.call((s, id) => createCloseChannelMessage(s, c.channel_id, BOB, id), bobSigner);
            console.log('  Closed');
        }
        catch (e) {
            console.log('  Close error:', e.message);
        }
    }
    rpc.close();
    const rpc2 = new RPC();
    await rpc2.connect(CLEARNODE_URL);
    await authUser(rpc2, ALICE2, aliceAccount);
    console.log('\n=== STEP 1: Alice channel ===');
    console.log('  create_channel...');
    const aliceChResult = await rpc2.call((s, id) => createCreateChannelMessage(s, { chain_id: 1, token: USDC }, id), aliceSigner);
    const aliceChannelId = aliceChResult.channel_id;
    console.log(`  channel_id: ${aliceChannelId.slice(0, 14)}...`);
    console.log('  on-chain createChannel...');
    const aliceWC = createWalletClient({ account: aliceAccount, chain: mainnet, transport: http(ETH_RPC) });
    const aliceNitrolite = new NitroliteClient({
        publicClient, walletClient: aliceWC,
        stateSigner: new WalletStateSigner(aliceWC),
        addresses: { custody: CUSTODY, adjudicator: ADJUDICATOR },
        chainId: 1, challengeDuration: BigInt(aliceChResult.channel.challenge),
    });
    const aliceCreateParams = {
        channel: {
            participants: aliceChResult.channel.participants.map((p) => p),
            adjudicator: aliceChResult.channel.adjudicator,
            challenge: BigInt(aliceChResult.channel.challenge),
            nonce: BigInt(aliceChResult.channel.nonce),
        },
        unsignedInitialState: {
            intent: aliceChResult.state.intent,
            version: BigInt(aliceChResult.state.version),
            data: (aliceChResult.state.state_data || '0x'),
            allocations: aliceChResult.state.allocations.map((a) => ({
                destination: a.destination,
                token: a.token,
                amount: BigInt(a.amount),
            })),
        },
        serverSignature: aliceChResult.server_signature,
    };
    const { txHash: aliceTx } = await aliceNitrolite.createChannel(aliceCreateParams);
    console.log(`  tx: ${aliceTx}`);
    console.log('  waiting for ClearNode...');
    await waitForChannelOpen(rpc2, aliceSigner, ALICE2, aliceChannelId);
    console.log('  resize_channel...');
    const aliceResizeResult = await rpc2.call((s, id) => createResizeChannelMessage(s, {
        channel_id: aliceChannelId,
        resize_amount: DEPOSIT,
        funds_destination: ALICE2,
    }, id), aliceSigner);
    console.log('  resize state:', JSON.stringify(aliceResizeResult.state, null, 2));
    console.log('  server_signature:', aliceResizeResult.server_signature?.slice(0, 20) + '...');
    console.log('  on-chain resize...');
    const resizeState = aliceResizeResult.state;
    const serverSig = (aliceResizeResult.server_signature || resizeState.server_signature);
    const chainData = await aliceNitrolite.getChannelData(aliceChannelId);
    const initProof = {
        intent: chainData.lastValidState.intent,
        version: chainData.lastValidState.version,
        data: chainData.lastValidState.data,
        allocations: chainData.lastValidState.allocations.map((a) => ({
            destination: a.destination,
            token: a.token,
            amount: a.amount,
        })),
        sigs: [...chainData.lastValidState.sigs],
    };
    const { getPackedState } = await import('@erc7824/nitrolite/dist/utils/state.js');
    const resizeAllocations = resizeState.allocations.map((a) => ({
        destination: a.destination,
        token: a.token,
        amount: BigInt(a.amount),
    }));
    const unsignedResize = {
        intent: resizeState.intent,
        version: BigInt(resizeState.version),
        data: (resizeState.state_data || '0x'),
        allocations: resizeAllocations,
    };
    const packedResize = getPackedState(aliceChannelId, unsignedResize);
    const aliceStateSig = await aliceAccount.signMessage({ message: { raw: packedResize } });
    const candidate = {
        ...unsignedResize,
        sigs: [aliceStateSig, serverSig],
    };
    const { custodyAbi } = await import('@erc7824/nitrolite/dist/abis/generated.js');
    try {
        const { request } = await publicClient.simulateContract({
            address: CUSTODY, abi: custodyAbi, functionName: 'resize',
            args: [aliceChannelId, candidate, [initProof]],
            account: aliceAccount,
        });
        const resizeTxHash = await aliceWC.writeContract(request);
        console.log(`  ✅ on-chain resize tx: ${resizeTxHash}`);
        await publicClient.waitForTransactionReceipt({ hash: resizeTxHash });
        console.log('  Resize confirmed on-chain');
    }
    catch (e) {
        const errMsg = e.message;
        console.log(`  resize error: ${errMsg.slice(0, 800)}`);
    }
    console.log('  waiting for ClearNode to confirm resize...');
    for (let i = 1; i <= 12; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const bal = await rpc2.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
        if (bal.ledger_balances?.length > 0) {
            console.log(`  ✅ Ledger updated after ${i * 5}s:`, JSON.stringify(bal));
            break;
        }
        if (i === 12)
            console.log('  Ledger still empty after 60s');
        if (i % 4 === 0)
            console.log(`  Still waiting... (${i * 5}s)`);
    }
    console.log('\n=== Final State ===');
    const finalBal = await rpc2.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
    console.log('Alice ledger:', JSON.stringify(finalBal));
    const finalCh = await rpc2.call((s, id) => createGetChannelsMessage(s, ALICE2, undefined, id), aliceSigner);
    for (const c of finalCh.channels || [])
        console.log(`  ${c.channel_id.slice(0, 14)}... status=${c.status} amount=${c.amount}`);
    rpc2.close();
    console.log('\nDone.');
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
//# sourceMappingURL=full-flow.js.map