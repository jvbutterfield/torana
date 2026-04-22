// Unit tests for src/agent-api/idempotency.ts.
//
// The DB-level sweep is already tested in test/db/gateway-db.agent-api.test.ts;
// this file covers the key-format validator + the swallow-errors wrapper.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import {
  IDEMPOTENCY_KEY_RE,
  validateIdempotencyKey,
  sweepIdempotencyRows,
} from "../../src/agent-api/idempotency.js";

let tmpDir: string;
let db: GatewayDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-idem-"));
  applyMigrations(join(tmpDir, "gateway.db"));
  db = new GatewayDB(join(tmpDir, "gateway.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("validateIdempotencyKey", () => {
  test("null / empty → missing_idempotency_key", () => {
    expect(validateIdempotencyKey(null).ok).toBe(false);
    expect(validateIdempotencyKey("").ok).toBe(false);
  });

  test("under 16 chars → invalid_idempotency_key", () => {
    const r = validateIdempotencyKey("abc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_idempotency_key");
  });

  test("over 128 chars → invalid_idempotency_key", () => {
    const r = validateIdempotencyKey("a".repeat(129));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_idempotency_key");
  });

  test("disallowed chars → invalid_idempotency_key", () => {
    const r = validateIdempotencyKey("has space in it 123456");
    expect(r.ok).toBe(false);
  });

  test("valid 16-char key → ok", () => {
    const r = validateIdempotencyKey("0123456789abcdef");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.key).toBe("0123456789abcdef");
  });

  test("regex boundaries: exactly 128 chars accepted, underscores + dashes OK", () => {
    const k = "a".repeat(128);
    expect(IDEMPOTENCY_KEY_RE.test(k)).toBe(true);
    expect(IDEMPOTENCY_KEY_RE.test("a_b-c_d-e_f-g_h_i_j")).toBe(true);
  });
});

describe("sweepIdempotencyRows", () => {
  test("deletes rows older than retention, keeps fresh ones", () => {
    // Seed a turn so the foreign key constraint is satisfied.
    const turnId = db.insertSendTurn({
      botId: "bot1",
      tokenName: "t",
      chatId: 1,
      markerWrappedText: "x",
      idempotencyKey: "key-aaaaaaaaaaaaaa",
      sourceLabel: "s",
      attachmentPaths: [],
    }).turnId;
    expect(turnId).toBeGreaterThan(0);

    // Retention so long that "now - retention" is in the distant past →
    // nothing to sweep.
    expect(sweepIdempotencyRows(db, 365 * 24 * 60 * 60 * 1000)).toBe(0);

    // Retention of -1ms effectively sweeps everything (threshold = now+1).
    expect(sweepIdempotencyRows(db, -1)).toBe(1);
    expect(db.getIdempotencyTurn("bot1", "key-aaaaaaaaaaaaaa")).toBeNull();
  });

  test("returns 0 on DB error instead of throwing", () => {
    db.close();
    // Post-close: any prepared-statement call throws. The wrapper should
    // swallow it — sweep is a best-effort background task; a transient DB
    // issue shouldn't cascade into a crash loop.
    const n = sweepIdempotencyRows(db, 0);
    expect(n).toBe(0);
    // Re-open so afterEach's close doesn't double-close.
    db = new GatewayDB(join(tmpDir, "gateway.db"));
  });
});
