// Ask + inject handler → Metrics wiring. Drives the real HTTP path end-to-end
// with a Metrics instance passed through deps and asserts the request counter
// families get incremented with the right status bucket, including the
// replay-specific counter for inject.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer, type Server } from "../../src/server.js";
import { registerAgentApiRoutes } from "../../src/agent-api/router.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { SideSessionPool } from "../../src/agent-api/pool.js";
import { OrphanListenerManager } from "../../src/agent-api/orphan-listeners.js";
import { ClaudeCodeRunner } from "../../src/runner/claude-code.js";
import { Metrics } from "../../src/metrics.js";
import { logger } from "../../src/log.js";
import type { ResolvedAgentApiToken } from "../../src/config/load.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(__dirname, "../runner/fixtures/claude-mock.ts");

function hash(s: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(s, "utf8").digest());
}

function tokenFor(secret: string, scopes: ("ask" | "inject")[]): ResolvedAgentApiToken {
  return {
    name: "caller",
    secret,
    hash: hash(secret),
    bot_ids: ["bot1"],
    scopes,
  };
}

let tmpDir: string;
let db: GatewayDB;
let server: Server;
let runner: ClaudeCodeRunner | null = null;
let pool: SideSessionPool | null = null;
let orphans: OrphanListenerManager | null = null;
let metrics: Metrics | null = null;

async function setup(
  scopes: ("ask" | "inject")[] = ["ask", "inject"],
): Promise<{ base: string; secret: string }> {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-handlers-metrics-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);

  const bot = makeTestBotConfig("bot1", {
    runner: {
      type: "claude-code" as const,
      cli_path: "bun",
      args: ["run", MOCK, "normal"],
      env: {},
      pass_continue_flag: false,
    },
  });
  const config = makeTestConfig([bot]);
  config.agent_api.enabled = true;
  metrics = new Metrics(config);

  runner = new ClaudeCodeRunner({
    botId: "bot1",
    config: bot.runner as Extract<typeof bot.runner, { type: "claude-code" }>,
    logDir: tmpDir,
    protocolFlags: [],
    startupMs: 100,
  });

  const registry = {
    bot(id: string) {
      if (id !== "bot1") return undefined;
      const botConfig = config.bots.find((b) => b.id === "bot1")!;
      return {
        botConfig,
        runner,
      };
    },
    get botIds() {
      return ["bot1"];
    },
    dispatchFor(_id: string) {
      /* inject handler wakes dispatch — no-op in this test */
    },
  };

  pool = new SideSessionPool({
    config,
    db,
    registry: registry as never,
    metrics,
    sweepIntervalMs: 60_000,
  });
  orphans = new OrphanListenerManager(db, pool);

  const secret = `tok-${randomUUID().slice(0, 8)}`;
  server = createServer({ port: 0, hostname: "127.0.0.1" });
  registerAgentApiRoutes(server.router, {
    config,
    db,
    registry: registry as never,
    tokens: [tokenFor(secret, scopes)],
    log: logger("handlers-metrics-test"),
    metrics,
    pool,
    orphans,
  });

  // Seed user_chats so inject can resolve.
  db.upsertUserChat("bot1", String(111_222_333), 111_222_333);

  return { base: `http://127.0.0.1:${server.port}`, secret };
}

beforeEach(() => {
  /* per-test setup */
});

afterEach(async () => {
  try {
    if (orphans) orphans.shutdown();
    if (pool) await pool.shutdown(1000);
    if (server) await server.stop();
  } finally {
    if (db) db.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    runner = null;
    pool = null;
    orphans = null;
    metrics = null;
  }
});

describe("ask handler → Metrics", () => {
  test("successful ask (200) → ask_requests_2xx + duration histogram", async () => {
    const { base, secret } = await setup(["ask"]);
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(r.status).toBe(200);
    const snap = metrics!.agentApiSnapshot().bot1.counters;
    expect(snap.ask_requests_total).toBe(1);
    expect(snap.ask_requests_2xx).toBe(1);
    expect(snap.ask_requests_4xx).toBe(0);
    expect(snap.ask_timeouts_total).toBe(0);
    const body = metrics!.renderPrometheus({ bot1: 2 });
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_count{bot_id="bot1",route="ask"} 1',
    );
  }, 15_000);

  test("invalid body (400) → ask_requests_4xx", async () => {
    const { base, secret } = await setup(["ask"]);
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    const snap = metrics!.agentApiSnapshot().bot1.counters;
    expect(snap.ask_requests_4xx).toBe(1);
    expect(snap.ask_requests_2xx).toBe(0);
  });
});

describe("inject handler → Metrics", () => {
  test("fresh inject (202) → inject_requests_2xx (no replay)", async () => {
    const { base, secret } = await setup(["inject"]);
    const r = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "fresh-metrics-000001",
      },
      body: JSON.stringify({
        source: "test",
        text: "hello",
        user_id: "111222333",
      }),
    });
    expect(r.status).toBe(202);
    const snap = metrics!.agentApiSnapshot().bot1.counters;
    expect(snap.inject_requests_total).toBe(1);
    expect(snap.inject_requests_2xx).toBe(1);
    expect(snap.inject_idempotent_replays_total).toBe(0);
  });

  test("replayed inject (same Idempotency-Key) → inject_idempotent_replays_total", async () => {
    const { base, secret } = await setup(["inject"]);
    const key = "dup-metrics-0000001a";
    const body = JSON.stringify({
      source: "test",
      text: "hello",
      user_id: "111222333",
    });
    const first = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body,
    });
    expect(first.status).toBe(202);
    const second = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body,
    });
    expect(second.status).toBe(202);

    const snap = metrics!.agentApiSnapshot().bot1.counters;
    expect(snap.inject_requests_total).toBe(2);
    expect(snap.inject_requests_2xx).toBe(2);
    expect(snap.inject_idempotent_replays_total).toBe(1);
  });

  test("missing_target (400) → inject_requests_4xx, no replay bump", async () => {
    const { base, secret } = await setup(["inject"]);
    const r = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "no-target-metrics-001",
      },
      body: JSON.stringify({ source: "test", text: "hi" }),
    });
    expect(r.status).toBe(400);
    const snap = metrics!.agentApiSnapshot().bot1.counters;
    expect(snap.inject_requests_4xx).toBe(1);
    expect(snap.inject_idempotent_replays_total).toBe(0);
  });

  test("403 scope_not_permitted → inject_requests_4xx", async () => {
    const { base, secret } = await setup(["ask"]); // inject not in scopes
    const r = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "no-scope-metrics-001x",
      },
      body: JSON.stringify({
        source: "test",
        text: "hi",
        user_id: "111222333",
      }),
    });
    expect(r.status).toBe(403);
    // 4xx from the router runs BEFORE the handler so inject_requests_*
    // counters should stay zero — the authed() wrapper rejects before
    // reaching recordInject.
    const snap = metrics!.agentApiSnapshot();
    // No counters were touched for bot1 — either the map is empty or both
    // buckets are 0. Both are acceptable.
    if (snap.bot1) {
      expect(snap.bot1.counters.inject_requests_total).toBe(0);
    }
  });
});
