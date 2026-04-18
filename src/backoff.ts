/**
 * Exponential backoff: `base * 2^attempt`, capped at `cap`.
 * `attempt` is 0-indexed (first retry after a single failure → attempt=0).
 */
export function nextBackoffMs(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** attempt);
}
