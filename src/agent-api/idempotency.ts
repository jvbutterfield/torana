// Agent-API idempotency helpers.
//
// The dedup write itself lives inside `db.insertSendTurn` (so a concurrent
// second caller with the same key races against the transaction, not
// against us). This module owns:
//   - the key-format validator (re-exported from schemas for call-site clarity)
//   - the sweeper driver (fed by a timer in main.ts)

import type { GatewayDB } from "../db/gateway-db.js";
import { validateIdempotencyKey, IDEMPOTENCY_KEY_RE } from "./schemas.js";

export { validateIdempotencyKey, IDEMPOTENCY_KEY_RE };

/**
 * Delete idempotency rows older than the retention window.
 *
 * Returns the number of rows removed (useful for operator logging).
 * Failure is swallowed and reported as `0` — a transient DB issue here
 * doesn't justify a crash; the next tick retries.
 */
export function sweepIdempotencyRows(
  db: GatewayDB,
  retentionMs: number,
  clock: () => number = Date.now,
): number {
  try {
    return db.sweepIdempotency(clock() - retentionMs);
  } catch {
    return 0;
  }
}
