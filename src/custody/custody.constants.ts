import { sepolia, baseSepolia, lineaSepolia, polygonAmoy } from 'viem/chains';
import type { Chain } from 'viem';
import type { Address } from 'viem';

/** Custody contract address (same across all sandbox chains). */
export const CUSTODY_ADDRESS: Address =
  '0x019B65A265EB3363822f2752141b3dF16131b262';

/** Adjudicator contract address (same across all sandbox chains). */
export const ADJUDICATOR_ADDRESS: Address =
  '0x7c7ccbc98469190849BCC6c926307794fDfB11F2';

/** ETH represented as zero-address token. */
export const ETH_TOKEN: Address =
  '0x0000000000000000000000000000000000000000';

/** Env key for the RPC URL override. */
export const RPC_ENV_KEY = 'SEPOLIA_RPC_URL';

/** Supported chain configs for sandbox. */
export const CHAIN_CONFIG: Record<
  string,
  { chain: Chain; chainId: number; rpcEnvKey?: string }
> = {
  ethereum_sepolia: { chain: sepolia, chainId: 11155111, rpcEnvKey: RPC_ENV_KEY },
  base_sepolia: { chain: baseSepolia, chainId: 84532 },
  linea_sepolia: { chain: lineaSepolia, chainId: 59141 },
  polygon_amoy: { chain: polygonAmoy, chainId: 80002 },
};
