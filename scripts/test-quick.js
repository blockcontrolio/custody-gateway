import WebSocket from 'ws';
import { createECDSAMessageSigner, createAuthRequestMessage, createAuthVerifyMessage, createEIP712AuthMessageSigner, createGetLedgerBalancesMessage, createGetChannelsMessage, createAppSessionMessage, createCloseChannelMessage, RPCProtocolVersion, } from '@erc7824/nitrolite';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
const CLEARNODE_URL = process.env.CLEARNODE_URL || 'wss://clearnet.yellow.com/ws';
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY, 'hex');
const ALICE2 = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325';
const BOB = '0x772ddE0ba5C672b72b4FB740c2FaB5F1Bcf6Cc2C';
function decrypt(encrypted, iv, tag) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString('utf8');
}
class RPC {
    ws;
    pending = new Map();
    nextId = 1;
    async connect(url) {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(url);
            this.ws.on('open', () => resolve());
            this.ws.on('error', reject);
            this.ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.res) {
                    const [requestId, method, result] = msg.res;
                    const p = this.pending.get(requestId);
                    if (p) {
                        this.pending.delete(requestId);
                        if (result?.error)
                            p.reject(new Error(`${method}: ${result.error}`));
                        else
                            p.resolve(result);
                    }
                }
            });
        });
    }
    sendRaw(id, msg) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')); }, 15000);
            this.pending.set(id, { resolve: r => { clearTimeout(t); resolve(r); }, reject: e => { clearTimeout(t); reject(e); } });
            this.ws.send(msg);
        });
    }
    call(build, signer) {
        const id = this.nextId++;
        return this.sendRaw(id, '').then(() => { }).catch(() => { }) || build(signer, id).then(msg => this.sendRaw(id, msg));
    }
    async callSimple(build, signer) {
        const id = this.nextId++;
        const msg = await build(signer, id);
        return this.sendRaw(id, msg);
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
async function auth(rpc, address, account, signer) {
    const sk = generatePrivateKey();
    const skAddr = privateKeyToAccount(sk).address;
    const params = { address, session_key: skAddr, application: 'clearnode', allowances: [], expires_at: BigInt(Math.floor(Date.now() / 1000) + 86400), scope: 'transfer,app.create' };
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
    const rpc = new RPC();
    await rpc.connect(CLEARNODE_URL);
    console.log('Connected');
    await auth(rpc, ALICE2, aliceAccount, aliceSigner);
    await auth(rpc, BOB, bobAccount, bobSigner);
    console.log('\n=== Channels ===');
    const aliceCh = await rpc.callSimple((s, id) => createGetChannelsMessage(s, ALICE2, undefined, id), aliceSigner);
    for (const c of aliceCh.channels || [])
        console.log(`  Alice: ${c.channel_id.slice(0, 10)}... status=${c.status} amount=${c.amount}`);
    const bobCh = await rpc.callSimple((s, id) => createGetChannelsMessage(s, BOB, undefined, id), bobSigner);
    for (const c of bobCh.channels || [])
        console.log(`  Bob: ${c.channel_id.slice(0, 10)}... status=${c.status} amount=${c.amount}`);
    console.log('\n=== Ledger Balances ===');
    const aliceBal = await rpc.callSimple((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
    console.log('Alice:', JSON.stringify(aliceBal));
    const bobBal = await rpc.callSimple((s, id) => createGetLedgerBalancesMessage(s, undefined, id), bobSigner);
    console.log('Bob:', JSON.stringify(bobBal));
    const resizingCh = aliceCh.channels?.find((c) => c.status === 'resizing');
    if (resizingCh) {
        console.log('\n=== Closing stuck resizing channel', resizingCh.channel_id.slice(0, 10), '===');
        try {
            const closeResult = await rpc.callSimple((s, id) => createCloseChannelMessage(s, resizingCh.channel_id, ALICE2, id), aliceSigner);
            console.log('Close result:', JSON.stringify(closeResult).slice(0, 200));
        }
        catch (err) {
            console.log('Close error:', err.message);
        }
    }
    console.log('\n=== Create App Session (1 USDC Alice, 0 Bob) ===');
    try {
        const result = await rpc.callCoSigned((s, id) => createAppSessionMessage(s, {
            definition: {
                protocol: RPCProtocolVersion.NitroRPC_0_4,
                participants: [ALICE2, BOB],
                weights: [100, 100],
                quorum: 200,
                challenge: 86400,
                nonce: Date.now(),
                application: 'custody-gateway',
            },
            allocations: [
                { asset: 'usdc', amount: String(1_000000), participant: ALICE2 },
                { asset: 'usdc', amount: '0', participant: BOB },
            ],
        }, id), aliceSigner, [aliceSigner, bobSigner]);
        console.log('✅ App session:', JSON.stringify(result, null, 2));
    }
    catch (err) {
        console.log('App session error:', err.message);
    }
    rpc.close();
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
//# sourceMappingURL=test-quick.js.map