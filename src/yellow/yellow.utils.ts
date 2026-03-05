/** Normalize unknown to Error for reject(). */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Get a log-safe message from unknown throwable. */
export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
