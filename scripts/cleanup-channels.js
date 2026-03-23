import WebSocket from 'ws';
import { createECDSAMessageSigner, createAuthRequestMessage, createAuthVerifyMessage, createEIP712AuthMessageSigner, createGetChannelsMessage, createCloseChannelMessage, } from '@erc7824/nitrolite';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { custodyAbi } from '@erc7824/nitrolite/dist/abis/generated.js';
const CLEARNODE_URL = process.env.CLEARNODE_URL || 'wss://clearnet.yellow.com/ws';
const ETH_RPC = process.env.ETHEREUM_RPC_URL;
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY, 'hex');
const ALICE = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325';
const CUSTODY = '0x6F71a38d919ad713D0AfE0eB712b95064Fc2616f';
const ADJUDICATOR = '0x14980dF216722f14c42CA7357b06dEa7eB408b10';
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
    const aliceRow = await prisma.managedKey.findUnique({ where: { address: ALICE } });
    await prisma.$disconnect();
    const aliceKey = decrypt(aliceRow.encryptedKey, aliceRow.iv, aliceRow.tag);
    const aliceAccount = privateKeyToAccount(aliceKey);
    const aliceSigner = createECDSAMessageSigner(aliceKey);
    const publicClient = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });
    const aliceWC = createWalletClient({ account: aliceAccount, chain: mainnet, transport: http(ETH_RPC) });
    const rpc = new RPC();
    await rpc.connect(CLEARNODE_URL);
    await authUser(rpc, ALICE, aliceAccount);
    const channels = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
    const resizing = channels.channels?.filter((c) => c.status === 'resizing') || [];
    console.log(`Found ${resizing.length} resizing channels\n`);
    for (const ch of resizing) {
        const channelId = ch.channel_id;
        console.log(`Channel: ${channelId.slice(0, 14)}...`);
        try {
            const data = await publicClient.readContract({
                address: CUSTODY, abi: custodyAbi, functionName: 'getChannelData',
                args: [channelId],
            });
            const [channel, status, wallets, challengeExpiry, lastState] = data;
            console.log(`  On-chain: status=${status} version=${lastState.version}`);
            if (status === 0) {
                console.log('  Not on-chain (status=0). ClearNode-only, need close_channel RPC.');
            }
            else if (status === 2) {
                console.log('  On-chain ACTIVE. Need on-chain close.');
                try {
                    const closeResult = await rpc.call((s, id) => createCloseChannelMessage(s, channelId, ALICE, id), aliceSigner);
                    console.log('  close_channel result:', JSON.stringify(closeResult, null, 2));
                }
                catch (e) {
                    console.log('  close_channel error:', e.message);
                }
            }
        }
        catch (e) {
            console.log('  getChannelData error:', e.message.slice(0, 200));
        }
        console.log();
    }
    console.log('=== After close attempts ===');
    const ch2 = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
    for (const c of ch2.channels || []) {
        console.log(`  ${c.channel_id.slice(0, 14)}... status=${c.status} amount=${c.amount}`);
    }
    rpc.close();
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
//# sourceMappingURL=cleanup-channels.js.map