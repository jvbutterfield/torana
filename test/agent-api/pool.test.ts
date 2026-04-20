// SideSessionPool behavior tests — uses a fake runner so we don't spawn
// real subprocesses. Covers acquire / reuse / miss / caps / LRU / TTL /
// release / shutdown / spawn-failure.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { SideSessionPool } from "../../src/agent-api/pool.js";
import { makeTestConfig, makeTestBotConfig } from "../fixtures/bots.js";
import type { Config } from "../../src/config/schema.js";

class FakeRunner {
  readonly botId: string;
  readonly sessions = new Set<string>();
  public startSideSession = async (id: string): Promise<void> => {
    this.sessions.add(id);
  };
  public stopSideSession = async (id: string): Promise<void> => {
    this.sessions.delete(id);
  };
  constructor(botId: string) {
    this.botId = botId;
  }
  supportsSideSessions(): boolean {
    return true;
  }
}

function fakeRegistry(runners: Map<string, FakeRunner>): {
  bot(id: string): { runner: FakeRunner } | undefined;
  botIds: string[];
} {
  return {
    bot(id: string) {
      const runner = runners.get(id);
      return runner ? { runner } : undefined;
    },
    get botIds() {
      return [...runners.keys()];
    },
  };
}

function configForCaps(maxPerBot: number, maxGlobal: number): Config {
  const bot = makeTestBotConfig("bot1");
  const cfg = makeTestConfig([bot]);
  cfg.agent_api.enabled = true;
  cfg.agent_api.side_sessions = {
    idle_ttl_ms: 60_000,
    hard_ttl_ms: 600_000,
    max_per_bot: maxPerBot,
    max_global: maxGlobal,
  };
  return cfg;
}

let tmpDir: string;
let db: GatewayDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-pool-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SideSessionPool: acquire", () => {
  test("ephemeral path mints unique id and spawns", async () => {
    const runner = new FakeRunner("bot1");
    const config = configForCaps(4, 8);
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
    });
    const r = await pool.acquire("bot1", null);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.ephemeral).toBe(true);
      expect(r.sessionId).toMatch(/^eph-/);
      expect(runner.sessions.has(r.sessionId)).toBe(true);
    }
  });

  test("keyed reuse: second acquire with same id while idle returns ok", async () => {
    const runner = new FakeRunner("bot1");
    const config = configForCaps(4, 8);
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
    });
    const first = await pool.acquire("bot1", "sess-1");
    expect(first.kind).toBe("ok");
    pool.release("bot1", "sess-1");
    const second = await pool.acquire("bot1", "sess-1");
    expect(second.kind).toBe("ok");
    expect(runner.sessions.size).toBe(1); // reused — only one spawn
  });

  test("keyed busy: second acquire while the first is inflight → busy", async () => {
    const runner = new FakeRunner("bot1");
    const config = configForCaps(4, 8);
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
    });
    await pool.acquire("bot1", "sess-1");
    // Don't release — inflight stays at 1.
    const second = await pool.acquire("bot1", "sess-1");
    expect(second.kind).toBe("busy");
  });

  test("unsupported runner → runner_does_not_support_side_sessions", async () => {
    const runner = new FakeRunner("bot1");
    runner.supportsSideSessions = () => false;
    const config = configForCaps(4, 8);
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
    });
    const r = await pool.acquire("bot1", null);
    expect(r.kind).toBe("runner_does_not_support_side_sessions");
  });

  test("spawn failure → runner_error + no phantom entry", async () => {
    const runner = new FakeRunner("bot1");
    runner.startSideSession = async () => {
      throw new Error("boom");
    };
    const config = configForCaps(4, 8);
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
    });
    const r = await pool.acquire("bot1", "sess-1");
    expect(r.kind).toBe("runner_error");
    expect(pool.listForBot("bot1")).toEqual([]);
  });
});

