/**
 * Debug: verify resize state signatures using data from previous run
 */
import { createPublicClient, createWalletClient, http, recoverMessageAddress, recoverAddress, keccak256, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { NitroliteClient, WalletStateSigner } from '@erc7824/nitrolite';

const ETH_RPC = process.env.ETHEREUM_RPC_URL!;
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY!, 'hex');
const ALICE2 = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325' as Address;
const BROKER = '0x435d4B6b68e1083Cc0835D1F971C4739204C1d2a' as Address;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
const CUSTODY = '0x6F71a38d919ad713D0AfE0eB712b95064Fc2616f' as Address;
const ADJUDICATOR = '0x14980dF216722f14c42CA7357b06dEa7eB408b10' as Address;

// Data from previous full-flow.ts run
const CHANNEL_ID = '0xd25ad7719c748181fca7d072c4b70f29768cb4cff06c8dd3145f222f72a23bc1' as Hex;
const SERVER_SIG = '0xad694614581fa3a4daea2c7cfbb6565150f229d89897cd4c693428f1da8dbbed596254ddfb6ba433162eb6afcc9d044a523b3ba8964aa4571aab3d9d82b2b6571b' as Hex;
const RESIZE_STATE_DATA = '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000000000' as Hex;

function decrypt(enc: string, iv: string, tag: string): string {
  const d = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(enc, 'hex')), d.final()]).toString('utf8');
}

