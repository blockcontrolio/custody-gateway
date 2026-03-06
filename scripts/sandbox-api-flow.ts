/**
 * Full sandbox flow via custody-gateway HTTP API:
 *   check balance → create session → transfer A→B → check balance → close session.
 *
 * Prerequisites:
 *   - Gateway running: docker compose up -d --build
 *   - DB up and migrated
 *   - Wallets funded (POST /yellow/faucet)
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/sandbox-api-flow.ts
 * Or:  npm run sandbox:flow
 */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3333';
const WALLET_A = '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2';
const WALLET_B = '0xF44020407a75d7B8525d7aEC114A16f7ebbfc9d6';
const ASSET = 'ytest.usd';

function log(step: string, detail?: string): void {
  const line = detail ? `${step} — ${detail}` : step;
  console.log(`[${new Date().toISOString()}] ${line}`);
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function main(): Promise<void> {
  // 1. Health check
  log('1. Health check');
  const health = (await api('GET', '/health')) as Record<string, string>;
  log(`   ws=${health.websocket} db=${health.database} auth=${health.auth}`);
  if (health.websocket !== 'connected') {
    throw new Error('WebSocket not connected, wait and retry');
  }

  // 2. Check ledger balance before
  log('2. Ledger balance (before)');
  const balanceBefore = (await api('GET', '/yellow/ledger-balances')) as {
    ledger_balances: Array<{ asset: string; amount: string }>;
  };
  const ytestBefore =
    balanceBefore.ledger_balances.find((b) => b.asset === ASSET)?.amount ?? '0';
  log(`   Wallet A: ${ytestBefore} ${ASSET}`);

  // 3. Create app session (A + B, with ytest.usd allocations)
  log('3. Create session');
  const createResult = (await api('POST', '/yellow/sessions', {
    definition: {
      protocol: 'NitroRPC/0.2',
      participants: [WALLET_A, WALLET_B],
      weights: [100, 0],
      quorum: 100,
      challenge: 0,
      nonce: Date.now(),
    },
    allocations: [
      { asset: ASSET, amount: '1000000', participant: WALLET_A },
      { asset: ASSET, amount: '1000000', participant: WALLET_B },
    ],
  })) as Record<string, unknown>;
  const sessionId = (createResult.app_session_id ??
    createResult.appSessionId ??
    createResult.sessionId) as string;
  log(`   sessionId: ${sessionId}`);

  // 4. Transfer 1 USD from A → B
  log('4. Transfer A → B (1 USD)');
  const transferResult = await api('POST', '/yellow/transfer', {
    destination: WALLET_B,
    allocations: [{ asset: ASSET, amount: '1000000' }],
  });
  log(`   result: ${JSON.stringify(transferResult)}`);

  // 5. Check ledger balance after transfer
  log('5. Ledger balance (after transfer)');
  const balanceAfter = (await api('GET', '/yellow/ledger-balances')) as {
    ledger_balances: Array<{ asset: string; amount: string }>;
  };
  const ytestAfter =
    balanceAfter.ledger_balances.find((b) => b.asset === ASSET)?.amount ?? '0';
  log(`   Wallet A: ${ytestAfter} ${ASSET} (was ${ytestBefore})`);

  // 6. Close session
  log('6. Close session');
  const closeResult = await api(
    'POST',
    `/yellow/sessions/${sessionId}/close`,
    {
      allocations: [
        { asset: ASSET, amount: '0', participant: WALLET_A },
        { asset: ASSET, amount: '2000000', participant: WALLET_B },
      ],
    },
  );
  log(`   result: ${JSON.stringify(closeResult)}`);

  // 7. Verify session in DB
  log('7. Verify session');
  const sessions = (await api('GET', '/yellow/sessions')) as Array<{
    sessionId: string;
  }>;
  const found = sessions.find((s) => s.sessionId === sessionId);
  log(`   session ${sessionId} in DB: ${found ? 'YES' : 'NO'}`);

  log('Done!');
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
