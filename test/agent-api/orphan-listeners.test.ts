// Orphan-listener unit tests. Covers:
//   - terminal-event DB application (done/error/fatal)
//   - pool.release invocation on resolve
//   - backstop timer fires + force-releases
//   - metric emission for each of the 4 resolution outcomes
//   - shutdown() force-releases unresolved registrations without counting
//     them as real resolutions (drop-on-shutdown is not a runner outcome)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { OrphanListenerManager } from "../../src/agent-api/orphan-listeners.js";
import { Metrics } from "../../src/metrics.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";
import type {
  AgentRunner,
  RunnerEvent,
  RunnerEventHandler,
  RunnerEventKind,
  Unsubscribe,
} from "../../src/runner/types.js";

/**
 * A minimal side-session-only runner stub. onSide stores handlers by
 * (sessionId, event); `emit()` dispatches synchronously to every matching
 * handler. Good enough for the listener's contract: it subscribes to
 * done/error/fatal/text_delta at attach time.
 */
class FakeSideRunner {
  readonly botId = "bot1";
  private handlers = new Map<string, Set<(ev: RunnerEvent) => void>>();

  supportsSideSessions(): boolean {
    return true;
  }

  onSide<E extends RunnerEventKind>(
    sessionId: string,
    event: E,
    handler: RunnerEventHandler<E>,
  ): Unsubscribe {
    const key = `${sessionId}\u0000${event}`;
    const set = this.handlers.get(key) ?? new Set();
    set.add(handler as (ev: RunnerEvent) => void);
    this.handlers.set(key, set);
    return () => set.delete(handler as (ev: RunnerEvent) => void);
  }

  /** Dispatch an event to every matching onSide listener. */
  emit(sessionId: string, ev: RunnerEvent): void {
    const key = `${sessionId}\u0000${ev.kind}`;
    const set = this.handlers.get(key);
    if (!set) return;
    for (const h of [...set]) h(ev);
  }
}

/** Pool stub — just records release calls; inline so listener can call it. */
class FakePool {
  public readonly releases: Array<{ botId: string; sessionId: string }> = [];
  release(botId: string, sessionId: string): void {
    this.releases.push({ botId, sessionId });
  }
}

let tmpDir: string;
let db: GatewayDB;
let metrics: Metrics;
let pool: FakePool;
let runner: FakeSideRunner;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-orphan-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);
  metrics = new Metrics(makeTestConfig([makeTestBotConfig("bot1")]));
  pool = new FakePool();
  runner = new FakeSideRunner();
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedTurn(): number {
  return db.insertAskTurn({
    botId: "bot1",
    tokenName: "caller",
    sessionId: "s1",
    textPreview: "hi",
    attachmentPaths: [],
  });
}

function attach(listener: OrphanListenerManager, turnId: number, backstopMs?: number): void {
  listener.attach({
    runner: runner as unknown as AgentRunner,
    botId: "bot1",
    sessionId: "s1",
    turnId,
    backstopMs,
  });
}

