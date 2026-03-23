import WebSocket from 'ws';
import { createECDSAMessageSigner, createAuthRequestMessage, createAuthVerifyMessage, createEIP712AuthMessageSigner, createGetChannelsMessage, createResizeChannelMessage, NitroliteClient, WalletStateSigner, createGetConfigMessage, } from '@erc7824/nitrolite';
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
    const publicClient = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });
    const rpc = new RPC();
    await rpc.connect(CLEARNODE_URL);
    await authUser(rpc, ALICE2, aliceAccount);
    const config = await rpc.call((s, id) => createGetConfigMessage(s, id), aliceSigner);
    const ethNetwork = config.networks?.find((n) => n.chain_id === 1);
    const CUSTODY = ethNetwork.custody_address;
    const ADJUDICATOR = ethNetwork.adjudicator_address;
    const aliceCh = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE2, undefined, id), aliceSigner);
    const resizing = aliceCh.channels?.filter((c) => c.status === 'resizing');
    console.log('Alice resizing channels:', resizing?.length);
    if (!resizing?.length) {
        console.log('No resizing channels, nothing to settle');
        rpc.close();
        return;
    }
    const ch = resizing[0];
    console.log(`\nSettling channel: ${ch.channel_id}`);
    console.log('Full channel data:', JSON.stringify(ch, null, 2));
    const aliceWalletClient = createWalletClient({ account: aliceAccount, chain: mainnet, transport: http(ETH_RPC) });
    const nitrolite = new NitroliteClient({
        publicClient,
        walletClient: aliceWalletClient,
        stateSigner: new WalletStateSigner(aliceWalletClient),
        addresses: { custody: CUSTODY, adjudicator: ADJUDICATOR },
        chainId: 1,
        challengeDuration: 3600n,
    });
    console.log('\n=== On-chain channel data ===');
    try {
        const channelData = await nitrolite.getChannelData(ch.channel_id);
        console.log('Channel data:', JSON.stringify(channelData, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    }
    catch (e) {
        console.log('getChannelData error:', e.message);
    }
    try {
        const balance = await nitrolite.getAccountBalance('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
        console.log('Alice on-chain account balance:', balance.toString());
    }
    catch (e) {
        console.log('getAccountBalance error:', e.message);
    }
    console.log('\n=== Trying resize again to get signed state ===');
    try {
        const resizeResult = await rpc.call((s, id) => createResizeChannelMessage(s, {
            channel_id: ch.channel_id,
            resize_amount: 1000000n,
            funds_destination: ALICE2,
        }, id), aliceSigner);
        console.log('Resize result (full):', JSON.stringify(resizeResult, null, 2));
        if (resizeResult.state) {
            const state = resizeResult.state;
            console.log('\n=== On-chain checkpoint ===');
            const candidateState = {
                intent: state.intent,
                version: BigInt(state.version),
                data: (state.state_data || '0x'),
                allocations: state.allocations?.map((a) => ({
                    destination: a.destination,
                    token: a.token,
                    amount: BigInt(a.amount),
                })) || [],
                sigs: state.sigs || state.signatures || [],
            };
            console.log('Candidate state:', JSON.stringify(candidateState, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
            try {
                const cpHash = await nitrolite.checkpointChannel({
                    channelId: ch.channel_id,
                    candidateState: candidateState,
                    proofStates: [],
                });
                console.log('Checkpoint tx:', cpHash);
            }
            catch (e) {
                console.log('Checkpoint error:', e.message);
            }
        }
    }
    catch (e) {
        console.log('Resize error:', e.message);
    }
    rpc.close();
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
//# sourceMappingURL=settle-resize.js.map