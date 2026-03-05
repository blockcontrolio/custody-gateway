/**
 * Enum value objects matching prisma/schema.prisma.
 * Used for Prisma writes without depending on @prisma/client enum exports.
 */
export const YellowSessionStatus = {
  active: 'active',
  closed: 'closed',
} as const;

export const ChannelStateStatus = {
  active: 'active',
  closed: 'closed',
  challenged: 'challenged',
} as const;

export const SignedStateIntent = {
  OPERATE: 'OPERATE',
  INITIALIZE: 'INITIALIZE',
  RESIZE: 'RESIZE',
  FINALIZE: 'FINALIZE',
} as const;

/** RPC request timeout (ms). */
export const RPC_TIMEOUT_MS = 30_000;

/** Auth flow timeout (ms). */
export const AUTH_TIMEOUT_MS = 15_000;

/** Default max timestamp drift (ms), 5 minutes. */
export const DEFAULT_MAX_DRIFT_MS = 300_000;
