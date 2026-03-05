/**
 * Full sandbox flow via custody-gateway HTTP API:
 *   connect (gateway does WS + auth) → create session → transfer 1 → transfer 2 → close.
 * Gateway persists session to DB; you can query it after.
 *
 * Prerequisites:
 *   - Gateway running: npm run start:dev (with CLEARNODE_URL, DATABASE_URL, YELLOW_SIGNER_PRIVATE_KEY)
 *   - DB up and migrated: docker compose up -d && npx prisma migrate dev
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/sandbox-api-flow.ts
 * Or: npm run sandbox:flow
 */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3333';
const WALLET_A =
  process.env.YELLOW_SANDBOX_WALLET_A ??
  '0x2cb4e55874C087a141Db82A30A8FB6FA87F202B2';
const WALLET_B =
  process.env.YELLOW_SANDBOX_WALLET_B ??
  '0xF44020407a75d7B8525d7aEC114A16f7ebbfc9d6';
const ZERO = '0x0000000000000000000000000000000000000000' as const;

function log(step: string, detail?: string): void {
  const line = detail ? `${step} — ${detail}` : step;
  console.log(`[${new Date().toISOString()}] ${line}`);
}

function headers(): Record<string, string> {
  return { 'Content-Type': 'application/json' };
}

async function main(): Promise<void> {
  log('1. Status', 'GET /yellow/status');
  let statusRes: Response;
  try {
    statusRes = await fetch(`${BASE_URL}/yellow/status`, {
      headers: headers(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      console.error(
        'Cannot reach gateway at',
        BASE_URL,
        '— start it with: npm run start:dev',
      );
    } else {
      console.error(msg);
    }
    process.exit(1);
  }
  if (!statusRes.ok) {
    console.error('Status failed:', statusRes.status, await statusRes.text());
    process.exit(1);
  }
  const status = (await statusRes.json()) as {
    enabled?: boolean;
    configured?: boolean;
    hasSessionToken?: boolean;
  };
  log('   enabled:', String(status.enabled));
  log('   configured:', String(status.configured));
  log('   hasSessionToken:', String(status.hasSessionToken));
  if (!status.enabled || !status.configured) {
    console.error(
      'Gateway not enabled or not configured (check YELLOW_SIGNER_PRIVATE_KEY, CLEARNODE_URL).',
    );
    process.exit(1);
  }

  log('2. Create session', 'POST /yellow/sessions');
  const createBody = {
    definition: {
      protocol: 'NitroRPC/0.2',
      participants: [WALLET_A, WALLET_B],
      weights: [1, 1],
      quorum: 2,
      challenge: 86400,
      nonce: Date.now(),
    },
    allocations: [
      { asset: ZERO, amount: '1000000', participant: WALLET_A },
      { asset: ZERO, amount: '1000000', participant: WALLET_B },
    ],
  };
  const createRes = await fetch(`${BASE_URL}/yellow/sessions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(createBody),
  });
  if (!createRes.ok) {
    console.error(
      'Create session failed:',
      createRes.status,
      await createRes.text(),
    );
    process.exit(1);
  }
  const createResult = (await createRes.json()) as Record<string, unknown>;
  const sessionId =
    typeof createResult.sessionId === 'string'
      ? createResult.sessionId
      : typeof createResult.app_session_id === 'string'
        ? createResult.app_session_id
        : String(createResult.sessionId ?? createResult.app_session_id ?? '');
  log('   sessionId:', sessionId);

  log('3. Transfer 1 (A → B)', 'POST /yellow/transfer');
  const transfer1Res = await fetch(`${BASE_URL}/yellow/transfer`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      destination: WALLET_B,
      allocations: [{ asset: ZERO, amount: '100000' }],
    }),
  });
  if (!transfer1Res.ok) {
    console.error(
      'Transfer 1 failed:',
      transfer1Res.status,
      await transfer1Res.text(),
    );
    process.exit(1);
  }
  log('   OK');

  log('4. Transfer 2 (B → A)', 'POST /yellow/transfer');
  const transfer2Res = await fetch(`${BASE_URL}/yellow/transfer`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      destination: WALLET_A,
      allocations: [{ asset: ZERO, amount: '50000' }],
    }),
  });
  if (!transfer2Res.ok) {
    console.error(
      'Transfer 2 failed:',
      transfer2Res.status,
      await transfer2Res.text(),
    );
    process.exit(1);
  }
  log('   OK');

  log('5. Close session', `POST /yellow/sessions/${sessionId}/close`);
  const closeBody = {
    allocations: [
      { asset: ZERO, amount: '950000', participant: WALLET_A },
      { asset: ZERO, amount: '1050000', participant: WALLET_B },
    ],
  };
  const closeRes = await fetch(
    `${BASE_URL}/yellow/sessions/${sessionId}/close`,
    {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(closeBody),
    },
  );
  if (!closeRes.ok) {
    console.error('Close failed:', closeRes.status, await closeRes.text());
    process.exit(1);
  }
  log('   OK');

  log('Done.');
  console.log('\nПроверить сессию в БД:');
  console.log('  npx prisma studio');
  console.log(
    '  или: psql $DATABASE_URL -c \'SELECT * FROM "YellowSession";\'',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
