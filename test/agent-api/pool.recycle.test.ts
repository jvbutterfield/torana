// US-033 — `recycleForBot`, the apply mechanism for instruction changes (Q1).
//
// The claim being tested is the one an operator has to trust: a turn in flight
// when instructions change finishes under the instructions it started with,
// and every turn after that runs under the new ones. Torana owns the runner
// and instructions reach it at spawn, so applying them means controlling the
// *next* spawn — never signalling a process mid-turn.
//
// The failure this guards against is the tempting shortcut: stopping every
// session immediately. That would apply instructions faster and kill whatever
// the agent was in the middle of saying.

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
  readonly stopped: string[] = [];
  constructor(readonly botId: string) {}
  supportsSideSessions(): boolean {
    return true;
  }
  startSideSession = async (_id: string): Promise<void> => {};
  stopSideSession = async (id: string): Promise<void> => {
    this.stopped.push(id);
  };
}

function fakeRegistry(runners: Map<string, FakeRunner>) {
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

function configFor(bots: string[]): Config {
  const cfg = makeTestConfig(bots.map((id) => makeTestBotConfig(id)));
  cfg.agent_api.enabled = true;
  cfg.agent_api.side_sessions = {
    idle_ttl_ms: 60_000,
    hard_ttl_ms: 600_000,
    max_per_bot: 4,
    max_global: 16,
    max_per_token_default: 8,
  };
  return cfg;
}

let tmpDir: string;
let db: GatewayDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-pool-recycle-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makePool(bots: string[] = ["bot1"]) {
  const runners = new Map(bots.map((id) => [id, new FakeRunner(id)]));
  const config = configFor(bots);
  const pool = new SideSessionPool({
    config,
    db,
    registry: fakeRegistry(runners) as never,
    metrics: new Metrics(config),
  });
  return { pool, runners };
}

describe("recycleForBot", () => {
  test("an idle session is stopped immediately", async () => {
    // A *named* session: `acquire(bot, null)` mints an ephemeral one, which
    // self-destructs on release and so is never what recycling targets.
    const { pool } = makePool();
    const acquired = await pool.acquire("bot1", "session-a");
    expect(acquired.kind).toBe("ok");
    const sessionId = (acquired as { sessionId: string }).sessionId;
    pool.release("bot1", sessionId);

    expect(pool.recycleForBot("bot1", "test")).toBe(1);
    await Bun.sleep(20);
    expect(pool.listForBot("bot1")).toHaveLength(0);
  });

  test("a busy session is marked stopping but not torn down", async () => {
    // The heart of it: the turn keeps its process.
    const { pool, runners } = makePool();
    const acquired = await pool.acquire("bot1", "session-a");
    const sessionId = (acquired as { sessionId: string }).sessionId;
    // Do NOT release: the turn is in flight.

    expect(pool.recycleForBot("bot1", "test")).toBe(1);
    await Bun.sleep(20);

    const entries = pool.listForBot("bot1");
    expect(entries).toHaveLength(1);
    expect(entries[0].state).toBe("stopping");
    expect(entries[0].inflight).toBe(1);
    // Nothing was stopped while the turn was running.
    expect(runners.get("bot1")!.stopped).toEqual([]);
    expect(sessionId).toBeDefined();
  });

  test("the busy session is torn down once its turn completes", async () => {
    const { pool, runners } = makePool();
    const acquired = await pool.acquire("bot1", "session-a");
    const sessionId = (acquired as { sessionId: string }).sessionId;
    pool.recycleForBot("bot1", "test");

    pool.release("bot1", sessionId);
    await Bun.sleep(20);

    expect(pool.listForBot("bot1")).toHaveLength(0);
    expect(runners.get("bot1")!.stopped).toContain(sessionId);
  });

  test("the doomed process is never handed to a new turn", async () => {
    // The mechanism by which new instructions take effect. While the old
    // process is still finishing its turn, the same conversation cannot be
    // handed a second one — that is `busy`, not a fresh spawn. Once the turn
    // ends and the process is torn down, the next turn spawns cleanly, and by
    // then the registry has already been re-registered from the new
    // projection.
    const { pool, runners } = makePool();
    const first = await pool.acquire("bot1", "session-a");
    const firstId = (first as { sessionId: string }).sessionId;
    pool.recycleForBot("bot1", "test");

    // Still in flight: the caller waits rather than racing the doomed process.
    const during = await pool.acquire("bot1", "session-a");
    expect(during.kind).toBe("busy");

    pool.release("bot1", firstId);
    await Bun.sleep(20);
    expect(runners.get("bot1")!.stopped).toContain(firstId);

    const after = await pool.acquire("bot1", "session-a");
    expect(after.kind).toBe("ok");
  });

  test("recycling one agent leaves another agent's sessions alone", async () => {
    // An instruction change is per agent; a fleet-wide recycle would be a
    // serious over-reach on a gateway hosting several.
    const { pool } = makePool(["bot1", "bot2"]);
    const other = await pool.acquire("bot2", "session-b");
    pool.release("bot2", (other as { sessionId: string }).sessionId);
    await pool.acquire("bot1", "session-a");

    expect(pool.recycleForBot("bot1", "test")).toBe(1);
    await Bun.sleep(20);
    expect(pool.listForBot("bot2")).toHaveLength(1);
  });

  test("recycling an agent with no sessions is a no-op returning zero", async () => {
    const { pool } = makePool();
    expect(pool.recycleForBot("bot1", "test")).toBe(0);
  });

  test("recycling twice does not double-count an already-stopping session", async () => {
    // A reconcile storm must not inflate the audited recycle count.
    const { pool } = makePool();
    const acquired = await pool.acquire("bot1", "session-a");
    expect(pool.recycleForBot("bot1", "first")).toBe(1);
    expect(pool.recycleForBot("bot1", "second")).toBe(0);
    pool.release("bot1", (acquired as { sessionId: string }).sessionId);
  });

  test("every session of a busy agent is recycled, not just the first", async () => {
    const { pool } = makePool();
    const a = await pool.acquire("bot1", "session-a");
    pool.release("bot1", (a as { sessionId: string }).sessionId);
    const b = await pool.acquire("bot1", "session-b");
    pool.release("bot1", (b as { sessionId: string }).sessionId);
    expect(pool.listForBot("bot1").length).toBeGreaterThanOrEqual(2);

    const recycled = pool.recycleForBot("bot1", "test");
    expect(recycled).toBeGreaterThanOrEqual(2);
    await Bun.sleep(20);
    expect(pool.listForBot("bot1")).toHaveLength(0);
  });
});
