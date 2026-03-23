import * as readline from 'readline';
const BASE = process.env.BASE_URL ?? 'http://localhost:3333';
const API_KEY = process.env.CUSTODY_API_KEY ?? '';
async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY)
        headers['X-API-Key'] = API_KEY;
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json();
    if (!res.ok) {
        console.error(`  ERROR ${res.status}:`, JSON.stringify(json, null, 2));
        throw new Error(`${method} ${path} → ${res.status}`);
    }
    return json;
}
function prompt(msg) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(r => rl.question(msg, () => { rl.close(); r(); }));
}
const log = (s) => console.log(`\n[${new Date().toISOString().slice(11, 19)}] ${s}`);
async function main() {
    console.log('═'.repeat(50));
    console.log('  BlockControl — Mainnet Flow');
    console.log('═'.repeat(50));
    log('Health check');
    const h = await api('GET', '/health');
    console.log(`  ws=${h.websocket}  db=${h.database}  auth=${h.auth}`);
    if (h.websocket !== 'connected')
        throw new Error('WebSocket not connected');
    log('Creating users');
    const a = await api('POST', '/users', { label: 'Alice' });
    const b = await api('POST', '/users', { label: 'Bob' });
    const walletA = a.wallet.address;
    const walletB = b.wallet.address;
    console.log(`  Alice: ${walletA}`);
    console.log(`  Bob:   ${walletB}`);
    console.log('\n' + '─'.repeat(50));
    console.log('  Fund Alice\'s wallet:');
    console.log(`  Address: ${walletA}`);
    console.log('  Need: 5 USDC + ~0.01 ETH');
    console.log('  USDC: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    console.log('─'.repeat(50));
    await prompt('\n  Press ENTER when funded... ');
    log('Checking Alice balance');
    const bal = await api('GET', `/users/${a.userId}/balance`);
    console.log(`  ETH: ${bal.eth}`);
    console.log(`  Tokens:`, JSON.stringify(bal.tokens));
    log('Alice invites Bob');
    const inv = await api('POST', '/sessions/invite', {
        initiator: walletA,
        invitee: walletB,
        token: 'usdc',
        amountInitiator: '5000000',
        amountInvitee: '0',
    });
    console.log(`  Invitation: ${inv.id}`);
    log('Bob accepts (auto: auth → deposit → channel → resize → session)');
    const session = await api('POST', `/sessions/invitations/${inv.id}/accept`);
    const sessionId = session.sessionId;
    console.log(`  Session: ${sessionId}`);
    log('State change: Alice → Bob (2 USDC)');
    await api('POST', `/sessions/${sessionId}/state`, {
        intent: 'operate',
        version: 2,
        allocations: [
            { asset: 'usdc', amount: '3000000', participant: walletA },
            { asset: 'usdc', amount: '2000000', participant: walletB },
        ],
    });
    console.log('  Done');
    log('Closing session (auto: close channels → withdraw)');
    const close = await api('POST', `/sessions/${sessionId}/close`, {
        allocations: [
            { asset: 'usdc', amount: '3000000', participant: walletA },
            { asset: 'usdc', amount: '2000000', participant: walletB },
        ],
        asset: 'usdc',
    });
    console.log('  Settlements:', JSON.stringify(close.settlements, null, 2));
    log('Final balances');
    const balA = await api('GET', `/users/${a.userId}/balance`);
    const balB = await api('GET', `/users/${b.userId}/balance`);
    console.log(`  Alice: ${JSON.stringify(balA.tokens)}`);
    console.log(`  Bob:   ${JSON.stringify(balB.tokens)}`);
    console.log('\n' + '═'.repeat(50));
    console.log('  DONE');
    console.log(`  Alice: 5 USDC → 3 USDC`);
    console.log(`  Bob:   0 USDC → 2 USDC`);
    console.log('═'.repeat(50));
}
main().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
//# sourceMappingURL=mainnet-flow.js.map