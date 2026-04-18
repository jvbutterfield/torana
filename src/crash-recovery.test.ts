import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { GatewayDB } from "./db.js";
import type { PersonaName } from "./config.js";
import type { TelegramClient } from "./telegram.js";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import the crash recovery function by re-implementing its logic in tests
// (it's not exported from main.ts, so we test the DB operations it performs)

let db: GatewayDB;
let dbPath: string;

beforeEach(() => {
  dbPath = join(tmpdir(), `gateway-crash-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(dbPath + "-wal"); } catch {}
  try { unlinkSync(dbPath + "-shm"); } catch {}
});

describe("crash recovery: orphaned running turns", () => {
  test("running turn with no output is requeued", () => {
    const uid = db.insertUpdate("cato", 100, 123, 1, "user1", '{"message":{"text":"hi"}}')!;
    const turnId = db.createTurn("cato", 123, uid);
    db.startTurn(turnId, 1);

    // Simulate crash: turn is "running" but no first_output_at
    const running = db.getRunningTurns();
    expect(running).toHaveLength(1);
    expect(running[0].first_output_at).toBeNull();

    // Recovery: requeue
    db.requeueTurn(turnId);

    expect(db.getRunningTurns()).toHaveLength(0);
    expect(db.getQueuedTurns("cato")).toHaveLength(1);
    expect(db.getQueuedTurns("cato")[0].id).toBe(turnId);
  });

  test("running turn with partial output is interrupted", () => {
    const uid = db.insertUpdate("cato", 100, 123, 1, "user1", '{"message":{"text":"hi"}}')!;
    const turnId = db.createTurn("cato", 123, uid);
    db.startTurn(turnId, 1);
    db.setTurnFirstOutput(turnId); // Simulates output was produced

    const running = db.getRunningTurns();
    expect(running).toHaveLength(1);
    expect(running[0].first_output_at).not.toBeNull();

    // Recovery: interrupt
    db.interruptTurn(turnId, "Gateway restarted during active turn");

    expect(db.getRunningTurns()).toHaveLength(0);
    expect(db.getQueuedTurns("cato")).toHaveLength(0);
  });

  test("multiple orphaned turns across personas are all recovered", () => {
    const u1 = db.insertUpdate("cato", 100, 123, 1, "user1", '{}')!;
    const u2 = db.insertUpdate("harper", 101, 456, 2, "user1", '{}')!;
    const u3 = db.insertUpdate("trader", 102, 789, 3, "user1", '{}')!;

    const t1 = db.createTurn("cato", 123, u1);
    const t2 = db.createTurn("harper", 456, u2);
    const t3 = db.createTurn("trader", 789, u3);

    db.startTurn(t1, 1);
    db.startTurn(t2, 1);
    db.startTurn(t3, 1);
    db.setTurnFirstOutput(t2); // Only harper had output

    const running = db.getRunningTurns();
    expect(running).toHaveLength(3);

    // Recovery
    for (const turn of running) {
      if (!turn.first_output_at) {
        db.requeueTurn(turn.id);
      } else {
        db.interruptTurn(turn.id, "restart");
      }
    }

    expect(db.getRunningTurns()).toHaveLength(0);
    expect(db.getQueuedTurns("cato")).toHaveLength(1); // requeued
    expect(db.getQueuedTurns("harper")).toHaveLength(0); // interrupted
    expect(db.getQueuedTurns("trader")).toHaveLength(1); // requeued
  });
});

describe("crash recovery: stale outbox", () => {
  test("superseded edit is marked failed", () => {
    const uid = db.insertUpdate("cato", 100, 123, 1, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, uid);

    // Two edits to the same telegram message
    const edit1 = db.insertOutbox(turnId, "cato", 123, "edit", '{"text":"v1"}', 999);
    const edit2 = db.insertOutbox(turnId, "cato", 123, "edit", '{"text":"v2"}', 999);
    db.markOutboxSent(edit2);

    // edit1 is pending, edit2 is sent → edit1 is superseded
    expect(db.hasSupersedingEdit(999, edit1)).toBe(true);
    db.markOutboxFailed(edit1, "superseded by later send");

    expect(db.getPendingOutbox()).toHaveLength(0);
  });

  test("pending send is left for outbox processor", () => {
    const uid = db.insertUpdate("cato", 100, 123, 1, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, uid);
    db.insertOutbox(turnId, "cato", 123, "send", '{"text":"hi"}');

    // No superseding edit for sends
    const pending = db.getPendingOutbox();
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("send");
  });

  test("pending sends for re-queued turn are cancelled to prevent duplicate placeholders", () => {
    // Simulate: turn was dispatched, "thinking..." placeholder was queued in outbox
    // but NOT yet delivered (callback never fired) when the gateway crashed.
    const uid = db.insertUpdate("cato", 100, 123, 1, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, uid);
    db.startTurn(turnId, 1);
    db.initStreamState(turnId);
    db.insertOutbox(turnId, "cato", 123, "send", '{"text":"👀 thinking..."}');

    // Crash recovery: requeue the turn and cancel stale outbox items
    db.requeueTurn(turnId);
    db.cancelPendingOutboxForTurn(turnId);

    // Stale placeholder should be cancelled — only the new startTurn placeholder fires
    expect(db.getPendingOutbox()).toHaveLength(0);
    // Turn should be ready for re-dispatch
    expect(db.getQueuedTurns("cato")).toHaveLength(1);
    expect(db.getQueuedTurns("cato")[0].id).toBe(turnId);
  });

  test("edit without superseding entry is left for processor", () => {
    const uid = db.insertUpdate("cato", 100, 123, 1, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, uid);
    const editId = db.insertOutbox(turnId, "cato", 123, "edit", '{"text":"v1"}', 999);

    expect(db.hasSupersedingEdit(999, editId)).toBe(false);
    expect(db.getPendingOutbox()).toHaveLength(1);
  });
});

describe("crash recovery: worker state reset", () => {
  test("all worker states reset to starting", () => {
    db.initWorkerState("cato");
    db.initWorkerState("harper");
    db.initWorkerState("trader");

    db.updateWorkerState("cato", { status: "ready", pid: 1234 });
    db.updateWorkerState("harper", { status: "busy", pid: 5678 });
    db.updateWorkerState("trader", { status: "degraded", last_error: "auth" });

    db.resetAllWorkerStates();

    for (const p of ["cato", "harper", "trader"] as PersonaName[]) {
      const state = db.getWorkerState(p);
      expect(state!.status).toBe("starting");
      expect(state!.pid).toBeNull();
    }
  });
});
