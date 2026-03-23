import WebSocket from 'ws';
import { createECDSAMessageSigner, createAuthRequestMessage, createAuthVerifyMessage, createEIP712AuthMessageSigner, createGetConfigMessage, createGetChannelsMessage, createGetLedgerBalancesMessage, createCreateChannelMessage, createResizeChannelMessage, createAppSessionMessage, NitroliteClient, WalletStateSigner, RPCProtocolVersion, } from '@erc7824/nitrolite';
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
                const text = data.toString();
                const msg = JSON.parse(text);
                if (msg.res) {
                    const [id, method, result] = msg.res;
                    const p = this.pending.get(id);
                    if (p) {
                        this.pending.delete(id);
                        if (result?.error) {
                            console.log(`  [RPC ERROR] id=${id} method=${method} error=${JSON.stringify(result.error)}`);
                            p.reject(new Error(`${method}: ${result.error}`));
                        }
                        else {
                            p.resolve(result);
                        }
                    }
                }
                else if (!msg.req) {
                    console.log(`  [MSG] ${text.slice(0, 200)}`);
                }
            });
        });
    }
    sendRaw(id, msg) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')); }, 30000);
            this.pending.set(id, {
                resolve: r => { clearTimeout(t); resolve(r); },
                reject: e => { clearTimeout(t); reject(e); },
            });
            this.ws.send(msg);
        });
    }
    async call(build, signer) {
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
async function waitForChannel(rpc, signer, address, channelId, maxWaitSec = 120) {
    console.log(`  Waiting for ClearNode to detect channel ${channelId.slice(0, 14)}...`);
    for (let i = 1; i <= maxWaitSec / 5; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const ch = await rpc.call((s, id) => createGetChannelsMessage(s, address, undefined, id), signer);
        const found = ch.channels?.find((c) => c.channel_id === channelId && c.status === 'open');
        if (found) {
            console.log(`  ✅ Detected after ${i * 5}s (amount=${found.amount})`);
            return found;
        }
        if (i % 6 === 0)
            console.log(`  Still waiting... (${i * 5}s)`);
    }
    throw new Error(`Channel ${channelId} not detected after ${maxWaitSec}s`);
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
    const aliceCh = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE2, undefined, id), aliceSigner);
    const aliceOpen = aliceCh.channels?.find((c) => c.status === 'open');
    console.log(`Alice open channel: ${aliceOpen ? aliceOpen.channel_id.slice(0, 14) + '... amount=' + aliceOpen.amount : 'NONE'}`);
    const aliceBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
    console.log(`Alice ledger: ${JSON.stringify(aliceBal.ledger_balances)}`);
    let aliceChannelId;
    const aliceHasLedger = (aliceBal.ledger_balances?.length ?? 0) > 0;
    if (aliceHasLedger) {
        console.log('\n✅ Alice already has ledger balance, skipping channel creation');
        aliceChannelId = aliceOpen?.channel_id;
    }
    else if (aliceOpen && BigInt(aliceOpen.amount) >= DEPOSIT) {
        console.log('\n✅ Alice already has funded open channel, skipping');
        aliceChannelId = aliceOpen.channel_id;
    }
    else {
        console.log('\n=== STEP 1: Create + Fund Alice channel ===');
        console.log('1a. create_channel RPC...');
        const channelResult = await rpc.call((s, id) => createCreateChannelMessage(s, { chain_id: 1, token: USDC }, id), aliceSigner);
        aliceChannelId = channelResult.channel_id;
        console.log(`  channel_id: ${aliceChannelId}`);
        console.log(`  channel: ${JSON.stringify(channelResult.channel)}`);
        console.log(`  state allocations: ${JSON.stringify(channelResult.state?.allocations)}`);
        console.log('1b. On-chain createChannel (using existing Custody balance)...');
        const aliceWalletClient = createWalletClient({ account: aliceAccount, chain: mainnet, transport: http(ETH_RPC) });
        const nitrolite = new NitroliteClient({
            publicClient,
            walletClient: aliceWalletClient,
            stateSigner: new WalletStateSigner(aliceWalletClient),
            addresses: { custody: CUSTODY, adjudicator: ADJUDICATOR },
            chainId: 1,
            challengeDuration: BigInt(channelResult.channel.challenge),
        });
        const createParams = {
            channel: {
                participants: channelResult.channel.participants.map((p) => p),
                adjudicator: channelResult.channel.adjudicator,
                challenge: BigInt(channelResult.channel.challenge),
                nonce: BigInt(channelResult.channel.nonce),
            },
            unsignedInitialState: {
                intent: channelResult.state.intent,
                version: BigInt(channelResult.state.version),
                data: (channelResult.state.state_data || '0x'),
                allocations: channelResult.state.allocations.map((a) => ({
                    destination: a.destination,
                    token: a.token,
                    amount: BigInt(a.amount),
                })),
            },
            serverSignature: channelResult.server_signature,
        };
        try {
            const { txHash, channelId } = await nitrolite.createChannel(createParams);
            console.log(`  ✅ On-chain tx: ${txHash}`);
            console.log(`  channelId: ${channelId}`);
        }
        catch (err) {
            console.log(`  createChannel failed: ${err.message}`);
            console.log('  Trying depositAndCreateChannel with 0 amount...');
            const { txHash } = await nitrolite.depositAndCreateChannel(USDC, 0n, createParams);
            console.log(`  ✅ On-chain tx: ${txHash}`);
        }
        console.log('1c. Waiting for ClearNode...');
        await waitForChannel(rpc, aliceSigner, ALICE2, aliceChannelId);
        console.log('1d. resize_channel RPC...');
        const resizeResult = await rpc.call((s, id) => createResizeChannelMessage(s, {
            channel_id: aliceChannelId,
            resize_amount: DEPOSIT,
            funds_destination: ALICE2,
        }, id), aliceSigner);
        console.log(`  ✅ Resize result: ${JSON.stringify(resizeResult).slice(0, 200)}`);
    }
    await authUser(rpc, BOB, bobAccount);
    const bobCh = await rpc.call((s, id) => createGetChannelsMessage(s, BOB, undefined, id), bobSigner);
    const bobOpen = bobCh.channels?.find((c) => c.status === 'open');
    const bobBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), bobSigner);
    let bobChannelId;
    const bobHasLedger = (bobBal.ledger_balances?.length ?? 0) > 0;
    if (bobHasLedger) {
        console.log('\n✅ Bob already has ledger balance, skipping channel creation');
        bobChannelId = bobOpen?.channel_id;
    }
    else if (bobOpen && BigInt(bobOpen.amount) >= DEPOSIT) {
        console.log('\n✅ Bob already has funded open channel, skipping');
        bobChannelId = bobOpen.channel_id;
    }
    else {
        console.log('\n=== STEP 2: Create + Fund Bob channel ===');
        console.log('2a. create_channel RPC...');
        const channelResult = await rpc.call((s, id) => createCreateChannelMessage(s, { chain_id: 1, token: USDC }, id), bobSigner);
        bobChannelId = channelResult.channel_id;
        console.log(`  channel_id: ${bobChannelId}`);
        console.log('2b. On-chain depositAndCreateChannel (1 USDC)...');
        const bobWalletClient = createWalletClient({ account: bobAccount, chain: mainnet, transport: http(ETH_RPC) });
        const nitrolite = new NitroliteClient({
            publicClient,
            walletClient: bobWalletClient,
            stateSigner: new WalletStateSigner(bobWalletClient),
            addresses: { custody: CUSTODY, adjudicator: ADJUDICATOR },
            chainId: 1,
            challengeDuration: BigInt(channelResult.channel.challenge),
        });
        const createParams = {
            channel: {
                participants: channelResult.channel.participants.map((p) => p),
                adjudicator: channelResult.channel.adjudicator,
                challenge: BigInt(channelResult.channel.challenge),
                nonce: BigInt(channelResult.channel.nonce),
            },
            unsignedInitialState: {
                intent: channelResult.state.intent,
                version: BigInt(channelResult.state.version),
                data: (channelResult.state.state_data || '0x'),
                allocations: channelResult.state.allocations.map((a) => ({
                    destination: a.destination,
                    token: a.token,
                    amount: BigInt(a.amount),
                })),
            },
            serverSignature: channelResult.server_signature,
        };
        const { txHash } = await nitrolite.depositAndCreateChannel(USDC, DEPOSIT, createParams);
        console.log(`  ✅ On-chain tx: ${txHash}`);
        console.log('2c. Waiting for ClearNode...');
        await waitForChannel(rpc, bobSigner, BOB, bobChannelId);
        console.log('2d. resize_channel RPC...');
        const resizeResult = await rpc.call((s, id) => createResizeChannelMessage(s, {
            channel_id: bobChannelId,
            resize_amount: DEPOSIT,
            funds_destination: BOB,
        }, id), bobSigner);
        console.log(`  ✅ Resize result: ${JSON.stringify(resizeResult).slice(0, 200)}`);
    }
    console.log('\n=== STEP 3: Verify ledger balances ===');
    const aliceBalAfter = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
    const bobBalAfter = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), bobSigner);
    console.log(`Alice ledger: ${JSON.stringify(aliceBalAfter)}`);
    console.log(`Bob ledger:   ${JSON.stringify(bobBalAfter)}`);
    console.log('\n=== STEP 4: Create app session (1 USDC each) ===');
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
                { asset: 'usdc', amount: String(DEPOSIT), participant: ALICE2 },
                { asset: 'usdc', amount: String(DEPOSIT), participant: BOB },
            ],
        }, id), aliceSigner, [aliceSigner, bobSigner]);
        console.log('✅ App session created!');
        console.log(JSON.stringify(result, null, 2));
    }
    catch (err) {
        console.log('❌ App session error:', err.message);
    }
    console.log('\n=== Final ledger balances ===');
    const aliceFinal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
    const bobFinal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), bobSigner);
    console.log(`Alice: ${JSON.stringify(aliceFinal)}`);
    console.log(`Bob:   ${JSON.stringify(bobFinal)}`);
    rpc.close();
    console.log('\nDone.');
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
//# sourceMappingURL=fund-and-session.js.map