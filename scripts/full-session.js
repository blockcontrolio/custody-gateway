import WebSocket from 'ws';
import { createECDSAMessageSigner, createAuthRequestMessage, createAuthVerifyMessage, createEIP712AuthMessageSigner, createGetLedgerBalancesMessage, createAppSessionMessage, createSubmitAppStateMessage, createCloseAppSessionMessage, createGetAppSessionsMessage, RPCProtocolVersion, RPCAppStateIntent, } from '@erc7824/nitrolite';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
const CLEARNODE_URL = process.env.CLEARNODE_URL || 'wss://clearnet.yellow.com/ws';
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY, 'hex');
const ALICE = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325';
const BOB = '0x772ddE0ba5C672b72b4FB740c2FaB5F1Bcf6Cc2C';
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
    console.log(`Auth ${address.slice(0, 10)}...`);
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
    const rpc = new RPC();
    await rpc.connect(CLEARNODE_URL);
    await authUser(rpc, ALICE, aliceAccount);
    const aliceBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
    console.log('Alice ledger:', JSON.stringify(aliceBal));
    const existingSessions = await rpc.call((s, id) => createGetAppSessionsMessage(s, ALICE, undefined, id), aliceSigner);
    console.log('Existing sessions:', JSON.stringify(existingSessions?.app_sessions?.length || 0));
    for (const sess of existingSessions?.app_sessions || []) {
        if (sess.status === 'open') {
            console.log(`  Closing existing session ${sess.app_session_id.slice(0, 14)}...`);
            try {
                await rpc.callCoSigned((s, id) => createCloseAppSessionMessage(s, {
                    app_session_id: sess.app_session_id,
                    allocations: [
                        { asset: 'usdc', amount: '0', participant: ALICE },
                        { asset: 'usdc', amount: '0', participant: BOB },
                    ],
                }, id), aliceSigner, [bobSigner]);
                console.log('  Closed');
            }
            catch (e) {
                console.log('  Close error:', e.message);
            }
        }
    }
    console.log('\n=== Step 1: Create App Session (0 allocations) ===');
    const sessionResult = await rpc.callCoSigned((s, id) => createAppSessionMessage(s, {
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
            { asset: 'usdc', amount: '0', participant: ALICE },
            { asset: 'usdc', amount: '0', participant: BOB },
        ],
    }, id), aliceSigner, [bobSigner]);
    const sessionId = sessionResult.app_session_id;
    console.log(`Session: ${sessionId}`);
    console.log('\n=== Step 2: Deposit 1 USDC each ===');
    try {
        const depositResult = await rpc.callCoSigned((s, id) => createSubmitAppStateMessage(s, {
            app_session_id: sessionId,
            intent: RPCAppStateIntent.Deposit,
            version: 2,
            allocations: [
                { asset: 'usdc', amount: '1', participant: ALICE },
                { asset: 'usdc', amount: '1', participant: BOB },
            ],
        }, id), aliceSigner, [bobSigner]);
        console.log('Deposit result:', JSON.stringify(depositResult, null, 2));
    }
    catch (e) {
        console.log('Deposit error:', e.message);
    }
    console.log('\n=== Step 3: Operate (Alice 1.2, Bob 0.8) ===');
    try {
        const opResult = await rpc.callCoSigned((s, id) => createSubmitAppStateMessage(s, {
            app_session_id: sessionId,
            intent: RPCAppStateIntent.Operate,
            version: 3,
            allocations: [
                { asset: 'usdc', amount: '1.2', participant: ALICE },
                { asset: 'usdc', amount: '0.8', participant: BOB },
            ],
        }, id), aliceSigner, [bobSigner]);
        console.log('Operate result:', JSON.stringify(opResult, null, 2));
    }
    catch (e) {
        console.log('Operate error:', e.message);
    }
    console.log('\n=== Step 4: Close Session ===');
    try {
        const closeResult = await rpc.callCoSigned((s, id) => createCloseAppSessionMessage(s, {
            app_session_id: sessionId,
            allocations: [
                { asset: 'usdc', amount: '1.2', participant: ALICE },
                { asset: 'usdc', amount: '0.8', participant: BOB },
            ],
        }, id), aliceSigner, [bobSigner]);
        console.log('Close result:', JSON.stringify(closeResult, null, 2));
    }
    catch (e) {
        console.log('Close error:', e.message);
    }
    console.log('\n=== Final Ledger ===');
    const finalAlice = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
    console.log('Alice:', JSON.stringify(finalAlice));
    await authUser(rpc, BOB, bobAccount);
    const finalBob = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), bobSigner);
    console.log('Bob:', JSON.stringify(finalBob));
    rpc.close();
    console.log('\nDone!');
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
//# sourceMappingURL=full-session.js.map