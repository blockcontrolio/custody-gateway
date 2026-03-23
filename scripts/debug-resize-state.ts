/**
 * Debug resize: try different approaches to fix InvalidState()
 * Focus: proof states, state data format, allocation validation
 */
import { createPublicClient, createWalletClient, http, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { NitroliteClient, WalletStateSigner } from '@erc7824/nitrolite';
import { custodyAbi } from '@erc7824/nitrolite/dist/abis/generated.js';
import { getPackedState } from '@erc7824/nitrolite/dist/utils/state.js';
import { signRawECDSAMessage } from '@erc7824/nitrolite/dist/utils/sign.js';

const ETH_RPC = process.env.ETHEREUM_RPC_URL!;
const MASTER_KEY = Buffer.from(process.env.KEY_ENCRYPTION_MASTER_KEY!, 'hex');
const ALICE2 = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325' as Address;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
const CUSTODY = '0x6F71a38d919ad713D0AfE0eB712b95064Fc2616f' as Address;
const ADJUDICATOR = '0x14980dF216722f14c42CA7357b06dEa7eB408b10' as Address;
const CHANNEL_ID = '0xd25ad7719c748181fca7d072c4b70f29768cb4cff06c8dd3145f222f72a23bc1' as Hex;
const SERVER_SIG = '0xad694614581fa3a4daea2c7cfbb6565150f229d89897cd4c693428f1da8dbbed596254ddfb6ba433162eb6afcc9d044a523b3ba8964aa4571aab3d9d82b2b6571b' as Hex;
const RESIZE_STATE_DATA = '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000000000' as Hex;
const BROKER = '0x435d4B6b68e1083Cc0835D1F971C4739204C1d2a' as Address;

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
  const aliceWC = createWalletClient({ account: aliceAccount, chain: mainnet, transport: http(ETH_RPC) });

  // Get on-chain initial state (for proof)
  const chainData = await publicClient.readContract({
    address: CUSTODY, abi: custodyAbi, functionName: 'getChannelData',
    args: [CHANNEL_ID],
  }) as any;
  const [channel, status, wallets, challengeExpiry, lastState] = chainData;
  console.log('On-chain state:');
  console.log('  version:', lastState.version.toString());
  console.log('  intent:', lastState.intent.toString());
  console.log('  data:', lastState.data);
  console.log('  allocations:', lastState.allocations.map((a: any) => `${a.destination}:${a.amount.toString()}`));
  console.log('  sigs:', lastState.sigs.map((s: any) => s.slice(0, 20) + '...'));

  // Resize state
  const resizeAllocations = [
    { destination: ALICE2, token: USDC, amount: 1_000000n },
    { destination: BROKER, token: USDC, amount: 0n },
  ];

  // Sign with Alice (EIP-191 — matching WalletStateSigner)
  const unsignedResize = { intent: 2, version: 1n, data: RESIZE_STATE_DATA, allocations: resizeAllocations };
  const packedResize = getPackedState(CHANNEL_ID, unsignedResize);
  const aliceSigEIP191 = await aliceAccount.signMessage({ message: { raw: packedResize } });
  const aliceSigRaw = await signRawECDSAMessage(packedResize, aliceKey);

  // Initial state for proof
  const initState = {
    intent: Number(lastState.intent),
    version: lastState.version,
    data: lastState.data as Hex,
    allocations: lastState.allocations.map((a: any) => ({
      destination: a.destination as Address,
      token: a.token as Address,
      amount: a.amount,
    })),
    sigs: [...lastState.sigs] as Hex[],
  };

  // Test 1: resize with EIP-191 alice + server, NO proofs
  console.log('\n--- Test 1: EIP-191 alice + server, no proofs ---');
  await tryResize(publicClient, aliceAccount, {
    intent: 2, version: 1n, data: RESIZE_STATE_DATA,
    allocations: resizeAllocations,
    sigs: [aliceSigEIP191, SERVER_SIG],
  }, []);

  // Test 2: resize with raw alice + server, NO proofs
  console.log('\n--- Test 2: Raw alice + server, no proofs ---');
  await tryResize(publicClient, aliceAccount, {
    intent: 2, version: 1n, data: RESIZE_STATE_DATA,
    allocations: resizeAllocations,
    sigs: [aliceSigRaw, SERVER_SIG],
  }, []);

  // Test 3: resize with EIP-191 alice + server, WITH initial state proof
  console.log('\n--- Test 3: EIP-191 alice + server, WITH proof ---');
  await tryResize(publicClient, aliceAccount, {
    intent: 2, version: 1n, data: RESIZE_STATE_DATA,
    allocations: resizeAllocations,
    sigs: [aliceSigEIP191, SERVER_SIG],
  }, [initState]);

  // Test 4: resize with raw alice + server, WITH proof
  console.log('\n--- Test 4: Raw alice + server, WITH proof ---');
  await tryResize(publicClient, aliceAccount, {
    intent: 2, version: 1n, data: RESIZE_STATE_DATA,
    allocations: resizeAllocations,
    sigs: [aliceSigRaw, SERVER_SIG],
  }, [initState]);

  // Test 5: Try checkpoint instead of resize (EIP-191)
  console.log('\n--- Test 5: Checkpoint with EIP-191 alice + server ---');
  await tryCheckpoint(publicClient, aliceAccount, {
    intent: 2, version: 1n, data: RESIZE_STATE_DATA,
    allocations: resizeAllocations,
    sigs: [aliceSigEIP191, SERVER_SIG],
  }, []);

  // Test 6: Try checkpoint with raw ECDSA
  console.log('\n--- Test 6: Checkpoint with Raw alice + server ---');
  await tryCheckpoint(publicClient, aliceAccount, {
    intent: 2, version: 1n, data: RESIZE_STATE_DATA,
    allocations: resizeAllocations,
    sigs: [aliceSigRaw, SERVER_SIG],
  }, []);

  // Test 7: Checkpoint with proofs
  console.log('\n--- Test 7: Checkpoint EIP-191 with proof ---');
  await tryCheckpoint(publicClient, aliceAccount, {
    intent: 2, version: 1n, data: RESIZE_STATE_DATA,
    allocations: resizeAllocations,
    sigs: [aliceSigEIP191, SERVER_SIG],
  }, [initState]);

  // Test 8: Checkpoint raw with proofs
  console.log('\n--- Test 8: Checkpoint Raw with proof ---');
  await tryCheckpoint(publicClient, aliceAccount, {
    intent: 2, version: 1n, data: RESIZE_STATE_DATA,
    allocations: resizeAllocations,
    sigs: [aliceSigRaw, SERVER_SIG],
  }, [initState]);
}

async function tryResize(publicClient: any, account: any, candidate: any, proofs: any[]) {
  try {
    await publicClient.simulateContract({
      address: CUSTODY, abi: custodyAbi, functionName: 'resize',
      args: [CHANNEL_ID, candidate, proofs], account,
    });
    console.log('  SUCCESS');
  } catch (e) {
    const msg = (e as Error).message;
    const err = msg.match(/custom error '([^']+)'/)?.[1] || msg.match(/Error: (\w+)\(\)/)?.[1] || msg.slice(0, 200);
    console.log('  FAILED:', err);
  }
}

async function tryCheckpoint(publicClient: any, account: any, candidate: any, proofs: any[]) {
  try {
    await publicClient.simulateContract({
      address: CUSTODY, abi: custodyAbi, functionName: 'checkpoint',
      args: [CHANNEL_ID, candidate, proofs], account,
    });
    console.log('  SUCCESS');
  } catch (e) {
    const msg = (e as Error).message;
    const err = msg.match(/custom error '([^']+)'/)?.[1] || msg.match(/Error: (\w+)\(\)/)?.[1] || msg.slice(0, 200);
    console.log('  FAILED:', err);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
