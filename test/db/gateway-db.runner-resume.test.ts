// Cross-restart runner-resume helpers on GatewayDB. Codex captures a
// thread_id on the first turn of a session; persisting it in worker_state
// lets the next gateway process resume the same thread instead of starting
// a fresh one.

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
  tmpDir = mkdtempSync(join(tmpdir(), "torana-gdb-rr-"));
  dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("gateway-db: codex thread_id persistence", () => {
  test("returns null when the bot has no row at all", () => {
    expect(db.getCodexThreadId("missing")).toBeNull();
  });

  test("returns null for an initialized worker that hasn't captured a thread_id", () => {
    db.initWorkerState("alpha");
    expect(db.getCodexThreadId("alpha")).toBeNull();
  });

  test("set + get round-trip", () => {
    db.initWorkerState("alpha");
    db.setCodexThreadId("alpha", "tid-abc");
    expect(db.getCodexThreadId("alpha")).toBe("tid-abc");
  });

  test("setCodexThreadId(null) clears a previously captured id", () => {
    db.initWorkerState("alpha");
    db.setCodexThreadId("alpha", "tid-abc");
    db.setCodexThreadId("alpha", null);
    expect(db.getCodexThreadId("alpha")).toBeNull();
  });

  test("initWorkerState preserves an existing thread_id across restarts", () => {
    // Simulate first boot: worker created, thread_id captured on turn 1.
    db.initWorkerState("alpha");
    db.setCodexThreadId("alpha", "tid-abc");

    // Simulate a gateway restart: initWorkerState resets status + pid but
    // must NOT touch codex_thread_id, otherwise we lose the session.
    db.initWorkerState("alpha");

    expect(db.getCodexThreadId("alpha")).toBe("tid-abc");
  });

  test("thread_ids for distinct bots are independent", () => {
    db.initWorkerState("alpha");
    db.initWorkerState("beta");
    db.setCodexThreadId("alpha", "tid-a");
    db.setCodexThreadId("beta", "tid-b");
    expect(db.getCodexThreadId("alpha")).toBe("tid-a");
    expect(db.getCodexThreadId("beta")).toBe("tid-b");
  });
});
