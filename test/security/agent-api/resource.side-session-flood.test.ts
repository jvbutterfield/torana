// §12.5.4: if a malicious caller spams acquire() with thousands of
// unique session_ids the pool must cap at the configured per-bot
// limit and either evict idle entries (LRU) or return {kind:"capacity"}
// — never unbounded-spawn.
//
// This is a pool-level test with a fake runner; the comprehensive
// coverage for caps/LRU semantics lives in test/agent-api/pool.test.ts.
// Here we specifically attack the invariant "no matter how many
// unique keys a caller spams, the live count stays ≤ max_global".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../../../src/db/migrate.js";
import { GatewayDB } from "../../../src/db/gateway-db.js";
import { SideSessionPool } from "../../../src/agent-api/pool.js";
import { makeTestConfig, makeTestBotConfig } from "../../fixtures/bots.js";
import type { Config } from "../../../src/config/schema.js";

class FakeRunner {
  readonly sessions = new Set<string>();
  async startSideSession(id: string): Promise<void> {
    this.sessions.add(id);
  }
  async stopSideSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }
  supportsSideSessions(): boolean {
    return true;
  }
}

function fakeRegistry(runner: FakeRunner): {
  bot(id: string): { runner: FakeRunner } | undefined;
  botIds: string[];
} {
  return {
    bot(id: string) {
      return id === "bot1" ? { runner } : undefined;
    },
    get botIds() {
      return ["bot1"];
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
  tmpDir = mkdtempSync(join(tmpdir(), "torana-sec-flood-"));
  applyMigrations(join(tmpDir, "gateway.db"));
  db = new GatewayDB(join(tmpDir, "gateway.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("§12.5.4 resource.side-session-flood", () => {
  test("1000 unique session_ids against max_per_bot=4/max_global=8 → live count ≤ 8, spawns bounded", async () => {
    const runner = new FakeRunner();
    const config = configForCaps(4, 8);
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(runner) as never,
    });

    let maxLiveObserved = 0;
    let successes = 0;
    let capacity = 0;

    for (let i = 0; i < 1000; i += 1) {
      const r = await pool.acquire("bot1", `flood-${i}`);
      // Track the runner's current live set size — this is the true
      // security property: no unbounded subprocess spawn.
      if (runner.sessions.size > maxLiveObserved) {
        maxLiveObserved = runner.sessions.size;
      }
      if (r.kind === "ok") {
        successes += 1;
        // Release immediately so idle LRU can evict before the next acquire.
        await pool.release("bot1", r.sessionId);
      } else if (r.kind === "capacity") {
        capacity += 1;
      }
    }

    // Live count during the flood stays under the global cap.
    expect(maxLiveObserved).toBeLessThanOrEqual(8);

    // At least some calls succeeded (cap is not 0) — sanity check.
    expect(successes).toBeGreaterThan(0);

    // After the flood, at most max_global are still live.
    expect(runner.sessions.size).toBeLessThanOrEqual(8);

    // Together we spammed 1000 unique keys: either each got an ok
    // (with eviction) or a capacity rejection. Every call was
    // accounted for — no "ok but no spawn" fantasy.
    expect(successes + capacity).toBe(1000);

    await pool.shutdown(100);
  });

  test("after shutdown, a flood of acquires all return gateway_shutting_down (no spawn)", async () => {
    const runner = new FakeRunner();
    const config = configForCaps(4, 8);
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(runner) as never,
    });

    await pool.shutdown(100);

    let gone = 0;
    for (let i = 0; i < 500; i += 1) {
      const r = await pool.acquire("bot1", `post-shut-${i}`);
      if (r.kind === "gateway_shutting_down") gone += 1;
    }
    expect(gone).toBe(500);
    expect(runner.sessions.size).toBe(0);
  });

  test("unique-key flood without release: live count hits per-bot cap, then capacity", async () => {
    // Worst case — caller never releases. Once the pool is full and
    // no entry is idle (all have inflight>0), the next acquires must
    // return capacity, not crash or spawn extra.
    const runner = new FakeRunner();
    const config = configForCaps(4, 8);
    const pool = new SideSessionPool({
      config,
      db,
      registry: fakeRegistry(runner) as never,
    });

    const acquired: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const r = await pool.acquire("bot1", `hold-${i}`);
      if (r.kind === "ok") acquired.push(r.sessionId);
    }

    // Exactly max_per_bot entries held; everything beyond is capacity.
    expect(acquired.length).toBe(4);
    expect(runner.sessions.size).toBe(4);

    for (const id of acquired) await pool.release("bot1", id);
    await pool.shutdown(100);
  });
});
