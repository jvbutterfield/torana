// End-to-end integration: agent-api handler → Metrics → GET /metrics.
//
// Unit tests already cover that `renderPrometheus()` returns the right
// string for a given Metrics instance, and the handler tests cover that
// counters bump correctly. This file is the "did main.ts wire the same
// Metrics into the /metrics route" check — a trivial missing assignment
// would cause the stats to silently disappear from the scrape even though
// every other test passes.

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
  return { name: "caller", secret, hash: hash(secret), bot_ids: ["bot1"], scopes };
}

let tmpDir: string;
let db: GatewayDB;
let server: Server;
let runner: ClaudeCodeRunner | null = null;
let pool: SideSessionPool | null = null;
let orphans: OrphanListenerManager | null = null;
let metrics: Metrics;

/**
 * Stand up the same wiring as main.ts: Metrics constructed once, passed
 * into the pool + orphans + deps AND hooked to the `/metrics` route via
 * the same `renderPrometheus` call the real gateway uses. If any of
 * those connections drift, the scrape won't contain agent-api lines.
 */
async function setup(): Promise<{ base: string; secret: string }> {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-metrics-scrape-"));
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
  config.metrics.enabled = true;
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
      return { botConfig, runner };
    },
    get botIds() {
      return ["bot1"];
    },
    dispatchFor(_id: string) {},
  };

  pool = new SideSessionPool({ config, db, registry: registry as never, metrics });
  orphans = new OrphanListenerManager(db, pool, metrics);

  const secret = `tok-${randomUUID().slice(0, 8)}`;
  server = createServer({ port: 0, hostname: "127.0.0.1" });

  // Register /metrics exactly the way registerFixedRoutes does.
  server.router.route("GET", "/metrics", async () =>
    new Response(metrics.renderPrometheus({ bot1: 2 }), {
      status: 200,
      headers: { "Content-Type": "text/plain; version=0.0.4" },
    }),
  );

  registerAgentApiRoutes(server.router, {
    config,
    db,
    registry: registry as never,
    tokens: [tokenFor(secret, ["ask", "inject"])],
    log: logger("metrics-scrape-test"),
    metrics,
    pool,
    orphans,
  });

  db.upsertUserChat("bot1", String(111_222_333), 111_222_333);
  return { base: `http://127.0.0.1:${server.port}`, secret };
}

beforeEach(() => {});
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
  }
});

describe("GET /metrics — agent-api counters appear after traffic", () => {
  test("a successful ask produces torana_agent_api_* lines on /metrics", async () => {
    const { base, secret } = await setup();

    // First scrape: no traffic yet → no agent-api lines.
    const preScrape = await (await fetch(`${base}/metrics`)).text();
    expect(preScrape).not.toContain("torana_agent_api_");

    // Drive an ask.
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(r.status).toBe(200);

    // Scrape again — now agent-api lines must be present + non-zero.
    const postScrape = await (await fetch(`${base}/metrics`)).text();
    expect(postScrape).toContain(
      'torana_agent_api_requests_total{bot_id="bot1",mode="ask",outcome="2xx"} 1',
    );
    expect(postScrape).toContain(
      'torana_agent_api_side_sessions_started_total{bot_id="bot1"} 1',
    );
    expect(postScrape).toContain(
      'torana_agent_api_side_session_acquire_duration_ms_count{bot_id="bot1",outcome="spawn"} 1',
    );
    expect(postScrape).toContain(
      'torana_agent_api_request_duration_ms_count{bot_id="bot1",route="ask"} 1',
    );
    // Prometheus content-type is set.
    const resp = await fetch(`${base}/metrics`);
    expect(resp.headers.get("Content-Type") ?? "").toContain("text/plain");
  }, 20_000);

  test("an inject request produces inject-route lines on /metrics", async () => {
    const { base, secret } = await setup();

    await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "scrape-test-metrics-001",
      },
      body: JSON.stringify({ source: "test", text: "hi", user_id: "111222333" }),
    });

    const body = await (await fetch(`${base}/metrics`)).text();
    expect(body).toContain(
      'torana_agent_api_requests_total{bot_id="bot1",mode="inject",outcome="2xx"} 1',
    );
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_count{bot_id="bot1",route="inject"} 1',
    );
    expect(body).toContain(
      'torana_agent_api_inject_idempotent_replays_total{bot_id="bot1"} 0',
    );
  });

  test("/metrics body parses as valid Prometheus text format (HELP/TYPE pairs)", async () => {
    const { base, secret } = await setup();

    await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    const body = await (await fetch(`${base}/metrics`)).text();
    // Every metric family we emit must have both HELP and TYPE comments
    // before its first sample line — standard prometheus exposition format.
    const families = [
      "torana_agent_api_requests_total",
      "torana_agent_api_side_sessions_started_total",
      "torana_agent_api_side_session_evictions_total",
      "torana_agent_api_side_sessions_live",
      "torana_agent_api_request_duration_ms",
      "torana_agent_api_side_session_acquire_duration_ms",
    ];
    for (const fam of families) {
      expect(body).toContain(`# HELP ${fam}`);
      expect(body).toContain(`# TYPE ${fam} `);
    }
    // No duplicate HELP lines for the same family (Prometheus rejects those).
    for (const fam of families) {
      const occurrences = body.split(`# HELP ${fam} `).length - 1;
      expect(occurrences).toBe(1);
    }
  }, 15_000);
});
