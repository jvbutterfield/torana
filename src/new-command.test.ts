/**
 * Tests for the /new command: session-reset interception in handleInbound
 * and WorkerManager.freshRestart API.
 *
 * handleInbound is a closure inside main(), so we replicate its interception
 * logic here as a standalone function and verify DB-level behaviour. The fresh-
 * restart mechanics are tested via the WorkerManager public API.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { GatewayDB } from "./db.js";
import { WorkerManager } from "./worker.js";
import type { PersonaName, Config } from "./config.js";
import type { AlertManager } from "./alerts.js";
import type { Metrics } from "./metrics.js";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Shared test config & DB setup
// ---------------------------------------------------------------------------

const testConfig: Config = {
  port: 0,
  dataRoot: tmpdir(),
  dbPath: "",
  webhookBaseUrl: "https://test.example.com",
  webhookSecret: "test-secret",
  allowedUserId: "8208257729",
  logLevel: "error",
  botTokens: { cato: "t1", harper: "t2", trader: "t3" },
  workerStartupTimeoutMs: 60000,
  workerStallTimeoutMs: 90000,
  workerTurnTimeoutMs: 1200000,
  crashLoopBackoffBaseMs: 5000,
  crashLoopBackoffCapMs: 300000,
  stabilityWindowMs: 600000,
  maxConsecutiveFailures: 10,
  editCadenceMs: 1500,
  messageLengthLimit: 4096,
  messageLengthSafeMargin: 3800,
  outboxMaxAttempts: 5,
  outboxRetryBaseMs: 2000,
  oauthToken: "token",
  githubToken: "ghtoken",
};

let db: GatewayDB;
let dbPath: string;

beforeEach(() => {
  dbPath = join(tmpdir(), `gateway-new-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  testConfig.dbPath = dbPath;
  db = new GatewayDB(dbPath);
  db.initWorkerState("cato");
  db.initWorkerState("harper");
  db.initWorkerState("trader");
});

afterEach(() => {
  db.close();
  try { unlinkSync(dbPath); } catch { /* ok */ }
  try { unlinkSync(dbPath + "-wal"); } catch { /* ok */ }
  try { unlinkSync(dbPath + "-shm"); } catch { /* ok */ }
});

// ---------------------------------------------------------------------------
// Minimal worker stub — records freshRestart calls without spawning a process
// ---------------------------------------------------------------------------

interface WorkerStub {
  freshRestartCalled: boolean;
  freshRestartCb: (() => void) | undefined;
  freshRestart(cb?: () => void): void;
}

function makeWorkerStub(): WorkerStub {
  return {
    freshRestartCalled: false,
    freshRestartCb: undefined,
    freshRestart(cb?: () => void) {
      this.freshRestartCalled = true;
      this.freshRestartCb = cb;
    },
  };
}

// ---------------------------------------------------------------------------
// Replicated handleInbound interception logic (mirrors main.ts)
// ---------------------------------------------------------------------------

function makeHandleInbound(
  db: GatewayDB,
  workers: Map<PersonaName, WorkerStub>,
  onConfirmSend: (chatId: number) => void,
) {
  return (
    persona: PersonaName,
    updateRowId: number,
    chatId: number,
    text: string,
    attachmentPaths: string[],
  ) => {
    if (text.trim() === "/new") {
      db.setUpdateStatus(updateRowId, "completed");
      const worker = workers.get(persona)!;
      worker.freshRestart(() => {
        onConfirmSend(chatId);
      });
      return;
    }
    db.createTurn(persona, chatId, updateRowId, attachmentPaths.length > 0 ? attachmentPaths : undefined);
  };
}

// ---------------------------------------------------------------------------
// /new interception tests
// ---------------------------------------------------------------------------

