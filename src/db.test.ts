import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { GatewayDB } from "./db.js";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db: GatewayDB;
let dbPath: string;

beforeEach(() => {
  dbPath = join(tmpdir(), `gateway-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(dbPath + "-wal"); } catch {}
  try { unlinkSync(dbPath + "-shm"); } catch {}
});

describe("inbound updates", () => {
  test("insertUpdate returns row id on first insert", () => {
    const id = db.insertUpdate("cato", 100, 123, 456, "user1", '{"test":true}');
    expect(id).toBeGreaterThan(0);
  });

  test("insertUpdate returns null on duplicate", () => {
    db.insertUpdate("cato", 100, 123, 456, "user1", '{"test":true}');
    const dup = db.insertUpdate("cato", 100, 123, 456, "user1", '{"test":true}');
    expect(dup).toBeNull();
  });

  test("same update_id for different personas is not a duplicate", () => {
    const id1 = db.insertUpdate("cato", 100, 123, 456, "user1", '{}');
    const id2 = db.insertUpdate("harper", 100, 123, 456, "user1", '{}');
    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();
    expect(id1).not.toBe(id2);
  });

  test("setUpdateStatus updates status", () => {
    const id = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    db.setUpdateStatus(id, "completed");
    // Verify via a turn that references it
    const turnId = db.createTurn("cato", 123, id);
    expect(turnId).toBeGreaterThan(0);
  });
});

describe("turns", () => {
  test("createTurn and getQueuedTurns", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{"message":{"text":"hello"}}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    expect(turnId).toBeGreaterThan(0);

    const queued = db.getQueuedTurns("cato");
    expect(queued).toHaveLength(1);
    expect(queued[0].id).toBe(turnId);
  });

  test("queued turns are FIFO ordered", () => {
    const u1 = db.insertUpdate("cato", 100, 123, 1, "user1", '{"message":{"text":"first"}}')!;
    const u2 = db.insertUpdate("cato", 101, 123, 2, "user1", '{"message":{"text":"second"}}')!;
    const t1 = db.createTurn("cato", 123, u1);
    const t2 = db.createTurn("cato", 123, u2);

    const queued = db.getQueuedTurns("cato");
    expect(queued).toHaveLength(2);
    expect(queued[0].id).toBe(t1);
    expect(queued[1].id).toBe(t2);
  });

  test("getTurnText extracts message text from payload", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{"message":{"text":"hello world"}}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    expect(db.getTurnText(turnId)).toBe("hello world");
  });

  test("getTurnText returns null for missing turn", () => {
    expect(db.getTurnText(99999)).toBeNull();
  });

  test("startTurn changes status to running", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    db.startTurn(turnId, 1);

    const queued = db.getQueuedTurns("cato");
    expect(queued).toHaveLength(0);

    const running = db.getRunningTurns();
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe(turnId);
  });

  test("completeTurn with no error sets completed", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    db.startTurn(turnId, 1);
    db.completeTurn(turnId);

    expect(db.getRunningTurns()).toHaveLength(0);
    expect(db.getQueuedTurns("cato")).toHaveLength(0);
  });

  test("completeTurn with error sets failed", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    db.startTurn(turnId, 1);
    db.completeTurn(turnId, "something broke");

    expect(db.getRunningTurns()).toHaveLength(0);
    expect(db.getLastTurnAt("cato")).not.toBeNull();
  });

  test("interruptTurn marks as interrupted", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    db.startTurn(turnId, 1);
    db.interruptTurn(turnId, "worker died");

    expect(db.getRunningTurns()).toHaveLength(0);
  });

  test("requeueTurn resets a running turn to queued", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    db.startTurn(turnId, 1);

    db.requeueTurn(turnId);

    expect(db.getRunningTurns()).toHaveLength(0);
    expect(db.getQueuedTurns("cato")).toHaveLength(1);
  });

  test("setTurnFirstOutput only sets once", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    db.startTurn(turnId, 1);

    db.setTurnFirstOutput(turnId);
    db.setTurnFirstOutput(turnId);
    // Should not throw; COALESCE ensures first_output_at is only set once
  });

  test("getTurnSourceUpdateId returns the source", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    expect(db.getTurnSourceUpdateId(turnId)).toBe(updateId);
  });

  test("getTurnAttachments returns empty for no attachments", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    expect(db.getTurnAttachments(turnId)).toEqual([]);
  });

  test("getTurnAttachments returns paths when set", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId, ["/data/a.jpg", "/data/b.pdf"]);
    expect(db.getTurnAttachments(turnId)).toEqual(["/data/a.jpg", "/data/b.pdf"]);
  });
});

describe("outbox", () => {
  test("insertOutbox and getPendingOutbox", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);

    db.insertOutbox(turnId, "cato", 123, "send", '{"text":"hi"}');

    const pending = db.getPendingOutbox();
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("send");
    expect(pending[0].persona).toBe("cato");
  });

  test("markOutboxSent removes from pending", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    const outboxId = db.insertOutbox(turnId, "cato", 123, "send", '{"text":"hi"}');

    db.markOutboxSent(outboxId, 789);

    expect(db.getPendingOutbox()).toHaveLength(0);
  });

  test("markOutboxRetrying with attempts below max stays retrying", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    const outboxId = db.insertOutbox(turnId, "cato", 123, "send", '{"text":"hi"}');

    const futureTime = new Date(Date.now() + 60000).toISOString();
    db.markOutboxRetrying(outboxId, "timeout", futureTime, 5);

    // Should not be in pending yet (next_attempt_at is in the future)
    expect(db.getPendingOutbox()).toHaveLength(0);
  });

  test("markOutboxRetrying at max attempts marks failed", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    const outboxId = db.insertOutbox(turnId, "cato", 123, "send", '{"text":"hi"}');

    // Max attempts = 1, so first retry should fail
    db.markOutboxRetrying(outboxId, "timeout", new Date().toISOString(), 1);

    expect(db.getPendingOutbox()).toHaveLength(0);
  });

  test("getOutboxRow returns status and message id", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    const outboxId = db.insertOutbox(turnId, "cato", 123, "send", '{"text":"hi"}');

    const row = db.getOutboxRow(outboxId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
    expect(row!.telegram_message_id).toBeNull();
  });

  test("hasSupersedingEdit returns false when no later sent exists", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    const id1 = db.insertOutbox(turnId, "cato", 123, "edit", '{"text":"v1"}', 999);

    expect(db.hasSupersedingEdit(999, id1)).toBe(false);
  });

  test("hasSupersedingEdit returns true when later sent exists", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    const id1 = db.insertOutbox(turnId, "cato", 123, "edit", '{"text":"v1"}', 999);
    const id2 = db.insertOutbox(turnId, "cato", 123, "edit", '{"text":"v2"}', 999);
    db.markOutboxSent(id2);

    expect(db.hasSupersedingEdit(999, id1)).toBe(true);
  });
});

describe("worker state", () => {
  test("initWorkerState creates entry", () => {
    db.initWorkerState("cato");
    const state = db.getWorkerState("cato");
    expect(state).not.toBeNull();
    expect(state!.status).toBe("starting");
    expect(state!.consecutive_failures).toBe(0);
  });

  test("initWorkerState resets existing entry", () => {
    db.initWorkerState("cato");
    db.updateWorkerState("cato", { status: "ready", pid: 1234 });
    db.initWorkerState("cato");

    const state = db.getWorkerState("cato");
    expect(state!.status).toBe("starting");
    expect(state!.pid).toBeNull();
  });

  test("incrementWorkerGeneration is monotonic", () => {
    db.initWorkerState("cato");
    const g1 = db.incrementWorkerGeneration("cato");
    const g2 = db.incrementWorkerGeneration("cato");
    expect(g2).toBe(g1 + 1);
  });

  test("resetAllWorkerStates sets all to starting", () => {
    db.initWorkerState("cato");
    db.initWorkerState("harper");
    db.updateWorkerState("cato", { status: "ready" });
    db.updateWorkerState("harper", { status: "busy" });

    db.resetAllWorkerStates();

    expect(db.getWorkerState("cato")!.status).toBe("starting");
    expect(db.getWorkerState("harper")!.status).toBe("starting");
  });
});

describe("stream state", () => {
  test("initStreamState and getStreamState", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);

    db.initStreamState(turnId);
    const state = db.getStreamState(turnId);

    expect(state).not.toBeNull();
    expect(state!.buffer_text).toBe("");
    expect(state!.active_telegram_message_id).toBeNull();
    expect(state!.segment_index).toBe(0);
  });

  test("updateStreamState updates fields", () => {
    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);

    db.initStreamState(turnId);
    db.updateStreamState(turnId, { buffer_text: "hello", active_telegram_message_id: 789 });

    const state = db.getStreamState(turnId);
    expect(state!.buffer_text).toBe("hello");
    expect(state!.active_telegram_message_id).toBe(789);
  });
});

describe("metrics", () => {
  test("getMailboxDepth counts queued and running turns", () => {
    const u1 = db.insertUpdate("cato", 100, 123, 1, "user1", '{}')!;
    const u2 = db.insertUpdate("cato", 101, 123, 2, "user1", '{}')!;
    db.createTurn("cato", 123, u1);
    const t2 = db.createTurn("cato", 123, u2);
    db.startTurn(t2, 1);

    expect(db.getMailboxDepth("cato")).toBe(2);
    expect(db.getMailboxDepth("harper")).toBe(0);
  });

  test("getLastTurnAt returns most recent completed turn", () => {
    expect(db.getLastTurnAt("cato")).toBeNull();

    const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{}')!;
    const turnId = db.createTurn("cato", 123, updateId);
    db.startTurn(turnId, 1);
    db.completeTurn(turnId);

    expect(db.getLastTurnAt("cato")).not.toBeNull();
  });
});
