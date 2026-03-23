import WebSocket from 'ws';
import { createECDSAMessageSigner, createAuthRequestMessage, createAuthVerifyMessage, createEIP712AuthMessageSigner, createGetConfigMessage, createGetChannelsMessage, createGetLedgerBalancesMessage, createCreateChannelMessage, createResizeChannelMessage, createAppSessionMessage, NitroliteClient, WalletStateSigner, RPCProtocolVersion, } from '@erc7824/nitrolite';
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
            this.ws.on('ping', () => this.ws.pong());
            this.ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.req) {
                    const [id, method] = msg.req;
                    if (method === 'ping') {
                        this.ws.send(JSON.stringify({ res: [id, 'pong', {}, Date.now()] }));
                        return;
                    }
                }
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
            const t = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout')); }, 60000);
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
async function onchainResize(account, publicClient, walletClient, channelId, resizeState, serverSig) {
    const chainData = await publicClient.readContract({
        address: '0x6F71a38d919ad713D0AfE0eB712b95064Fc2616f',
        abi: custodyAbi, functionName: 'getChannelData', args: [channelId],
    });
    const lastState = chainData[4];
    const initProof = {
        intent: Number(lastState.intent), version: lastState.version,
        data: lastState.data,
        allocations: lastState.allocations.map((a) => ({ destination: a.destination, token: a.token, amount: a.amount })),
        sigs: [...lastState.sigs],
    };
    const unsignedResize = {
        intent: resizeState.intent, version: BigInt(resizeState.version),
        data: (resizeState.state_data || '0x'),
        allocations: resizeState.allocations.map((a) => ({ destination: a.destination, token: a.token, amount: BigInt(a.amount) })),
    };
    const packed = getPackedState(channelId, unsignedResize);
    const userSig = await account.signMessage({ message: { raw: packed } });
    const { request } = await publicClient.simulateContract({
        address: '0x6F71a38d919ad713D0AfE0eB712b95064Fc2616f',
        abi: custodyAbi, functionName: 'resize',
        args: [channelId, { ...unsignedResize, sigs: [userSig, serverSig] }, [initProof]],
        account,
    });
    return await walletClient.writeContract(request);
}
async function waitForChannelStatus(rpc, signer, address, channelId, targetStatus, maxWait = 120) {
    for (let i = 1; i <= maxWait / 5; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const ch = await rpc.call((s, id) => createGetChannelsMessage(s, address, undefined, id), signer);
        const found = ch.channels?.find((c) => c.channel_id === channelId);
        if (found?.status === targetStatus) {
            console.log(`  Channel ${targetStatus} after ${i * 5}s (amount=${found.amount})`);
            return found;
        }
        if (i % 4 === 0)
            console.log(`  ${i * 5}s: status=${found?.status} amount=${found?.amount}`);
    }
    throw new Error(`Channel did not reach ${targetStatus} after ${maxWait}s`);
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
    const rpc = new RPC();
    await rpc.connect(CLEARNODE_URL);
    await authUser(rpc, ALICE, aliceAccount);
    const aliceBal0 = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
    const aliceCh0 = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
    console.log('Current ledger:', JSON.stringify(aliceBal0));
    const nonClosed = aliceCh0.channels?.filter((c) => c.status !== 'closed') || [];
    console.log('Non-closed channels:', nonClosed.length);
    const hasLedger = parseFloat(aliceBal0.ledger_balances?.find((b) => b.asset === 'usdc')?.amount || '0') > 0;
    if (hasLedger && nonClosed.length === 0) {
        console.log('Already have ledger balance with no channels. Going to session creation.');
    }
    else {
        console.log('\n=== Step 1: Create channel ===');
        const config = await rpc.call((s, id) => createGetConfigMessage(s, id), aliceSigner);
        const ethNet = config.networks?.find((n) => n.chain_id === 1);
        const CUSTODY = ethNet.custody_address;
        const ADJUDICATOR = ethNet.adjudicator_address;
        const chResult = await rpc.call((s, id) => createCreateChannelMessage(s, { chain_id: 1, token: USDC }, id), aliceSigner);
        const channelId = chResult.channel_id;
        console.log('channel_id:', channelId);
        const nitrolite = new NitroliteClient({
            publicClient, walletClient: aliceWC,
            stateSigner: new WalletStateSigner(aliceWC),
            addresses: { custody: CUSTODY, adjudicator: ADJUDICATOR },
            chainId: 1, challengeDuration: BigInt(chResult.channel.challenge),
        });
        const createParams = {
            channel: {
                participants: chResult.channel.participants.map((p) => p),
                adjudicator: chResult.channel.adjudicator,
                challenge: BigInt(chResult.channel.challenge),
                nonce: BigInt(chResult.channel.nonce),
            },
            unsignedInitialState: {
                intent: chResult.state.intent,
                version: BigInt(chResult.state.version),
                data: (chResult.state.state_data || '0x'),
                allocations: chResult.state.allocations.map((a) => ({
                    destination: a.destination, token: a.token, amount: BigInt(a.amount),
                })),
            },
            serverSignature: chResult.server_signature,
        };
        try {
            const { txHash } = await nitrolite.createChannel(createParams);
            console.log('On-chain create tx:', txHash);
            await publicClient.waitForTransactionReceipt({ hash: txHash });
        }
        catch (e) {
            console.log('createChannel failed, trying depositAndCreateChannel...');
            const { txHash } = await nitrolite.depositAndCreateChannel(USDC, 0n, createParams);
            console.log('On-chain tx:', txHash);
            await publicClient.waitForTransactionReceipt({ hash: txHash });
        }
        console.log('Waiting for channel to be detected...');
        await waitForChannelStatus(rpc, aliceSigner, ALICE, channelId, 'open');
        console.log('\n=== Step 2: resize_channel(resize_amount=1M) ===');
        const resize1 = await rpc.call((s, id) => createResizeChannelMessage(s, {
            channel_id: channelId,
            resize_amount: DEPOSIT,
            funds_destination: ALICE,
        }, id), aliceSigner);
        console.log('Resize state allocations:', JSON.stringify(resize1.state.allocations));
        const tx1 = await onchainResize(aliceAccount, publicClient, aliceWC, channelId, resize1.state, resize1.server_signature);
        console.log('On-chain resize tx:', tx1);
        await publicClient.waitForTransactionReceipt({ hash: tx1 });
        console.log('Waiting for channel to return to open...');
        try {
            await waitForChannelStatus(rpc, aliceSigner, ALICE, channelId, 'open', 120);
        }
        catch (e) {
            console.log('Channel did not return to open, checking state...');
            const ch = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
            const found = ch.channels?.find((c) => c.channel_id === channelId);
            console.log(`Channel: status=${found?.status} amount=${found?.amount}`);
        }
        const bal1 = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
        console.log('Ledger after resize:', JSON.stringify(bal1));
        console.log('\n=== Step 3: resize_channel(allocate_amount=-1M) ===');
        try {
            const resize2 = await rpc.call((s, id) => createResizeChannelMessage(s, {
                channel_id: channelId,
                allocate_amount: -DEPOSIT,
                funds_destination: ALICE,
            }, id), aliceSigner);
            console.log('De-allocate state allocations:', JSON.stringify(resize2.state.allocations));
            const tx2 = await onchainResize(aliceAccount, publicClient, aliceWC, channelId, resize2.state, resize2.server_signature);
            console.log('On-chain de-allocate tx:', tx2);
            await publicClient.waitForTransactionReceipt({ hash: tx2 });
            console.log('Waiting for channel to return to open with 0 amount...');
            try {
                const found = await waitForChannelStatus(rpc, aliceSigner, ALICE, channelId, 'open', 120);
                console.log('Channel amount after de-allocate:', found?.amount);
            }
            catch (e) {
                console.log('Channel did not return to open');
            }
            const bal2 = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
            console.log('Ledger after de-allocate:', JSON.stringify(bal2));
            const ch2 = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
            for (const c of ch2.channels?.filter((c) => c.status !== 'closed') || []) {
                console.log(`Channel: ${c.channel_id.slice(0, 20)}... status=${c.status} amount=${c.amount}`);
            }
        }
        catch (e) {
            console.log('De-allocate error:', e.message);
        }
    }
    console.log('\n=== Step 4: Create app session ===');
    const finalBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
    console.log('Final ledger:', JSON.stringify(finalBal));
    await authUser(rpc, BOB, bobAccount);
    try {
        const result = await rpc.callCoSigned((s, id) => createAppSessionMessage(s, {
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
                { asset: 'usdc', amount: '0', participant: BOB },
            ],
        }, id), aliceSigner, [bobSigner]);
        console.log('SESSION CREATED:', result.app_session_id);
    }
    catch (e) {
        console.log('Session error:', e.message);
    }
    rpc.close();
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
//# sourceMappingURL=test-two-step-resize.js.map