describe("SideSessionPool: global LRU eviction across bots", () => {
  test("global cap full → evicts an idle entry from any bot", async () => {
    // PRD US-008: "If `max_per_bot` or `max_global` reached: LRU-evict the
    // oldest idle entry for that bot (or globally)." Exercises the
    // `total >= globalMax` branch in pool.ts:301-306, which the per-bot
    // LRU test does not reach.
    const r1 = new FakeRunner("bot1");
    const r2 = new FakeRunner("bot2");
    const bot1Cfg = makeTestBotConfig("bot1");
    const bot2Cfg = makeTestBotConfig("bot2");
    const cfg = makeTestConfig([bot1Cfg, bot2Cfg]);
    cfg.agent_api.enabled = true;
    cfg.agent_api.side_sessions = {
      idle_ttl_ms: 60_000,
      hard_ttl_ms: 600_000,
      max_per_bot: 2,
      max_global: 2,
    };
    let now = 1_000_000;
    const pool = new SideSessionPool({
      config: cfg,
      db,
      registry: fakeRegistry(
        new Map([
          ["bot1", r1],
          ["bot2", r2],
        ]),
      ) as never,
      clock: () => now,
    });

    // Fill global cap with one bot1 idle entry and one bot2 idle entry.
    await pool.acquire("bot1", "b1-old");
    pool.release("bot1", "b1-old");
    now += 1000;
    await pool.acquire("bot2", "b2-newer");
    pool.release("bot2", "b2-newer");
    now += 1000;

    // Acquire on bot2 again with a new id — must evict the global LRU
    // (which is bot1's b1-old) even though bot2 is the requesting bot.
    const r = await pool.acquire("bot2", "b2-fresh");
    expect(r.kind).toBe("ok");
    await new Promise((res) => setTimeout(res, 20));
    const bot1Ids = pool.listForBot("bot1").map((s) => s.sessionId);
    const bot2Ids = pool.listForBot("bot2").map((s) => s.sessionId);
    expect(bot1Ids).not.toContain("b1-old");
    expect(bot2Ids).toContain("b2-fresh");
    // The global cap is still respected.
    expect(bot1Ids.length + bot2Ids.length).toBeLessThanOrEqual(2);
  });

  test("global cap full with NO evictable entries → capacity", async () => {
    // Both slots inflight on different bots → no idle entry to evict
    // anywhere → 429 capacity from the global branch.
    const r1 = new FakeRunner("bot1");
    const r2 = new FakeRunner("bot2");
    const bot1Cfg = makeTestBotConfig("bot1");
    const bot2Cfg = makeTestBotConfig("bot2");
    const cfg = makeTestConfig([bot1Cfg, bot2Cfg]);
    cfg.agent_api.enabled = true;
    cfg.agent_api.side_sessions = {
      idle_ttl_ms: 60_000,
      hard_ttl_ms: 600_000,
      max_per_bot: 2,
      max_global: 2,
    };
    const pool = new SideSessionPool({
      config: cfg,
      db,
      registry: fakeRegistry(
        new Map([
          ["bot1", r1],
          ["bot2", r2],
        ]),
      ) as never,
    });
    // Hold both slots inflight (no release).
    await pool.acquire("bot1", "b1-busy");
    await pool.acquire("bot2", "b2-busy");
    const r = await pool.acquire("bot2", "b2-fresh");
    expect(r.kind).toBe("capacity");
  });
});

describe("SideSessionPool: caps + LRU", () => {
  test("per-bot cap with no idle entries → capacity", async () => {
    const runner = new FakeRunner("bot1");
    const config = configForCaps(2, 8);
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
    });
    await pool.acquire("bot1", "sess-1");
    await pool.acquire("bot1", "sess-2");
    // Both still inflight → third acquire has no evictable entry.
    const r = await pool.acquire("bot1", "sess-3");
    expect(r.kind).toBe("capacity");
  });

  test("per-bot cap evicts LRU idle entry", async () => {
    const runner = new FakeRunner("bot1");
    const config = configForCaps(2, 8);
    let now = 1_000_000;
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
      clock: () => now,
    });
    await pool.acquire("bot1", "sess-1");
    pool.release("bot1", "sess-1");
    now += 1000;
    await pool.acquire("bot1", "sess-2");
    pool.release("bot1", "sess-2");
    now += 1000;
    // Now both idle but sess-1 older. Acquire sess-3 → should evict sess-1.
    const r = await pool.acquire("bot1", "sess-3");
    expect(r.kind).toBe("ok");
    // Give the eviction microtask time to land.
    await new Promise((res) => setTimeout(res, 20));
    const ids = pool.listForBot("bot1").map((s) => s.sessionId);
    expect(ids).toContain("sess-3");
    expect(ids).not.toContain("sess-1");
  });
});

