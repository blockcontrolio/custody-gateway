import { createECDSAMessageSigner, createCreateChannelMessage, createGetChannelsMessage, createGetLedgerBalancesMessage, createAuthRequestMessage, createAuthVerifyMessage, createEIP712AuthMessageSigner, } from '@erc7824/nitrolite';
import WebSocket from 'ws';
import { privateKeyToAccount } from 'viem/accounts';
import { generatePrivateKey } from 'viem/accounts';
const CLEARNODE_URL = process.env.CLEARNODE_URL;
const PRIVATE_KEY_A = process.env.YELLOW_SIGNER_PRIVATE_KEY;
const PRIVATE_KEY_B = process.env.YELLOW_SIGNER_PRIVATE_KEY_B;
if (!CLEARNODE_URL || !PRIVATE_KEY_A) {
    console.error('Missing env vars');
    process.exit(1);
}
const accountA = privateKeyToAccount(PRIVATE_KEY_A);
const accountB = PRIVATE_KEY_B ? privateKeyToAccount(PRIVATE_KEY_B) : null;
console.log('Wallet A:', accountA.address);
if (accountB)
    console.log('Wallet B:', accountB.address);
console.log('ClearNode:', CLEARNODE_URL);
const signerA = createECDSAMessageSigner(PRIVATE_KEY_A);
let requestCounter = Date.now();
function nextId() { return requestCounter++; }
class ClearNodeClient {
    ws;
    pending = new Map();
    async connect(url) {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(url);
            this.ws.onopen = () => { console.log('✅ Connected'); resolve(); };
            this.ws.onerror = (e) => reject(new Error(`WS error: ${e.message}`));
            this.ws.onmessage = (event) => {
                const text = typeof event.data === 'string' ? event.data : event.data.toString();
                try {
                    const parsed = JSON.parse(text);
                    if (parsed.res && Array.isArray(parsed.res)) {
                        const [reqId, method, result] = parsed.res;
                        const p = this.pending.get(reqId);
                        if (p) {
                            this.pending.delete(reqId);
                            if (method === 'error')
                                p.reject(new Error(JSON.stringify(result)));
                            else
                                p.resolve({ method, result, sig: parsed.sig });
                        }
                        else {
                            console.log(`  <- notification: ${method}`, JSON.stringify(result).slice(0, 100));
                        }
                    }
                }
                catch { }
            };
        });
    }
    async send(msgJson, requestId) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`Timeout reqId=${requestId}`));
            }, 15000);
            this.pending.set(requestId, {
                resolve: (v) => { clearTimeout(timeout); resolve(v); },
                reject: (e) => { clearTimeout(timeout); reject(e); },
            });
            this.ws.send(msgJson);
        });
    }
    sendRaw(msg) { this.ws.send(msg); }
    close() { this.ws?.close(); }
}
async function authenticate(client, privateKey) {
    const account = privateKeyToAccount(privateKey);
    const signer = createECDSAMessageSigner(privateKey);
    const sessionKeyPrivate = generatePrivateKey();
    const sessionKeyAddress = privateKeyToAccount(sessionKeyPrivate).address;
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 86400);
    const authParams = {
        address: account.address,
        session_key: sessionKeyAddress,
        application: 'clearnode',
        allowances: [],
        expires_at: expiresAt,
        scope: 'console',
    };
    const reqId1 = nextId();
    const authReqStr = await createAuthRequestMessage(authParams, reqId1, Date.now());
    const challengeResp = await client.send(authReqStr, reqId1);
    console.log(`  auth_challenge received for ${account.address}`);
    const challengeMessage = challengeResp.result?.challengeMessage ?? challengeResp.result?.challenge_message;
    if (!challengeMessage)
        throw new Error('No challengeMessage in response');
    const partialMessage = {
        scope: authParams.scope,
        session_key: authParams.session_key,
        expires_at: authParams.expires_at,
        allowances: authParams.allowances,
    };
    const domain = { name: authParams.application };
    const walletLikeClient = {
        account,
        signTypedData: (args) => account.signTypedData(args),
    };
    const eip712Signer = createEIP712AuthMessageSigner(walletLikeClient, partialMessage, domain);
    const challengeResponse = {
        method: 'auth_challenge',
        params: { challengeMessage },
    };
    const reqId2 = nextId();
    const verifyStr = await createAuthVerifyMessage(eip712Signer, challengeResponse, reqId2, Date.now());
    const verifyResp = await client.send(verifyStr, reqId2);
    const jwt = verifyResp.result?.jwt_token ?? verifyResp.result?.jwtToken;
    if (jwt) {
        console.log(`  ✅ Authenticated ${account.address} (JWT: ${jwt.slice(0, 20)}...)`);
    }
    else {
        console.log('  Auth response:', JSON.stringify(verifyResp.result));
    }
}
async function main() {
    const client = new ClearNodeClient();
    await client.connect(CLEARNODE_URL);
    try {
        console.log('\n=== 1. Authenticate ===');
        await authenticate(client, PRIVATE_KEY_A);
        console.log('\n=== 2. Ledger balances ===');
        const balReqId = nextId();
        const balMsg = await createGetLedgerBalancesMessage(signerA, undefined, balReqId, Date.now());
        const balResp = await client.send(balMsg, balReqId);
        console.log('Balances:', JSON.stringify(balResp.result, null, 2));
        console.log('\n=== 3. Channels ===');
        const chReqId = nextId();
        const chMsg = await createGetChannelsMessage(signerA, accountA.address, undefined, chReqId, Date.now());
        const chResp = await client.send(chMsg, chReqId);
        const channels = chResp.result?.channels || [];
        console.log(`Found ${channels.length} channels for ${accountA.address}`);
        for (const ch of channels) {
            console.log(`  ${ch.channel_id?.slice(0, 18)}... status=${ch.status} chain=${ch.chain_id} amount=${ch.amount} token=${ch.token?.slice(0, 10)}...`);
        }
        console.log('\n=== 4. Create channel (Base USDC) ===');
        const baseUSDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
        const createReqId = nextId();
        const createMsg = await createCreateChannelMessage(signerA, { chain_id: 8453, token: baseUSDC }, createReqId, Date.now());
        const createResp = await client.send(createMsg, createReqId);
        console.log('Create channel response:', JSON.stringify(createResp.result, null, 2));
        console.log('Server sig:', JSON.stringify(createResp.sig));
    }
    catch (err) {
        console.error('❌ Error:', err);
    }
    finally {
        client.close();
        await new Promise(r => setTimeout(r, 500));
    }
}
main();
//# sourceMappingURL=test-channel-flow.js.map