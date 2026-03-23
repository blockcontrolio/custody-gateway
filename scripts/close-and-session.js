import WebSocket from 'ws';
import { createECDSAMessageSigner, createAuthRequestMessage, createAuthVerifyMessage, createEIP712AuthMessageSigner, createGetChannelsMessage, createGetLedgerBalancesMessage, createCloseChannelMessage, createAppSessionMessage, createCloseAppSessionMessage, createSubmitAppStateMessage, RPCProtocolVersion, RPCAppStateIntent, } from '@erc7824/nitrolite';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { custodyAbi } from '@erc7824/nitrolite/dist/abis/generated.js';
import { getPackedState } from '@erc7824/nitrolite/dist/utils/state.js';
const CLEARNODE_URL = process.env.CLEARNODE_URL || 'wss://clearnet.yellow.com/ws';
const ETH_RPC = process.env.ETHEREUM_RPC_URL;
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY, 'hex');
const ALICE = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325';
const BOB = '0x772ddE0ba5C672b72b4FB740c2FaB5F1Bcf6Cc2C';
const CUSTODY = '0x6F71a38d919ad713D0AfE0eB712b95064Fc2616f';
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
    async callCoSigned(build, primary, cosigners) {
        const id = this.nextId++;
        const msg = await build(primary, id);
        const parsed = JSON.parse(msg);
        const sigs = [parsed.sig[0]];
        for (const cs of cosigners)
            sigs.push(await cs(parsed.req));
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
}
async function onchainClose(account, walletClient, publicClient, channelId, closeState, serverSig) {
    const chainData = await publicClient.readContract({
        address: CUSTODY, abi: custodyAbi, functionName: 'getChannelData', args: [channelId],
    });
    if (chainData[1] === 0)
        return null;
    const lastState = chainData[4];
    const initProof = {
        intent: Number(lastState.intent), version: lastState.version,
        data: lastState.data,
        allocations: lastState.allocations.map((a) => ({ destination: a.destination, token: a.token, amount: a.amount })),
        sigs: [...lastState.sigs],
    };
    const unsignedClose = {
        intent: closeState.intent, version: BigInt(closeState.version),
        data: (closeState.state_data || '0x'),
        allocations: closeState.allocations.map((a) => ({ destination: a.destination, token: a.token, amount: BigInt(a.amount) })),
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
    const aliceKey = decrypt(aliceRow.encryptedKey, aliceRow.iv, aliceRow.tag);
    const bobKey = decrypt(bobRow.encryptedKey, bobRow.iv, bobRow.tag);
    const aliceAccount = privateKeyToAccount(aliceKey);
    const bobAccount = privateKeyToAccount(bobKey);
    const aliceSigner = createECDSAMessageSigner(aliceKey);
    const bobSigner = createECDSAMessageSigner(bobKey);
    const publicClient = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });
    const aliceWC = createWalletClient({ account: aliceAccount, chain: mainnet, transport: http(ETH_RPC) });
    const bobWC = createWalletClient({ account: bobAccount, chain: mainnet, transport: http(ETH_RPC) });
    console.log('=== Close Alice channel (0xd25a) ===');
    const rpc1 = new RPC();
    await rpc1.connect(CLEARNODE_URL);
    await authUser(rpc1, ALICE, aliceAccount);
    const aliceCh = await rpc1.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
    for (const c of aliceCh.channels?.filter((c) => c.status === 'open' && c.amount > 0) || []) {
        const chId = c.channel_id;
        console.log(`  Closing ${chId.slice(0, 14)}... (amount=${c.amount})`);
        const closeResult = await rpc1.call((s, id) => createCloseChannelMessage(s, chId, ALICE, id), aliceSigner);
        console.log('  close_channel state:', JSON.stringify(closeResult.state?.allocations));
        const tx = await onchainClose(aliceAccount, aliceWC, publicClient, chId, closeResult.state, closeResult.server_signature);
        if (tx) {
            console.log(`  on-chain close tx: ${tx}`);
            await publicClient.waitForTransactionReceipt({ hash: tx });
        }
    }
    rpc1.close();
    console.log('\n=== Close Bob channel (0x002d) ===');
    const rpc2 = new RPC();
    await rpc2.connect(CLEARNODE_URL);
    await authUser(rpc2, BOB, bobAccount);
    const bobCh = await rpc2.call((s, id) => createGetChannelsMessage(s, BOB, undefined, id), bobSigner);
    for (const c of bobCh.channels?.filter((c) => c.status === 'open' && c.amount > 0) || []) {
        const chId = c.channel_id;
        console.log(`  Closing ${chId.slice(0, 14)}... (amount=${c.amount})`);
        const closeResult = await rpc2.call((s, id) => createCloseChannelMessage(s, chId, BOB, id), bobSigner);
        const tx = await onchainClose(bobAccount, bobWC, publicClient, chId, closeResult.state, closeResult.server_signature);
        if (tx) {
            console.log(`  on-chain close tx: ${tx}`);
            await publicClient.waitForTransactionReceipt({ hash: tx });
        }
    }
    rpc2.close();
    console.log('\nWaiting for ClearNode to process closes...');
    await new Promise(r => setTimeout(r, 15000));
    const rpc3 = new RPC();
    await rpc3.connect(CLEARNODE_URL);
    await authUser(rpc3, ALICE, aliceAccount);
    const bal = await rpc3.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
    console.log('Alice ledger after close:', JSON.stringify(bal));
    const ch = await rpc3.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
    const openCh = ch.channels?.filter((c) => c.status !== 'closed') || [];
    console.log('Alice open channels:', openCh.length);
    console.log('\n=== Create App Session (1 USDC each) ===');
    try {
        const result = await rpc3.callCoSigned((s, id) => createAppSessionMessage(s, {
            definition: {
                application: 'custody-gateway',
                protocol: RPCProtocolVersion.NitroRPC_0_4,
                participants: [ALICE, BOB],
                weights: [1, 1],
                quorum: 2,
                challenge: 3600,
                nonce: Date.now(),
            },
            allocations: [
                { asset: 'usdc', amount: '1', participant: ALICE },
                { asset: 'usdc', amount: '1', participant: BOB },
            ],
        }, id), aliceSigner, [bobSigner]);
        console.log('Session created:', result.app_session_id);
        if (result.app_session_id) {
            const sessionId = result.app_session_id;
            console.log('\n=== Operate: Alice 1.2, Bob 0.8 ===');
            const opResult = await rpc3.callCoSigned((s, id) => createSubmitAppStateMessage(s, {
                app_session_id: sessionId,
                intent: RPCAppStateIntent.Operate,
                version: 2,
                allocations: [
                    { asset: 'usdc', amount: '1.2', participant: ALICE },
                    { asset: 'usdc', amount: '0.8', participant: BOB },
                ],
            }, id), aliceSigner, [bobSigner]);
            console.log('Operate result:', JSON.stringify(opResult, null, 2));
            console.log('\n=== Close Session ===');
            const closeResult = await rpc3.callCoSigned((s, id) => createCloseAppSessionMessage(s, {
                app_session_id: sessionId,
                allocations: [
                    { asset: 'usdc', amount: '1.2', participant: ALICE },
                    { asset: 'usdc', amount: '0.8', participant: BOB },
                ],
            }, id), aliceSigner, [bobSigner]);
            console.log('Close result:', JSON.stringify(closeResult, null, 2));
            console.log('\n=== Final Ledger ===');
            const finalAlice = await rpc3.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
            console.log('Alice:', JSON.stringify(finalAlice));
            await authUser(rpc3, BOB, bobAccount);
            const finalBob = await rpc3.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), bobSigner);
            console.log('Bob:', JSON.stringify(finalBob));
        }
    }
    catch (e) {
        console.log('Error:', e.message);
    }
    rpc3.close();
    console.log('\nDone!');
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
//# sourceMappingURL=close-and-session.js.map