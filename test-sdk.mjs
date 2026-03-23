import { readFileSync } from 'node:fs';

// Parse .env
const env = {};
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)/);
  if (m) env[m[1]] = m[2];
}

const { Client, EthereumMsgSigner, EthereumRawSigner, withErrorHandler } = await import('@yellow-org/sdk');

const key = env.YELLOW_SIGNER_PRIVATE_KEY;
if (!key) { console.error('No YELLOW_SIGNER_PRIVATE_KEY in .env'); process.exit(1); }

const stateSigner = new EthereumMsgSigner(key);
const txSigner = new EthereumRawSigner(key);

console.log('Connecting to wss://clearnet.yellow.com/ws ...');

const client = await Client.create(
  'wss://clearnet.yellow.com/ws',
  stateSigner,
  txSigner,
  withErrorHandler((err) => console.error('SDK error:', err?.message || err)),
);

console.log('Connected! User:', client.getUserAddress());

const stringify = (v) => JSON.stringify(v, (k, v) => typeof v === 'bigint' ? v.toString() : v);

try {
  const balances = await client.getBalances();
  console.log('Balances:', stringify(balances));
} catch (e) {
  console.error('getBalances:', e.message);
}

try {
  const assets = await client.getAssets();
  console.log('Assets:', stringify(assets).slice(0, 800));
} catch (e) {
  console.error('getAssets:', e.message);
}

await client.close();
process.exit(0);
