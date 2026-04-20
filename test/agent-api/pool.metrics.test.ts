// Pool → Metrics wiring. Drives SideSessionPool through realistic event
// sequences (spawn, reuse, busy, capacity, eviction, hard TTL) and asserts
// the Metrics instance observed the counters + histograms + gauge updates
// the Phase 7 façade is supposed to emit.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { SideSessionPool } from "../../src/agent-api/pool.js";
import { Metrics } from "../../src/metrics.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";
import type { Config } from "../../src/config/schema.js";

class FakeRunner {
  readonly botId: string;
  public startSideSession = async (_id: string): Promise<void> => {};
  public stopSideSession = async (_id: string): Promise<void> => {};
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

function configFor(
  maxPerBot: number,
  maxGlobal: number,
  bots: string[] = ["bot1"],
): Config {
  const cfg = makeTestConfig(bots.map((id) => makeTestBotConfig(id)));
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
  tmpDir = mkdtempSync(join(tmpdir(), "torana-pool-metrics-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SideSessionPool → Metrics", () => {
  test("successful spawn records acquire(spawn) + side_sessions_started + live gauge", async () => {
    const runner = new FakeRunner("bot1");
    const metrics = new Metrics(configFor(4, 8));
    const pool = new SideSessionPool({
      config: configFor(4, 8),
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
      metrics,
    });

    const r = await pool.acquire("bot1", null);
    expect(r.kind).toBe("ok");

    const counters = metrics.agentApiSnapshot().bot1.counters;
    expect(counters.side_sessions_started_total).toBe(1);
    expect(counters.side_session_capacity_rejected_total).toBe(0);

    const body = metrics.renderPrometheus({ bot1: 2 });
    expect(body).toContain(
      'torana_agent_api_side_session_acquire_duration_ms_count{bot_id="bot1",outcome="spawn"} 1',
    );
    // Active entry → gauge should read 1 while still in-flight.
    expect(body).toContain(
      'torana_agent_api_side_sessions_live{bot_id="bot1"} 1',
    );
  });

  test("keyed reuse records acquire(reuse) but no new spawn counter bump", async () => {
    const runner = new FakeRunner("bot1");
    const metrics = new Metrics(configFor(4, 8));
    const pool = new SideSessionPool({
      config: configFor(4, 8),
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
      metrics,
    });
    await pool.acquire("bot1", "sess-1");
    pool.release("bot1", "sess-1");
    await pool.acquire("bot1", "sess-1");

    expect(
      metrics.agentApiSnapshot().bot1.counters.side_sessions_started_total,
    ).toBe(1); // Still just the first spawn.
    const body = metrics.renderPrometheus({ bot1: 2 });
    expect(body).toContain(
      'torana_agent_api_side_session_acquire_duration_ms_count{bot_id="bot1",outcome="spawn"} 1',
    );
    expect(body).toContain(
      'torana_agent_api_side_session_acquire_duration_ms_count{bot_id="bot1",outcome="reuse"} 1',
    );
  });

  test("busy acquire records acquire(busy) without a spawn", async () => {
    const runner = new FakeRunner("bot1");
    const metrics = new Metrics(configFor(4, 8));
    const pool = new SideSessionPool({
      config: configFor(4, 8),
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
      metrics,
    });
    await pool.acquire("bot1", "sess-1");
    // Don't release.
    const second = await pool.acquire("bot1", "sess-1");
    expect(second.kind).toBe("busy");

    const body = metrics.renderPrometheus({ bot1: 2 });
    expect(body).toContain(
      'torana_agent_api_side_session_acquire_duration_ms_count{bot_id="bot1",outcome="busy"} 1',
    );
    expect(
      metrics.agentApiSnapshot().bot1.counters.side_sessions_started_total,
    ).toBe(1);
  });

  test("capacity rejection records acquire(capacity) + capacity_rejected counter", async () => {
    const runner = new FakeRunner("bot1");
    const metrics = new Metrics(configFor(1, 1));
    const pool = new SideSessionPool({
      config: configFor(1, 1),
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
      metrics,
    });
    await pool.acquire("bot1", "sess-1");
    // Cap = 1 and the first is in-flight → second acquire on a different id → capacity.
    const second = await pool.acquire("bot1", "sess-2");
    expect(second.kind).toBe("capacity");

    const counters = metrics.agentApiSnapshot().bot1.counters;
    expect(counters.side_session_capacity_rejected_total).toBe(1);
    const body = metrics.renderPrometheus({ bot1: 2 });
    expect(body).toContain(
      'torana_agent_api_side_session_acquire_duration_ms_count{bot_id="bot1",outcome="capacity"} 1',
    );
  });

  test("LRU eviction on cap-full spawn records side_session_evictions_lru", async () => {
    const runner = new FakeRunner("bot1");
    const metrics = new Metrics(configFor(1, 8));
    const pool = new SideSessionPool({
      config: configFor(1, 8),
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
      metrics,
    });
    await pool.acquire("bot1", "sess-1");
    pool.release("bot1", "sess-1");
    // Per-bot cap of 1 → acquiring sess-2 should evict sess-1 (idle, LRU).
    const second = await pool.acquire("bot1", "sess-2");
    expect(second.kind).toBe("ok");

    expect(
      metrics.agentApiSnapshot().bot1.counters.side_session_evictions_lru,
    ).toBe(1);
  });

  test("idle TTL sweep records side_session_evictions_idle + drops live gauge", async () => {
    const runner = new FakeRunner("bot1");
    const metrics = new Metrics(configFor(4, 8));
    let now = 1_000_000;
    const cfg = configFor(4, 8);
    cfg.agent_api.side_sessions.idle_ttl_ms = 1_000;
    cfg.agent_api.side_sessions.hard_ttl_ms = 600_000;
    const pool = new SideSessionPool({
      config: cfg,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
      metrics,
      clock: () => now,
    });
    await pool.acquire("bot1", "sess-1");
    pool.release("bot1", "sess-1");
    now += 2_000; // past idle TTL
    // Directly invoke sweep via private — exposed through publicly-started sweeper
    // would need timers. Call through reflection.
    (pool as unknown as { sweep: () => void }).sweep();
    // Let the async scheduleStop complete.
    await new Promise((r) => setTimeout(r, 20));

    expect(
      metrics.agentApiSnapshot().bot1.counters.side_session_evictions_idle,
    ).toBe(1);
    const body = metrics.renderPrometheus({ bot1: 2 });
    expect(body).toContain(
      'torana_agent_api_side_sessions_live{bot_id="bot1"} 0',
    );
  });

  test("hard TTL with inflight=0 records side_session_evictions_hard", async () => {
    const runner = new FakeRunner("bot1");
    const metrics = new Metrics(configFor(4, 8));
    let now = 1_000_000;
    const cfg = configFor(4, 8);
    cfg.agent_api.side_sessions.idle_ttl_ms = 60_000;
    cfg.agent_api.side_sessions.hard_ttl_ms = 5_000;
    const pool = new SideSessionPool({
      config: cfg,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
      metrics,
      clock: () => now,
    });
    await pool.acquire("bot1", "sess-1");
    pool.release("bot1", "sess-1");
    now += 10_000; // past hard TTL
    (pool as unknown as { sweep: () => void }).sweep();
    await new Promise((r) => setTimeout(r, 20));

    expect(
      metrics.agentApiSnapshot().bot1.counters.side_session_evictions_hard,
    ).toBe(1);
  });

  test("hard TTL with inflight>0 records hard eviction but defers teardown", async () => {
    const runner = new FakeRunner("bot1");
    const metrics = new Metrics(configFor(4, 8));
    let now = 1_000_000;
    const cfg = configFor(4, 8);
    cfg.agent_api.side_sessions.idle_ttl_ms = 60_000;
    cfg.agent_api.side_sessions.hard_ttl_ms = 5_000;
    const pool = new SideSessionPool({
      config: cfg,
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
      metrics,
      clock: () => now,
    });
    await pool.acquire("bot1", "sess-1");
    // No release — inflight stays 1.
    now += 10_000;
    (pool as unknown as { sweep: () => void }).sweep();

    // Hard-eviction counter bumps immediately even though teardown is deferred.
    expect(
      metrics.agentApiSnapshot().bot1.counters.side_session_evictions_hard,
    ).toBe(1);
    // Gauge should already reflect that stopping entries are no longer live.
    const body = metrics.renderPrometheus({ bot1: 2 });
    expect(body).toContain(
      'torana_agent_api_side_sessions_live{bot_id="bot1"} 0',
    );
  });

  test("no metrics option → pool works, nothing is recorded", async () => {
    const runner = new FakeRunner("bot1");
    const pool = new SideSessionPool({
      config: configFor(4, 8),
      db,
      registry: fakeRegistry(new Map([["bot1", runner]])) as never,
      // metrics omitted
    });
    const r = await pool.acquire("bot1", null);
    expect(r.kind).toBe("ok");
    pool.release("bot1", (r as { sessionId: string }).sessionId);
  });
});
