import WebSocket from 'ws';
import { privateKeyToAccount } from 'viem/accounts';
import { createAuthRequestMessage, createAuthVerifyMessage, createEIP712AuthMessageSigner, createGetConfigMessageV2, createAppSessionMessage, createECDSAMessageSigner, RPCProtocolVersion, } from '@erc7824/nitrolite';
import 'dotenv/config';
const WALLET_A_KEY = (process.env.YELLOW_SIGNER_PRIVATE_KEY ?? '');
const WALLET_B_KEY = (process.env.YELLOW_SIGNER_PRIVATE_KEY_B ?? '');
if (!WALLET_A_KEY || !WALLET_B_KEY) {
    throw new Error('Set YELLOW_SIGNER_PRIVATE_KEY and YELLOW_SIGNER_PRIVATE_KEY_B in .env');
}
const SANDBOX_URL = 'wss://clearnet-sandbox.yellow.com/ws';
const accountA = privateKeyToAccount(WALLET_A_KEY);
const accountB = privateKeyToAccount(WALLET_B_KEY);
console.log('Wallet A:', accountA.address);
console.log('Wallet B:', accountB.address);
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function connectWs() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(SANDBOX_URL);
        const messages = [];
        const waitFor = (filter, timeoutMs = 15000) => {
            return new Promise((res, rej) => {
                const timeout = setTimeout(() => rej(new Error('Timeout waiting for message')), timeoutMs);
                const check = () => {
                    const idx = messages.findIndex(filter);
                    if (idx >= 0) {
                        clearTimeout(timeout);
                        res(messages.splice(idx, 1)[0]);
                        return;
                    }
                    setTimeout(check, 50);
                };
                check();
            });
        };
        ws.onmessage = (event) => {
            const text = typeof event.data === 'string'
                ? event.data
                : Buffer.from(event.data).toString('utf8');
            try {
                const parsed = JSON.parse(text);
                console.log('← RECV:', JSON.stringify(parsed, null, 2));
                messages.push(parsed);
            }
            catch {
                console.log('← RAW:', text.slice(0, 500));
            }
        };
        ws.onerror = (err) => {
            console.error('WS error:', err.message);
            reject(new Error(err.message));
        };
        ws.onopen = () => {
            console.log('✓ Connected to', SANDBOX_URL);
            resolve({ ws, messages, waitFor });
        };
    });
}
async function run() {
    const { ws, messages, waitFor } = await connectWs();
    await sleep(500);
    messages.length = 0;
    console.log('\n===== Step 1: get_config =====');
    const configMsg = createGetConfigMessageV2(1, Date.now());
    console.log('→ SEND:', configMsg);
    ws.send(configMsg);
    try {
        const configResp = await waitFor((m) => {
            const msg = m;
            return Array.isArray(msg.res) && msg.res[0] === 1;
        }, 5000);
        console.log('Config received OK');
    }
    catch {
        console.log('No config response (timeout)');
    }
    console.log('\n===== Step 2: auth_request =====');
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 24 * 3600);
    const APPLICATION = 'sandbox-test';
    const SCOPE = 'console';
    const authParams = {
        address: accountA.address,
        session_key: accountA.address,
        application: APPLICATION,
        allowances: [],
        expires_at: expiresAt,
        scope: SCOPE,
    };
    console.log('Auth params:', JSON.stringify(authParams, (_, v) => typeof v === 'bigint' ? v.toString() : v));
    const authReqStr = await createAuthRequestMessage(authParams, 100, Date.now());
    console.log('→ SEND:', authReqStr);
    ws.send(authReqStr);
    let challengeMsg;
    try {
        challengeMsg = (await waitFor((m) => {
            const msg = m;
            return Array.isArray(msg.res) && msg.res[1] === 'auth_challenge';
        }, 10000));
    }
    catch {
        console.log('✗ No auth_challenge received. Check messages above.');
        ws.close();
        return;
    }
    console.log('\n===== Step 3: auth_verify =====');
    const challengeResult = challengeMsg.res[2];
    const challenge = challengeResult.challengeMessage ?? challengeResult.challenge_message;
    console.log('Challenge UUID:', challenge);
    const partialMessage = {
        scope: SCOPE,
        session_key: accountA.address,
        expires_at: expiresAt,
        allowances: [],
    };
    const domain = { name: APPLICATION };
    console.log('EIP712 domain:', JSON.stringify(domain));
    console.log('EIP712 partial message:', JSON.stringify(partialMessage, (_, v) => typeof v === 'bigint' ? v.toString() : v));
    const walletLikeClient = {
        account: accountA,
        signTypedData: (args) => accountA.signTypedData(args),
    };
    const eip712Signer = createEIP712AuthMessageSigner(walletLikeClient, partialMessage, domain);
    const authChallengeResp = {
        method: 'auth_challenge',
        params: { challengeMessage: challenge },
    };
    const verifyStr = await createAuthVerifyMessage(eip712Signer, authChallengeResp, 101, Date.now());
    console.log('→ SEND:', verifyStr);
    ws.send(verifyStr);
    console.log('\n===== Step 4: Waiting for auth result =====');
    try {
        const resp = (await waitFor((m) => {
            const msg = m;
            return Array.isArray(msg.res) && msg.res[0] === 101;
        }, 10000));
        const method = resp.res[1];
        const result = resp.res[2];
        if (method === 'error') {
            console.log('\n✗ AUTH FAILED');
            console.log('Error:', JSON.stringify(result, null, 2));
            for (const [key, val] of Object.entries(result)) {
                console.log(`  ${key}: ${val}`);
            }
        }
        else {
            console.log('\n✓ AUTH SUCCESS');
            console.log('Method:', method);
            console.log('Result:', JSON.stringify(result, null, 2));
        }
    }
    catch (err) {
        console.log('✗ Timeout waiting for auth response');
    }
    console.log('\n===== Step 5: Try RPC methods =====');
    const methods = [
        { id: 200, method: 'ping', params: {} },
        { id: 201, method: 'get_channels', params: {} },
        { id: 203, method: 'get_ledger_balances', params: {} },
        { id: 204, method: 'get_assets', params: {} },
    ];
    for (const { id, method, params } of methods) {
        const req = JSON.stringify({ req: [id, method, params, Date.now()], sig: [] });
        console.log(`→ ${method}`);
        ws.send(req);
    }
    await sleep(3000);
    console.log(`\n(Received ${messages.length} RPC responses)`);
    messages.length = 0;
    console.log('\n===== Step 6: Create App Session =====');
    const signer = createECDSAMessageSigner(WALLET_A_KEY);
    const sessionParams = {
        definition: {
            protocol: RPCProtocolVersion.NitroRPC_0_2,
            participants: [accountA.address, accountB.address],
            weights: [50, 50],
            quorum: 100,
            challenge: 0,
            nonce: Date.now(),
            application: APPLICATION,
        },
        allocations: [
            { participant: accountA.address, asset: 'ytest.usd', amount: '0' },
            { participant: accountB.address, asset: 'ytest.usd', amount: '0' },
        ],
    };
    console.log('Session params:', JSON.stringify(sessionParams, null, 2));
    const sessionMsg = await createAppSessionMessage(signer, sessionParams, 300, Date.now());
    console.log('→ SEND create_app_session:', sessionMsg.slice(0, 200) + '...');
    ws.send(sessionMsg);
    try {
        const sessionResp = (await waitFor((m) => {
            const msg = m;
            return Array.isArray(msg.res) && msg.res[0] === 300;
        }, 10000));
        const sessionMethod = sessionResp.res[1];
        const sessionResult = sessionResp.res[2];
        if (sessionMethod === 'error') {
            console.log('\n✗ CREATE APP SESSION FAILED');
            console.log('Error:', JSON.stringify(sessionResult, null, 2));
        }
        else {
            console.log('\n✓ APP SESSION CREATED');
            console.log('Method:', sessionMethod);
            console.log('Result:', JSON.stringify(sessionResult, null, 2));
        }
    }
    catch {
        console.log('✗ Timeout waiting for create_app_session response');
    }
    await sleep(2000);
    if (messages.length > 0) {
        console.log('\n=== Remaining messages ===');
        for (const m of messages) {
            console.log(JSON.stringify(m, null, 2));
        }
    }
    ws.close();
}
run().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
//# sourceMappingURL=sandbox-test.js.map