import WebSocket from 'ws';
import { createECDSAMessageSigner, createAuthRequestMessage, createAuthVerifyMessage, createEIP712AuthMessageSigner, createGetChannelsMessage, createGetLedgerBalancesMessage, createAppSessionMessage, RPCProtocolVersion, } from '@erc7824/nitrolite';
import { createPublicClient, createWalletClient, http, erc20Abi } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { custodyAbi } from '@erc7824/nitrolite/dist/abis/generated.js';
const CLEARNODE_URL = process.env.CLEARNODE_URL || 'wss://clearnet.yellow.com/ws';
const ETH_RPC = process.env.ETHEREUM_RPC_URL;
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY, 'hex');
const ALICE = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325';
const BOB = '0x772ddE0ba5C672b72b4FB740c2FaB5F1Bcf6Cc2C';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const CUSTODY = '0x6F71a38d919ad713D0AfE0eB712b95064Fc2616f';
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
    console.log('=== Current state ===');
    const rpc = new RPC();
    await rpc.connect(CLEARNODE_URL);
    await authUser(rpc, ALICE, aliceAccount);
    const aliceBal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
    const aliceCh = await rpc.call((s, id) => createGetChannelsMessage(s, ALICE, undefined, id), aliceSigner);
    console.log('Alice ledger:', JSON.stringify(aliceBal));
    const nonClosed = aliceCh.channels?.filter((c) => c.status !== 'closed') || [];
    console.log('Alice non-closed channels:', nonClosed.length);
    for (const c of nonClosed)
        console.log(`  ${c.channel_id.slice(0, 20)}... status=${c.status} amount=${c.amount}`);
    const custodyBal = await publicClient.readContract({
        address: CUSTODY, abi: custodyAbi, functionName: 'getAccountsBalances',
        args: [[ALICE], [USDC]],
    });
    console.log('Alice Custody USDC:', custodyBal[0][0].toString());
    const aliceWalletUSDC = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [ALICE] });
    console.log('Alice wallet USDC:', aliceWalletUSDC.toString());
    console.log('\n=== Direct deposit 1 USDC to Custody ===');
    const approveTx = await aliceWC.writeContract({
        address: USDC, abi: erc20Abi, functionName: 'approve', args: [CUSTODY, DEPOSIT],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log('Approved');
    const depositTx = await aliceWC.writeContract({
        address: CUSTODY, abi: custodyAbi, functionName: 'deposit', args: [ALICE, USDC, DEPOSIT],
    });
    await publicClient.waitForTransactionReceipt({ hash: depositTx });
    console.log('Deposited, tx:', depositTx);
    const afterCustody = await publicClient.readContract({
        address: CUSTODY, abi: custodyAbi, functionName: 'getAccountsBalances',
        args: [[ALICE], [USDC]],
    });
    console.log('Alice Custody USDC after:', afterCustody[0][0].toString());
    console.log('\n=== Waiting for ClearNode ledger update ===');
    let ledgerUpdated = false;
    for (let i = 1; i <= 30; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const bal = await rpc.call((s, id) => createGetLedgerBalancesMessage(s, undefined, id), aliceSigner);
        const amt = bal.ledger_balances?.find((b) => b.asset === 'usdc')?.amount || '0';
        if (i % 3 === 0 || parseFloat(amt) > 0)
            console.log(`  ${i * 5}s: usdc=${amt}`);
        if (parseFloat(amt) > 0) {
            ledgerUpdated = true;
            break;
        }
    }
    if (!ledgerUpdated) {
        console.log('ClearNode did NOT update ledger from direct deposit.');
        rpc.close();
        return;
    }
    console.log('\n=== Create app session ===');
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
//# sourceMappingURL=test-deposit-minimal.js.map