async function main() {
  const prisma = new PrismaClient();
  const aliceRow = await prisma.managedKey.findUnique({ where: { address: ALICE2 } });
  await prisma.$disconnect();
  const aliceKey = decrypt(aliceRow!.encryptedKey, aliceRow!.iv, aliceRow!.tag) as Hex;
  const aliceAccount = privateKeyToAccount(aliceKey);
  const publicClient = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });

  console.log('=== Channel participants ===');
  console.log('participant[0] (Alice):', ALICE2);
  console.log('participant[1] (Broker):', BROKER);

  // Build the resize state
  const { getPackedState } = await import('@erc7824/nitrolite/dist/utils/state.js');

  const unsignedState = {
    intent: 2, // RESIZE
    version: 1n,
    data: RESIZE_STATE_DATA,
    allocations: [
      { destination: ALICE2, token: USDC, amount: 1_000000n },
      { destination: BROKER, token: USDC, amount: 0n },
    ],
  };

  const packedState = getPackedState(CHANNEL_ID, unsignedState);
  const stateHash = keccak256(packedState);
  console.log('\nPacked state (hex):', packedState.slice(0, 80) + '...');
  console.log('State hash:', stateHash);

  // === Signature Recovery ===
  console.log('\n=== Server Signature Recovery ===');

  // EIP-191 recovery (signMessage with raw bytes)
  try {
    const addr = await recoverMessageAddress({ message: { raw: packedState }, signature: SERVER_SIG });
    console.log('EIP-191 on packedState →', addr);
    console.log('  is Alice?', addr.toLowerCase() === ALICE2.toLowerCase());
    console.log('  is Broker?', addr.toLowerCase() === BROKER.toLowerCase());
  } catch (e) { console.log('EIP-191 error:', (e as Error).message.slice(0, 200)); }

  // Raw ECDSA recovery (sign keccak256(packedState) directly)
  try {
    const addr = await recoverAddress({ hash: stateHash, signature: SERVER_SIG });
    console.log('Raw ECDSA on stateHash →', addr);
    console.log('  is Alice?', addr.toLowerCase() === ALICE2.toLowerCase());
    console.log('  is Broker?', addr.toLowerCase() === BROKER.toLowerCase());
  } catch (e) { console.log('Raw ECDSA error:', (e as Error).message.slice(0, 200)); }

  // === Alice Signature ===
  console.log('\n=== Alice Signature (EIP-191) ===');
  const aliceSig191 = await aliceAccount.signMessage({ message: { raw: packedState } });
  try {
    const addr = await recoverMessageAddress({ message: { raw: packedState }, signature: aliceSig191 });
    console.log('EIP-191 on packedState →', addr);
    console.log('  is Alice?', addr.toLowerCase() === ALICE2.toLowerCase());
  } catch (e) { console.log('Error:', (e as Error).message.slice(0, 200)); }

  // Raw ECDSA Alice
  const { signRawECDSAMessage } = await import('@erc7824/nitrolite/dist/utils/sign.js');
  const aliceSigRaw = await signRawECDSAMessage(packedState, aliceKey);
  try {
    const addr = await recoverAddress({ hash: stateHash, signature: aliceSigRaw });
    console.log('Raw ECDSA on stateHash →', addr);
    console.log('  is Alice?', addr.toLowerCase() === ALICE2.toLowerCase());
  } catch (e) { console.log('Error:', (e as Error).message.slice(0, 200)); }

  // === Initial state sigs check ===
  console.log('\n=== Initial state sigs from on-chain ===');
  const aliceWC = createWalletClient({ account: aliceAccount, chain: mainnet, transport: http(ETH_RPC) });
  const nitrolite = new NitroliteClient({
    publicClient, walletClient: aliceWC,
    stateSigner: new WalletStateSigner(aliceWC),
    addresses: { custody: CUSTODY, adjudicator: ADJUDICATOR },
    chainId: 1, challengeDuration: 3600n,
  });

  const chainData = await nitrolite.getChannelData(CHANNEL_ID);
  const initState = chainData.lastValidState;
  console.log('On-chain state: version=', initState.version.toString(), 'intent=', initState.intent);

  const initPacked = getPackedState(CHANNEL_ID, {
    intent: initState.intent,
    version: initState.version,
    data: initState.data as Hex,
    allocations: initState.allocations.map((a: any) => ({
      destination: a.destination as Address,
      token: a.token as Address,
      amount: a.amount,
    })),
  });
  const initHash = keccak256(initPacked);

  for (let i = 0; i < initState.sigs.length; i++) {
    const sig = initState.sigs[i] as Hex;
    if (!sig || sig === '0x') { console.log(`sig[${i}]: empty`); continue; }
    console.log(`\nsig[${i}]: ${sig.slice(0, 20)}...`);

    try {
      const addr = await recoverMessageAddress({ message: { raw: initPacked }, signature: sig });
      console.log(`  EIP-191 → ${addr}`);
      console.log(`  is Alice?`, addr.toLowerCase() === ALICE2.toLowerCase());
      console.log(`  is Broker?`, addr.toLowerCase() === BROKER.toLowerCase());
    } catch (e) { console.log(`  EIP-191 error`); }

    try {
      const addr = await recoverAddress({ hash: initHash, signature: sig });
      console.log(`  Raw ECDSA → ${addr}`);
      console.log(`  is Alice?`, addr.toLowerCase() === ALICE2.toLowerCase());
      console.log(`  is Broker?`, addr.toLowerCase() === BROKER.toLowerCase());
    } catch (e) { console.log(`  Raw ECDSA error`); }
  }

  // === Try all sig combinations for resize ===
  console.log('\n=== Contract call tests ===');
  const { custodyAbi } = await import('@erc7824/nitrolite/dist/abis/generated.js');

  const combos = [
    { name: 'EIP-191 alice + server as-is', sigs: [aliceSig191, SERVER_SIG] },
    { name: 'Raw alice + server as-is', sigs: [aliceSigRaw, SERVER_SIG] },
  ];

  for (const { name, sigs } of combos) {
    const candidate = {
      intent: unsignedState.intent,
      version: unsignedState.version,
      data: unsignedState.data,
      allocations: unsignedState.allocations,
      sigs,
    };
    try {
      await publicClient.simulateContract({
        address: CUSTODY, abi: custodyAbi, functionName: 'resize',
        args: [CHANNEL_ID, candidate, []], account: aliceAccount,
      });
      console.log(`${name}: SUCCESS`);
    } catch (e) {
      const msg = (e as Error).message;
      // Extract the revert reason
      const revert = msg.match(/reverted with the following reason:\s*(.*?)(?:\n|$)/)?.[1]
        || msg.match(/reverted with custom error '([^']+)'/)?.[1]
        || msg.slice(0, 300);
      console.log(`${name}: FAILED - ${revert}`);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
