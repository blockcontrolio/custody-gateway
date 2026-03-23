/**
 * Quick check: Alice's Custody account balance vs channel balance
 */
import { createPublicClient, http, type Hex, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import { custodyAbi } from '@erc7824/nitrolite/dist/abis/generated.js';

const ETH_RPC = process.env.ETHEREUM_RPC_URL!;
const ALICE2 = '0xE7ce2951eb7Be0bAe584107Bf0Bb8c7a298E5325' as Address;
const BROKER = '0x435d4B6b68e1083Cc0835D1F971C4739204C1d2a' as Address;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
const CUSTODY = '0x6F71a38d919ad713D0AfE0eB712b95064Fc2616f' as Address;
const CHANNEL_ID = '0xd25ad7719c748181fca7d072c4b70f29768cb4cff06c8dd3145f222f72a23bc1' as Hex;

async function main() {
  const publicClient = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });

  // Account balances
  const acctBals = await publicClient.readContract({
    address: CUSTODY, abi: custodyAbi, functionName: 'getAccountsBalances',
    args: [[ALICE2, BROKER], [USDC]],
  });
  console.log('Account balances (USDC):');
  console.log('  Alice:', (acctBals as any)[0][0].toString());
  console.log('  Broker:', (acctBals as any)[1][0].toString());

  // Channel balance
  const chBal = await publicClient.readContract({
    address: CUSTODY, abi: custodyAbi, functionName: 'getChannelBalances',
    args: [CHANNEL_ID, [USDC]],
  });
  console.log('\nChannel balance (USDC):', (chBal as any)[0].toString());

  // Channel data
  const chData = await publicClient.readContract({
    address: CUSTODY, abi: custodyAbi, functionName: 'getChannelData',
    args: [CHANNEL_ID],
  });
  const [channel, status, wallets, challengeExpiry, lastState] = chData as any;
  console.log('\nChannel data:');
  console.log('  Status:', status.toString());
  console.log('  Wallets:', wallets);
  console.log('  Challenge expiry:', challengeExpiry.toString());
  console.log('  Last state version:', lastState.version.toString());
  console.log('  Last state intent:', lastState.intent.toString());
  console.log('  Last state allocations:');
  for (const a of lastState.allocations) {
    console.log(`    ${a.destination}: ${a.amount.toString()} ${a.token}`);
  }

  // Also check Alice's USDC wallet balance
  const usdcBal = await publicClient.readContract({
    address: USDC,
    abi: [{ inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' }],
    functionName: 'balanceOf',
    args: [ALICE2],
  });
  console.log('\nAlice USDC wallet:', usdcBal.toString());
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