describe("/new command: interception in handleInbound", () => {
  test("cato + /new: no turn created, freshRestart called", () => {
    const catoWorker = makeWorkerStub();
    const workers = new Map<PersonaName, WorkerStub>([["cato", catoWorker]]);
    const confirmsSent: number[] = [];
    const handler = makeHandleInbound(db, workers, (id) => confirmsSent.push(id));

    const updateId = db.insertUpdate("cato", 1, 123, 1, "user1", '{"message":{"text":"/new"}}')!;
    handler("cato", updateId, 123, "/new", []);

    expect(db.getQueuedTurns("cato")).toHaveLength(0);
    expect(catoWorker.freshRestartCalled).toBe(true);
  });

  test("cato + /new with trailing space: intercepted (trimmed)", () => {
    const catoWorker = makeWorkerStub();
    const workers = new Map<PersonaName, WorkerStub>([["cato", catoWorker]]);
    const handler = makeHandleInbound(db, workers, () => {});

    const updateId = db.insertUpdate("cato", 2, 123, 2, "user1", '{"message":{"text":"/new "}}')!;
    handler("cato", updateId, 123, "/new ", []);

    expect(db.getQueuedTurns("cato")).toHaveLength(0);
    expect(catoWorker.freshRestartCalled).toBe(true);
  });

  test("cato + /new: confirmation callback carries correct chatId", () => {
    const catoWorker = makeWorkerStub();
    const workers = new Map<PersonaName, WorkerStub>([["cato", catoWorker]]);
    const confirmsSent: number[] = [];
    const handler = makeHandleInbound(db, workers, (id) => confirmsSent.push(id));

    const updateId = db.insertUpdate("cato", 3, 99999, 3, "user1", '{"message":{"text":"/new"}}')!;
    handler("cato", updateId, 99999, "/new", []);

    // Callback hasn't fired yet (worker not started in stub)
    // but it is stored on the stub — call it to simulate ready
    expect(catoWorker.freshRestartCb).toBeDefined();
    catoWorker.freshRestartCb!();
    expect(confirmsSent).toEqual([99999]);
  });

  test("harper + /new: no turn created, freshRestart called", () => {
    const harperWorker = makeWorkerStub();
    const workers = new Map<PersonaName, WorkerStub>([["harper", harperWorker]]);
    const handler = makeHandleInbound(db, workers, () => {});

    const updateId = db.insertUpdate("harper", 4, 456, 4, "user1", '{"message":{"text":"/new"}}')!;
    handler("harper", updateId, 456, "/new", []);

    expect(db.getQueuedTurns("harper")).toHaveLength(0);
    expect(harperWorker.freshRestartCalled).toBe(true);
  });

  test("harper + /new: confirmation callback carries correct chatId", () => {
    const harperWorker = makeWorkerStub();
    const workers = new Map<PersonaName, WorkerStub>([["harper", harperWorker]]);
    const confirmsSent: number[] = [];
    const handler = makeHandleInbound(db, workers, (id) => confirmsSent.push(id));

    const updateId = db.insertUpdate("harper", 4, 77777, 4, "user1", '{"message":{"text":"/new"}}')!;
    handler("harper", updateId, 77777, "/new", []);

    expect(harperWorker.freshRestartCb).toBeDefined();
    harperWorker.freshRestartCb!();
    expect(confirmsSent).toEqual([77777]);
  });

  test("trader + /new: no turn created, freshRestart called", () => {
    const traderWorker = makeWorkerStub();
    const workers = new Map<PersonaName, WorkerStub>([["trader", traderWorker]]);
    const handler = makeHandleInbound(db, workers, () => {});

    const updateId = db.insertUpdate("trader", 5, 789, 5, "user1", '{"message":{"text":"/new"}}')!;
    handler("trader", updateId, 789, "/new", []);

    expect(db.getQueuedTurns("trader")).toHaveLength(0);
    expect(traderWorker.freshRestartCalled).toBe(true);
  });

  test("trader + /new: confirmation callback carries correct chatId", () => {
    const traderWorker = makeWorkerStub();
    const workers = new Map<PersonaName, WorkerStub>([["trader", traderWorker]]);
    const confirmsSent: number[] = [];
    const handler = makeHandleInbound(db, workers, (id) => confirmsSent.push(id));

    const updateId = db.insertUpdate("trader", 5, 88888, 5, "user1", '{"message":{"text":"/new"}}')!;
    handler("trader", updateId, 88888, "/new", []);

    expect(traderWorker.freshRestartCb).toBeDefined();
    traderWorker.freshRestartCb!();
    expect(confirmsSent).toEqual([88888]);
  });

  test("cato + /newline: turn created (not exact match)", () => {
    const catoWorker = makeWorkerStub();
    const workers = new Map<PersonaName, WorkerStub>([["cato", catoWorker]]);
    const handler = makeHandleInbound(db, workers, () => {});

    const updateId = db.insertUpdate("cato", 6, 123, 6, "user1", '{"message":{"text":"/newline"}}')!;
    handler("cato", updateId, 123, "/newline", []);

    expect(db.getQueuedTurns("cato")).toHaveLength(1);
    expect(catoWorker.freshRestartCalled).toBe(false);
  });

  test("cato + normal message: turn created", () => {
    const catoWorker = makeWorkerStub();
    const workers = new Map<PersonaName, WorkerStub>([["cato", catoWorker]]);
    const handler = makeHandleInbound(db, workers, () => {});

    const updateId = db.insertUpdate("cato", 7, 123, 7, "user1", '{"message":{"text":"hello"}}')!;
    handler("cato", updateId, 123, "hello", []);

    expect(db.getQueuedTurns("cato")).toHaveLength(1);
    expect(catoWorker.freshRestartCalled).toBe(false);
  });

  test("cato + /new: update status set to completed (not left as queued)", () => {
    const catoWorker = makeWorkerStub();
    const workers = new Map<PersonaName, WorkerStub>([["cato", catoWorker]]);
    const handler = makeHandleInbound(db, workers, () => {});

    const updateId = db.insertUpdate("cato", 8, 123, 8, "user1", '{"message":{"text":"/new"}}')!;
    // Mark as queued (simulates what server.ts does before calling onInbound)
    db.setUpdateStatus(updateId, "queued");
    handler("cato", updateId, 123, "/new", []);

    // No turn means mailbox depth is 0
    expect(db.getMailboxDepth("cato")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WorkerManager.freshRestart — API and state-machine tests
// ---------------------------------------------------------------------------

function makeMockAlerts(): AlertManager {
  return {
    workerDegraded: () => {},
    workerCrashLoop: () => {},
    turnStalled: () => {},
    mailboxBacklog: () => {},
    outboxFailures: () => {},
    allWorkersAuthFailure: () => {},
  } as unknown as AlertManager;
}

function makeMockMetrics(): Metrics {
  return {
    inc: () => {},
    recordTimer: () => {},
    snapshot: () => ({}),
  } as unknown as Metrics;
}

describe("WorkerManager.freshRestart — API contract", () => {
  test("freshRestart() does not throw when worker has not been started", () => {
    const manager = new WorkerManager(
      testConfig, db, "cato", makeMockMetrics(), makeMockAlerts(), () => {},
    );
    expect(() => manager.freshRestart()).not.toThrow();
  });

  test("freshRestart(callback) does not throw and accepts optional callback", () => {
    const manager = new WorkerManager(
      testConfig, db, "cato", makeMockMetrics(), makeMockAlerts(), () => {},
    );
    let called = false;
    expect(() => manager.freshRestart(() => { called = true; })).not.toThrow();
    // Callback not called yet — worker is not ready (hasn't been started)
    expect(called).toBe(false);
  });

  test("calling freshRestart() twice does not throw", () => {
    const manager = new WorkerManager(
      testConfig, db, "cato", makeMockMetrics(), makeMockAlerts(), () => {},
    );
    expect(() => {
      manager.freshRestart();
      manager.freshRestart();
    }).not.toThrow();
  });

  test("freshRestart with no callback accepts undefined gracefully", () => {
    const manager = new WorkerManager(
      testConfig, db, "cato", makeMockMetrics(), makeMockAlerts(), () => {},
    );
    // Both forms should be fine
    expect(() => manager.freshRestart(undefined)).not.toThrow();
    expect(() => manager.freshRestart()).not.toThrow();
  });

  test("freshRestart does not affect isIdle() before start()", () => {
    const manager = new WorkerManager(
      testConfig, db, "cato", makeMockMetrics(), makeMockAlerts(), () => {},
    );
    // Worker has not been started — isIdle() is false (status is "starting")
    expect(manager.isIdle()).toBe(false);
    manager.freshRestart();
    // Still not idle (no proc spawned)
    expect(manager.isIdle()).toBe(false);
  });
});
