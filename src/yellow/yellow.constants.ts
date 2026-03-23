export const YellowSessionStatus = {
  active: 'active',
  closed: 'closed',
} as const;

/** RPC request timeout (ms). */
export const RPC_TIMEOUT_MS = 30_000;

/** Auth flow timeout (ms). */
export const AUTH_TIMEOUT_MS = 15_000;

/** Default max timestamp drift (ms). */
export const DEFAULT_MAX_DRIFT_MS = 300_000;
