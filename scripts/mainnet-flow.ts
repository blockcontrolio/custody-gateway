/**
 * Mainnet flow test — clean user-facing API.
 *
 * Flow:
 *   1. Create two users
 *   2. Fund User A wallet with USDC + ETH (manual)
 *   3. User A invites User B
 *   4. User B accepts (auto: deposit → channel → resize → session)
 *   5. State change (redistribute funds)
 *   6. Close session (auto: close channels → withdraw → wallets)
 *
 * Run:  npx ts-node scripts/mainnet-flow.ts
 */

import * as readline from 'readline';

const BASE = process.env.BASE_URL ?? 'http://localhost:3333';
const API_KEY = process.env.CUSTODY_API_KEY ?? '';

async function api(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['X-API-Key'] = API_KEY;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    console.error(`  ERROR ${res.status}:`, JSON.stringify(json, null, 2));
    throw new Error(`${method} ${path} → ${res.status}`);
  }
  return json;
}

function prompt(msg: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(msg, () => { rl.close(); r(); }));
}

const log = (s: string) => console.log(`\n[${new Date().toISOString().slice(11, 19)}] ${s}`);

async function main() {
  console.log('═'.repeat(50));
  console.log('  BlockControl — Mainnet Flow');
  console.log('═'.repeat(50));

  // 1. Health
  log('Health check');
  const h = await api('GET', '/health');
  console.log(`  ws=${h.websocket}  db=${h.database}  auth=${h.auth}`);
  if (h.websocket !== 'connected') throw new Error('WebSocket not connected');

  // 2. Create users
  log('Creating users');
  const a = await api('POST', '/users', { label: 'Alice' });
  const b = await api('POST', '/users', { label: 'Bob' });
  const walletA = (a.wallet as any).address;
  const walletB = (b.wallet as any).address;
  console.log(`  Alice: ${walletA}`);
  console.log(`  Bob:   ${walletB}`);

  // 3. Fund
  console.log('\n' + '─'.repeat(50));
  console.log('  Fund Alice\'s wallet:');
  console.log(`  Address: ${walletA}`);
  console.log('  Need: 5 USDC + ~0.01 ETH');
  console.log('  USDC: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  console.log('─'.repeat(50));
  await prompt('\n  Press ENTER when funded... ');

  // 4. Check balance
  log('Checking Alice balance');
  const bal = await api('GET', `/users/${a.userId}/balance`);
  console.log(`  ETH: ${bal.eth}`);
  console.log(`  Tokens:`, JSON.stringify(bal.tokens));

  // 5. Invite
  log('Alice invites Bob');
  const inv = await api('POST', '/sessions/invite', {
    initiator: walletA,
    invitee: walletB,
    token: 'usdc',
    amountInitiator: '5000000', // 5 USDC
    amountInvitee: '0',
  });
  console.log(`  Invitation: ${inv.id}`);

  // 6. Accept (auto-prepare under the hood)
  log('Bob accepts (auto: auth → deposit → channel → resize → session)');
  const session = await api('POST', `/sessions/invitations/${inv.id}/accept`);
  const sessionId = session.sessionId as string;
  console.log(`  Session: ${sessionId}`);

  // 7. State change: Alice sends 2 USDC to Bob
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

  // 8. Close (auto-settle)
  log('Closing session (auto: close channels → withdraw)');
  const close = await api('POST', `/sessions/${sessionId}/close`, {
    allocations: [
      { asset: 'usdc', amount: '3000000', participant: walletA },
      { asset: 'usdc', amount: '2000000', participant: walletB },
    ],
    asset: 'usdc',
  });
  console.log('  Settlements:', JSON.stringify(close.settlements, null, 2));

  // 9. Final balances
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
