// Runtime allowlist on dynamicUpdate. The function builds UPDATE strings by
// interpolating caller-supplied object keys as SQL identifiers (parameter
// binding cannot bind identifiers). Static types are erased at runtime, so a
// future caller spreading untrusted input could turn an attacker-controlled
// key into arbitrary SQL — these tests pin down the runtime guard.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";

let tmpDir: string;
let dbPath: string;
let db: GatewayDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-gdb-du-"));
  dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("gateway-db: dynamicUpdate column allowlist", () => {
  test("legitimate worker_state columns still apply", () => {
    db.initWorkerState("alpha");
    db.updateWorkerState("alpha", {
      pid: 12345,
      status: "ready",
      consecutive_failures: 2,
      last_error: "boom",
    });
    const row = db.getWorkerState("alpha");
    expect(row).not.toBeNull();
    expect(row!.pid).toBe(12345);
    expect(row!.status).toBe("ready");
    expect(row!.consecutive_failures).toBe(2);
    expect(row!.last_error).toBe("boom");
  });

  test("rejects a SQL-injection-shaped column key on worker_state", () => {
    db.initWorkerState("alpha");
    const malicious: Record<string, string | number | null> = {
      "id; DROP TABLE bots; --": 1,
    };
    expect(() =>
      db.updateWorkerState(
        "alpha",
        // Cast bypasses the static type so we can exercise the runtime guard
        // — the whole point of the allowlist is to defend against callers
        // that have already lost the compile-time check.
        malicious as unknown as Parameters<typeof db.updateWorkerState>[1],
      ),
    ).toThrow(/not updatable/);
    // Worker row remains untouched.
    const row = db.getWorkerState("alpha");
    expect(row).not.toBeNull();
    expect(row!.status).toBe("starting");
  });

  test("rejects an off-table column on worker_state (codex_thread_id is set via its own helper)", () => {
    db.initWorkerState("alpha");
    expect(() =>
      db.updateWorkerState("alpha", {
        codex_thread_id: "thr_123",
      } as unknown as Parameters<typeof db.updateWorkerState>[1]),
    ).toThrow(/not updatable/);
  });

  test("rejects a malicious column key on stream_state before touching the DB", () => {
    expect(() =>
      db.updateStreamState(1, {
        "buffer_text = '' WHERE 1=1; --": "x",
      } as unknown as Parameters<typeof db.updateStreamState>[1]),
    ).toThrow(/not updatable/);
  });

  test("rejects an empty patch rather than emitting malformed SQL", () => {
    db.initWorkerState("alpha");
    expect(() => db.updateWorkerState("alpha", {})).toThrow(/empty update/);
  });
});
