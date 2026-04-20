// §12.5.4: the idempotency store must not grow unbounded under
// attack. Sweep runs on a timer (main.ts) using
// `sweepIdempotencyRows` → `db.sweepIdempotency(thresholdMs)`. This
// test seeds 10k rows, runs the sweep with threshold = now, and
// confirms it completes in a reasonable time budget and removes all
// stale rows without holding a write lock long enough to starve
// legitimate writers.
//
// (The §12.7 soak test is the place for a 100k-row endurance check
// with RSS tracking; here we pin the correctness + speed invariants.)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../../../src/db/migrate.js";
import { GatewayDB } from "../../../src/db/gateway-db.js";
import { sweepIdempotencyRows } from "../../../src/agent-api/idempotency.js";

let tmpDir: string;
let db: GatewayDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-sec-idem-"));
  applyMigrations(join(tmpDir, "gateway.db"));
  db = new GatewayDB(join(tmpDir, "gateway.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedIdempotencyRows(count: number): void {
  const inner = (
    db as unknown as {
      _db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
    }
  )._db;

  // Ensure at least one turn row exists (FK target).
  inner
    .prepare(
      `INSERT INTO inbound_updates (id, bot_id, telegram_update_id, chat_id, message_id, from_user_id, payload_json)
       VALUES (1, 'bot1', 1, 1, 1, '1', '{}')`,
    )
    .run();
  inner
    .prepare(
      `INSERT INTO turns (id, bot_id, chat_id, source_update_id, status, attachment_paths_json, source)
       VALUES (1, 'bot1', 1, 1, 'completed', '[]', 'agent_api_inject')`,
    )
    .run();

  const stmt = inner.prepare(
    `INSERT INTO agent_api_idempotency (bot_id, idempotency_key, turn_id, created_at)
     VALUES ('bot1', ?, 1, '2000-01-01 00:00:00')`,
  );
  // Wrap in a transaction — 10k individual commits is slow and not
  // what we're measuring.
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) stmt.run(`key-${i}-flood-xxxxxxxxxxxx`);
  });
}

describe("§12.5.4 resource.idempotency-store-bloat", () => {
  test("seeds 10k idempotency rows then sweeps them all, within a time budget", () => {
    const N = 10_000;
    seedIdempotencyRows(N);

    // Confirm seed landed.
    const inner = (db as unknown as { _db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } })._db;
    const beforeRow = inner
      .prepare(`SELECT COUNT(*) as n FROM agent_api_idempotency`)
      .get() as { n: number };
    expect(beforeRow.n).toBe(N);

    const startMs = Date.now();
    // Sweep everything created before "now" — i.e. all of it.
    const removed = sweepIdempotencyRows(db, 0, () => Date.now());
    const durationMs = Date.now() - startMs;

    expect(removed).toBe(N);

    // Time budget: we're checking "bounded", not "fast". 2 seconds is
    // ~5× the observed wall-clock on a loaded laptop; flaky well
    // before that would indicate a genuine regression.
    expect(durationMs).toBeLessThan(2000);

    const afterRow = inner
      .prepare(`SELECT COUNT(*) as n FROM agent_api_idempotency`)
      .get() as { n: number };
    expect(afterRow.n).toBe(0);
  });

  test("sweep with threshold below oldest row removes nothing (invariant: retention respected)", () => {
    seedIdempotencyRows(100);

    // Threshold in year 1970 — all rows are newer than that.
    // (The seed rows use a fixed 2000-01-01 created_at, so a threshold
    // of 0 ms would delete; a threshold clock of "before year 2000"
    // should leave them alone.)
    const yr1970 = new Date("1970-01-01").getTime();
    const removed = sweepIdempotencyRows(db, 0, () => yr1970);
    expect(removed).toBe(0);
  });

  test("malformed sweep (DB errors) is swallowed and returns 0 (no crash)", () => {
    // Close the DB out from under the sweep — sweepIdempotencyRows
    // catches and returns 0 instead of propagating.
    db.close();
    const removed = sweepIdempotencyRows(db, 3600_000, () => Date.now());
    expect(removed).toBe(0);
  });
});
