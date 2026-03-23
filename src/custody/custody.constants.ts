import {
  mainnet,
  sepolia,
  baseSepolia,
  lineaSepolia,
  polygonAmoy,
  bsc,
  polygon,
  base,
  linea,
} from 'viem/chains';
import type { Chain, Address } from 'viem';

/** ETH represented as zero-address token. */
export const ETH_TOKEN: Address =
  '0x0000000000000000000000000000000000000000';

/** Chain config with per-chain custody and adjudicator addresses. */
export interface ChainConfig {
  chain: Chain;
  chainId: number;
  custody: Address;
  adjudicator: Address;
  rpcEnvKey?: string;
}

// --- Mainnet contract addresses ---
const CUSTODY_ETH: Address = '0x6F71a38d919ad713D0AfE0eB712b95064Fc2616f';
const ADJ_ETH: Address = '0x14980dF216722f14c42CA7357b06dEa7eB408b10';

const CUSTODY_POLYGON: Address = '0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6';
const ADJ_POLYGON: Address = '0x7de4A0736Cf5740fD3Ca2F2e9cc85c9AC223eF0C';

// --- Sandbox contract addresses ---
const CUSTODY_SANDBOX: Address = '0x019B65A265EB3363822f2752141b3dF16131b262';
const ADJ_SANDBOX: Address = '0x7c7ccbc98469190849BCC6c926307794fDfB11F2';

/** All supported chain configs. */
export const CHAIN_CONFIG: Record<string, ChainConfig> = {
  // ── Mainnet ──
  ethereum: {
    chain: mainnet,
    chainId: 1,
    custody: CUSTODY_ETH,
    adjudicator: ADJ_ETH,
    rpcEnvKey: 'ETHEREUM_RPC_URL',
  },
  bsc: {
    chain: bsc,
    chainId: 56,
    custody: CUSTODY_ETH,
    adjudicator: ADJ_ETH,
  },
  polygon: {
    chain: polygon,
    chainId: 137,
    custody: CUSTODY_POLYGON,
    adjudicator: ADJ_POLYGON,
  },
  base: {
    chain: base,
    chainId: 8453,
    custody: CUSTODY_POLYGON,
    adjudicator: ADJ_POLYGON,
  },
  linea: {
    chain: linea,
    chainId: 59144,
    custody: CUSTODY_ETH,
    adjudicator: ADJ_ETH,
  },

  // ── Sandbox (testnet) ──
  ethereum_sepolia: {
    chain: sepolia,
    chainId: 11155111,
    custody: CUSTODY_SANDBOX,
    adjudicator: ADJ_SANDBOX,
    rpcEnvKey: 'SEPOLIA_RPC_URL',
  },
  base_sepolia: {
    chain: baseSepolia,
    chainId: 84532,
    custody: CUSTODY_SANDBOX,
    adjudicator: ADJ_SANDBOX,
  },
  linea_sepolia: {
    chain: lineaSepolia,
    chainId: 59141,
    custody: CUSTODY_SANDBOX,
    adjudicator: ADJ_SANDBOX,
  },
  polygon_amoy: {
    chain: polygonAmoy,
    chainId: 80002,
    custody: CUSTODY_SANDBOX,
    adjudicator: ADJ_SANDBOX,
  },
};

/** Resolve chain name from chain_id. */
export function chainNameFromId(chainId: number): string | undefined {
  return Object.keys(CHAIN_CONFIG).find(
    (k) => CHAIN_CONFIG[k].chainId === chainId,
  );
}

/**
 * Well-known ERC20 token addresses per chain.
 * Yellow uses lowercase asset symbols ('usdc', 'usdt') in RPC;
 * on-chain operations need the contract address.
 */
export const TOKENS: Record<string, Record<string, Address>> = {
  ethereum: {
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  },
  bsc: {
    usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    usdt: '0x55d398326f99059fF775485246999027B3197955',
  },
  polygon: {
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },
  base: {
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  // Sandbox (testnets) — same ytest.usd contract on all sandbox chains
  ethereum_sepolia: {
    'ytest.usd': '0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb',
  },
  base_sepolia: {
    'ytest.usd': '0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb',
  },
  polygon_amoy: {
    'ytest.usd': '0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb',
  },
};

/** Default chain for operations when not specified. */
export const DEFAULT_CHAIN = 'ethereum_sepolia';

/** Resolve token symbol to on-chain contract address. */
export function resolveTokenAddress(
  symbol: string,
  chainName: string,
): Address | undefined {
  return TOKENS[chainName]?.[symbol.toLowerCase()];
}

/** Resolve chain ID from chain name. */
export function chainIdFromName(chainName: string): number {
  const cfg = CHAIN_CONFIG[chainName];
  if (!cfg) throw new Error(`Unknown chain: ${chainName}`);
  return cfg.chainId;
}

/**
 * Convert base units (e.g. '1000000') to decimal string (e.g. '1.000000').
 * Used for ClearNode RPC which expects decimal format.
 */
export function toDecimal(baseUnits: string, decimals = 6): string {
  const n = BigInt(baseUnits);
  const divisor = BigInt(10 ** decimals);
  const whole = n / divisor;
  const frac = (n % divisor).toString().padStart(decimals, '0');
  return `${whole}.${frac}`;
}

/**
 * Parse decimal string (e.g. '0.0004') to base units bigint (e.g. 400n).
 * Inverse of toDecimal.
 */
export function parseDecimalToBaseUnits(
  amount: string | undefined,
  decimals = 6,
): bigint {
  if (!amount) return 0n;
  const parts = amount.split('.');
  const whole = parts[0] || '0';
  let frac = parts[1] || '';
  frac = frac.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole) * BigInt(10 ** decimals) + BigInt(frac);
}