describe("SideSessionPool: TTL sweeps", () => {
  test("idle sweep reaps entries past idle_ttl_ms", async () => {
    const runner = new FakeRunner("bot1");
    const config = configForCaps(4, 8);
    config.agent_api.side_sessions.idle_ttl_ms = 10_000;
    let now = 1_000_000;
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
      clock: () => now,
      sweepIntervalMs: 60_000, // no auto sweep
    });
    await pool.acquire("bot1", "sess-1");
    pool.release("bot1", "sess-1");

    // Advance past idle TTL and run the sweep manually.
    now += 20_000;
    // Expose sweep via test path: call shutdown-lite by reaching into pool
    // with the fake clock and triggering a sweep via startSweeper/stopSweeper.
    (pool as unknown as { sweep(): void }).sweep();
    await new Promise((r) => setTimeout(r, 20));
    expect(pool.listForBot("bot1")).toEqual([]);
  });

  test("hard TTL with inflight=0 stops immediately", async () => {
    const runner = new FakeRunner("bot1");
    const config = configForCaps(4, 8);
    config.agent_api.side_sessions.hard_ttl_ms = 1000;
    let now = 1_000_000;
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
      clock: () => now,
      sweepIntervalMs: 60_000,
    });
    await pool.acquire("bot1", "sess-1");
    pool.release("bot1", "sess-1");
    now += 2000;
    (pool as unknown as { sweep(): void }).sweep();
    await new Promise((r) => setTimeout(r, 20));
    expect(pool.listForBot("bot1")).toEqual([]);
  });

  test("hard TTL with inflight>0 marks stopping (drain on release)", async () => {
    const runner = new FakeRunner("bot1");
    const config = configForCaps(4, 8);
    config.agent_api.side_sessions.hard_ttl_ms = 1000;
    let now = 1_000_000;
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
      clock: () => now,
      sweepIntervalMs: 60_000,
    });
    await pool.acquire("bot1", "sess-1");
    now += 2000;
    (pool as unknown as { sweep(): void }).sweep();
    let snap = pool.listForBot("bot1");
    expect(snap[0]!.state).toBe("stopping");
    // Release drops inflight → scheduleStop completes.
    pool.release("bot1", "sess-1");
    await new Promise((r) => setTimeout(r, 20));
    snap = pool.listForBot("bot1");
    expect(snap).toEqual([]);
  });
});

describe("SideSessionPool: release + ephemeral auto-stop", () => {
  test("release of an ephemeral entry with inflight=0 schedules stop", async () => {
    const runner = new FakeRunner("bot1");
    const config = configForCaps(4, 8);
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
    });
    const r = await pool.acquire("bot1", null);
    if (r.kind !== "ok") throw new Error("expected ok");
    pool.release("bot1", r.sessionId);
    await new Promise((res) => setTimeout(res, 20));
    expect(pool.listForBot("bot1")).toEqual([]);
    expect(runner.sessions.size).toBe(0);
  });

  test("release on a missing entry is a no-op (crash-safe)", () => {
    const runner = new FakeRunner("bot1");
    const config = configForCaps(4, 8);
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
    });
    expect(() => pool.release("bot1", "never-existed")).not.toThrow();
  });
});

describe("SideSessionPool: shutdown", () => {
  test("shutdown stops all entries and returns", async () => {
    const runner = new FakeRunner("bot1");
    const config = configForCaps(4, 8);
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
    });
    await pool.acquire("bot1", "sess-1");
    await pool.acquire("bot1", "sess-2");
    await pool.shutdown(1000);
    expect(runner.sessions.size).toBe(0);
    expect(pool.listForBot("bot1")).toEqual([]);
  });

  test("acquire after shutdown → gateway_shutting_down", async () => {
    const runner = new FakeRunner("bot1");
    const config = configForCaps(4, 8);
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
    });
    await pool.shutdown(1000);
    const r = await pool.acquire("bot1", null);
    expect(r.kind).toBe("gateway_shutting_down");
  });
});
