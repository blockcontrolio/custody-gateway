import WebSocket from 'ws';
import { createECDSAMessageSigner, createAuthRequestMessage, createAuthVerifyMessage, createEIP712AuthMessageSigner, createGetChannelsMessage, createGetLedgerBalancesMessage, createGetLedgerEntriesMessage, } from '@erc7824/nitrolite';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
const CLEARNODE_URL = process.env.CLEARNODE_URL || 'wss://clearnet.yellow.com/ws';
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY, 'hex');
const ALICE2 = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325';
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
            const t = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout')); }, 15000);
            this.pending.set(id, { resolve: r => { clearTimeout(t); res(r); }, reject: e => { clearTimeout(t); rej(e); } });
            this.ws.send(msg);
        });
    }
    async call(build, signer) {
        const id = this.nextId++;
        return this.sendRaw(id, await build(signer, id));
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
    await authUser(rpc, ALICE2, aliceAccount);
    await authUser(rpc, BOB, bobAccount);
    console.log('=== Channels ===');
    const aliceCh = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE2, undefined, id), aliceSigner);
    for (const c of aliceCh.channels || [])
        console.log(`  Alice: ${c.channel_id.slice(0, 14)}... status=${c.status} amount=${c.amount} token=${c.token?.slice(0, 10)}`);
    const bobCh = await rpc.call((s, id) => createGetChannelsMessage(s, BOB, undefined, id), bobSigner);
    for (const c of bobCh.channels || [])
        console.log(`  Bob: ${c.channel_id.slice(0, 14)}... status=${c.status} amount=${c.amount} token=${c.token?.slice(0, 10)}`);
    console.log('\n=== Ledger Balances ===');
    const aliceBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
    console.log('Alice:', JSON.stringify(aliceBal, null, 2));
    const bobBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), bobSigner);
    console.log('Bob:', JSON.stringify(bobBal, null, 2));
    console.log('\n=== Ledger Entries ===');
    try {
        const aliceEntries = await rpc.call((s, id) => createGetLedgerEntriesMessage(s, ALICE2, undefined, id), aliceSigner);
        console.log('Alice entries:', JSON.stringify(aliceEntries, null, 2));
    }
    catch (e) {
        console.log('Alice entries error:', e.message);
    }
    try {
        const bobEntries = await rpc.call((s, id) => createGetLedgerEntriesMessage(s, BOB, undefined, id), bobSigner);
        console.log('Bob entries:', JSON.stringify(bobEntries, null, 2));
    }
    catch (e) {
        console.log('Bob entries error:', e.message);
    }
    rpc.close();
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
//# sourceMappingURL=check-after-resize.js.map