describe("OrphanListenerManager — metric emission per resolution", () => {
  test("done outcome → ask_orphan_resolutions_done + DB final text + pool.release", () => {
    const listener = new OrphanListenerManager(db, pool as never, metrics);
    const turnId = seedTurn();
    attach(listener, turnId);

    runner.emit("s1", { kind: "text_delta", turnId: String(turnId), text: "hello " });
    runner.emit("s1", { kind: "text_delta", turnId: String(turnId), text: "world" });
    runner.emit("s1", {
      kind: "done",
      turnId: String(turnId),
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
      finalText: "hello world",
      durationMs: 42,
    });

    const counters = metrics.agentApiSnapshot().bot1.counters;
    expect(counters.ask_orphan_resolutions_done).toBe(1);
    expect(counters.ask_orphan_resolutions_error).toBe(0);
    expect(counters.ask_orphan_resolutions_fatal).toBe(0);
    expect(counters.ask_orphan_resolutions_backstop).toBe(0);

    const row = db.getTurnExtended(turnId);
    expect(row?.status).toBe("completed");
    expect(row?.final_text).toBe("hello world");
    expect(pool.releases).toEqual([{ botId: "bot1", sessionId: "s1" }]);
  });

  test("error outcome → ask_orphan_resolutions_error + DB completeTurn", () => {
    const listener = new OrphanListenerManager(db, pool as never, metrics);
    const turnId = seedTurn();
    attach(listener, turnId);

    runner.emit("s1", {
      kind: "error",
      turnId: String(turnId),
      message: "runner refused",
      retriable: false,
    });

    expect(
      metrics.agentApiSnapshot().bot1.counters.ask_orphan_resolutions_error,
    ).toBe(1);
    const row = db.getTurnExtended(turnId);
    expect(row?.status).toBe("failed");
    expect(row?.error_text).toContain("runner refused");
  });

  test("fatal outcome → ask_orphan_resolutions_fatal", () => {
    const listener = new OrphanListenerManager(db, pool as never, metrics);
    const turnId = seedTurn();
    attach(listener, turnId);

    runner.emit("s1", {
      kind: "fatal",
      message: "auth expired",
      code: "auth",
    });

    expect(
      metrics.agentApiSnapshot().bot1.counters.ask_orphan_resolutions_fatal,
    ).toBe(1);
  });

  test("backstop timer → ask_orphan_resolutions_backstop", async () => {
    const listener = new OrphanListenerManager(db, pool as never, metrics);
    const turnId = seedTurn();
    attach(listener, turnId, 20); // 20ms backstop

    // No runner events — let the timer fire.
    await new Promise((r) => setTimeout(r, 80));

    const counters = metrics.agentApiSnapshot().bot1.counters;
    expect(counters.ask_orphan_resolutions_backstop).toBe(1);
    expect(counters.ask_orphan_resolutions_error).toBe(0); // backstop, not error
    expect(pool.releases).toEqual([{ botId: "bot1", sessionId: "s1" }]);

    const row = db.getTurnExtended(turnId);
    expect(row?.status).toBe("failed");
    expect(row?.error_text).toContain("backstop");
  });

  test("double terminal events → only first bumps counters", () => {
    const listener = new OrphanListenerManager(db, pool as never, metrics);
    const turnId = seedTurn();
    attach(listener, turnId);

    runner.emit("s1", {
      kind: "done",
      turnId: String(turnId),
      finalText: "first",
    });
    // Re-emitting must be a no-op — resolved=true bailout.
    runner.emit("s1", {
      kind: "error",
      turnId: String(turnId),
      message: "late",
      retriable: false,
    });

    const counters = metrics.agentApiSnapshot().bot1.counters;
    expect(counters.ask_orphan_resolutions_done).toBe(1);
    expect(counters.ask_orphan_resolutions_error).toBe(0);
    expect(pool.releases.length).toBe(1);
  });

  test("shutdown force-release does NOT count as a resolution", () => {
    const listener = new OrphanListenerManager(db, pool as never, metrics);
    const turnId = seedTurn();
    attach(listener, turnId);

    listener.shutdown();

    // Shutdown releases the pool (so drain can complete) but isn't a real
    // runner outcome — the turn stays at whatever status it had (running)
    // and NO counter is touched. agentApiSnapshot() is a map of bots that
    // have had at least one initAgentApi call; since we never recorded a
    // resolution, the bot1 entry shouldn't exist at all.
    const snap = metrics.agentApiSnapshot();
    expect(snap.bot1).toBeUndefined();
    expect(pool.releases).toEqual([{ botId: "bot1", sessionId: "s1" }]);
  });

  test("undefined metrics → listener still functions, no throw", () => {
    const listener = new OrphanListenerManager(db, pool as never); // metrics omitted
    const turnId = seedTurn();
    attach(listener, turnId);

    runner.emit("s1", { kind: "done", turnId: String(turnId), finalText: "ok" });
    expect(pool.releases.length).toBe(1);
  });
});
