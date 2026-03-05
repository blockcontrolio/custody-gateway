/**
 * Setup a channel on Sepolia testnet for sandbox testing.
 * Run: npx ts-node test/setup-channel.ts
 *
 * Prerequisites:
 * 1. Wallet A needs Sepolia ETH for gas
 * 2. Wallet A needs ytest.usd tokens
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  type Hex,
  type Address,
} from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// Config from get_config response
const CUSTODY_ADDRESS = '0x019B65A265EB3363822f2752141b3dF16131b262' as Address;
const ADJUDICATOR_ADDRESS = '0x7c7ccbc98469190849BCC6c926307794fDfB11F2' as Address;
const BROKER_ADDRESS = '0xc7E6827ad9DA2c89188fAEd836F9285E6bFdCCCC' as Address;
const YTEST_USD = '0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb' as Address;
const DECIMALS = 6;

// Test wallets
const WALLET_A_KEY =
  '0x67c468c2473b4b272cc4c17345e8b9b0138fe8baf7c6873b68e0b37b24830427' as Hex;

const accountA = privateKeyToAccount(WALLET_A_KEY);
console.log('Wallet A:', accountA.address);

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http('https://sepolia.infura.io/v3/69feec063f4d452e9a91a2716a6e5d8b'),
});

const walletClient = createWalletClient({
  account: accountA,
  chain: sepolia,
  transport: http('https://sepolia.infura.io/v3/69feec063f4d452e9a91a2716a6e5d8b'),
});

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]);

async function checkBalances() {
  console.log('\n=== Checking Balances ===');

  // ETH balance
  const ethBalance = await publicClient.getBalance({ address: accountA.address });
  console.log(`ETH: ${formatUnits(ethBalance, 18)}`);

  // Token balance
  try {
    const tokenBalance = await publicClient.readContract({
      address: YTEST_USD,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [accountA.address],
    });
    console.log(`ytest.usd: ${formatUnits(tokenBalance, DECIMALS)}`);
  } catch (err) {
    console.log(`ytest.usd balance check failed: ${(err as Error).message}`);
  }

  // Token name/symbol
  try {
    const name = await publicClient.readContract({
      address: YTEST_USD,
      abi: erc20Abi,
      functionName: 'name',
    });
    const symbol = await publicClient.readContract({
      address: YTEST_USD,
      abi: erc20Abi,
      functionName: 'symbol',
    });
    console.log(`Token: ${name} (${symbol})`);
  } catch (err) {
    console.log(`Token info failed: ${(err as Error).message}`);
  }

  // Allowance to custody
  try {
    const allowance = await publicClient.readContract({
      address: YTEST_USD,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [accountA.address, CUSTODY_ADDRESS],
    });
    console.log(`Allowance to Custody: ${formatUnits(allowance, DECIMALS)}`);
  } catch (err) {
    console.log(`Allowance check failed: ${(err as Error).message}`);
  }

  return ethBalance;
}

async function tryMintTokens() {
  console.log('\n=== Trying to mint ytest.usd ===');
  const amount = BigInt(1000) * BigInt(10 ** DECIMALS); // 1000 tokens

  try {
    const hash = await walletClient.writeContract({
      address: YTEST_USD,
      abi: erc20Abi,
      functionName: 'mint',
      args: [accountA.address, amount],
    });
    console.log(`Mint tx: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`Mint status: ${receipt.status}`);
  } catch (err) {
    console.log(`Mint failed: ${(err as Error).message.slice(0, 200)}`);
    console.log('Token may not have public mint. Need to get tokens another way.');
  }
}

async function run() {
  const ethBalance = await checkBalances();

  if (ethBalance === 0n) {
    console.log('\n⚠️  No Sepolia ETH! Get testnet ETH from:');
    console.log('  - https://www.alchemy.com/faucets/ethereum-sepolia');
    console.log('  - https://faucets.chain.link/sepolia');
    console.log(`  Address: ${accountA.address}`);
    return;
  }

  // Try to mint tokens
  await tryMintTokens();

  // Check balances again
  await checkBalances();
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
