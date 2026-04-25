// End-to-end ask round-trip — real HTTP server + real ClaudeCodeRunner
// spawning the mock claude fixture. Covers the happy path and the main
// failure modes (capacity, fatal, invalid body, runner-not-supported).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer, type Server } from "../../src/server.js";
import {
  registerAgentApiHealthRoute,
  registerAgentApiRoutes,
} from "../../src/agent-api/router.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { SideSessionPool } from "../../src/agent-api/pool.js";
import { OrphanListenerManager } from "../../src/agent-api/orphan-listeners.js";
import { ClaudeCodeRunner } from "../../src/runner/claude-code.js";
import { logger } from "../../src/log.js";
import type { ResolvedAgentApiToken } from "../../src/config/load.js";
import type { Config } from "../../src/config/schema.js";
import { makeTestConfig, makeTestBotConfig } from "../fixtures/bots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(__dirname, "../runner/fixtures/claude-mock.ts");

function hash(s: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(s, "utf8").digest());
}

let tmpDir: string;
let db: GatewayDB;
let server: Server;
let runner: ClaudeCodeRunner | null = null;
let pool: SideSessionPool | null = null;
let orphans: OrphanListenerManager | null = null;

async function setup(
  tokens: ResolvedAgentApiToken[],
  opts: { mockMode?: string; maxPerBot?: number } = {},
): Promise<{ base: string; config: Config }> {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-ask-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);

  const bot = makeTestBotConfig("bot1", {
    runner: {
      type: "claude-code" as const,
      cli_path: "bun",
      args: ["run", MOCK, opts.mockMode ?? "normal"],
      env: {},
      pass_continue_flag: false,
      acknowledge_dangerous: true,
    },
  });
  const config = makeTestConfig([bot]);
  config.agent_api.enabled = true;
  if (opts.maxPerBot !== undefined) {
    config.agent_api.side_sessions.max_per_bot = opts.maxPerBot;
  }

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
      return {
        botConfig: { id: "bot1", runner: { type: "claude-code" } },
        runner,
      };
    },
    get botIds() {
      return ["bot1"];
    },
  };

  pool = new SideSessionPool({
    config,
    db,
    registry: registry as never,
    sweepIntervalMs: 60_000,
  });
  orphans = new OrphanListenerManager(db, pool);

  server = createServer({ port: 0, hostname: "127.0.0.1" });
  registerAgentApiHealthRoute(server.router, {
    config,
    uptimeSecs: () => 1,
  });
  registerAgentApiRoutes(server.router, {
    config,
    db,
    registry: registry as never,
    tokens,
    log: logger("ask-test"),
    pool,
    orphans,
  });
  return { base: `http://127.0.0.1:${server.port}`, config };
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
  }
});

function tokenFor(
  secret: string,
  scopes: ("ask" | "send")[],
): ResolvedAgentApiToken {
  return {
    name: "caller",
    secret,
    hash: hash(secret),
    bot_ids: ["bot1"],
    scopes,
  };
}

describe("POST /v1/bots/:id/ask — happy path", () => {
  test("ephemeral ask returns text from the runner", async () => {
    const secret = "tok-happy-path-12345";
    const { base } = await setup([tokenFor(secret, ["ask"])]);
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      text: string;
      turn_id: number;
      session_id: string;
    };
    expect(body.text).toBe("echo: hello");
    expect(body.session_id).toMatch(/^eph-/);
    expect(body.turn_id).toBeGreaterThan(0);
  }, 15_000);

  test("keyed session reuses subprocess across two asks", async () => {
    const secret = "tok-reuse-12345678";
    const { base } = await setup([tokenFor(secret, ["ask"])]);
    const one = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "first", session_id: "demo-s1" }),
    });
    expect(one.status).toBe(200);
    const two = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "second", session_id: "demo-s1" }),
    });
    expect(two.status).toBe(200);
    const pooled = pool!.listForBot("bot1");
    expect(pooled.length).toBe(1); // reused same session
  }, 15_000);
});

describe("POST /v1/bots/:id/ask — body size cap", () => {
  test("Content-Length > max_body_bytes → 413 body_too_large (early reject)", async () => {
    const secret = "tok-body-cap-declared-12345-abcde";
    const { base, config } = await setup([tokenFor(secret, ["ask"])]);
    // Clamp the cap so we can test it without sending 100 MB.
    config.agent_api.ask.max_body_bytes = 1024;
    const huge = JSON.stringify({ text: "x".repeat(2048) });
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: huge,
    });
    expect(r.status).toBe(413);
    expect((await r.json()).error).toBe("body_too_large");
  });

  test("chunked body over cap is aborted mid-stream → 413", async () => {
    // A chunked transfer hides Content-Length; the stream reader must track
    // bytes and abort as soon as the cap is exceeded. Uses a ReadableStream
    // so Bun's fetch emits chunked encoding.
    const secret = "tok-body-cap-streamed-12345-abcde";
    const { base, config } = await setup([tokenFor(secret, ["ask"])]);
    config.agent_api.ask.max_body_bytes = 512;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Emit ~2 KB across several chunks with a tiny delay so the
        // server sees multiple reads — the streaming abort is what we're
        // exercising, not the header precheck.
        const chunk = new Uint8Array(256).fill(0x61);
        for (let i = 0; i < 8; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: stream,
    });
    expect(r.status).toBe(413);
    expect((await r.json()).error).toBe("body_too_large");
  });
});

describe("POST /v1/bots/:id/ask — error paths", () => {
  test("invalid body → 400", async () => {
    const secret = "tok-invalid-body-123";
    const { base } = await setup([tokenFor(secret, ["ask"])]);
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_body");
  });

  test("bad session_id regex → 400", async () => {
    const secret = "tok-bad-session-id-1";
    const { base } = await setup([tokenFor(secret, ["ask"])]);
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi", session_id: "has space" }),
    });
    expect(r.status).toBe(400);
  });

  test("runner fatal → 503 runner_fatal", async () => {
    const secret = "tok-fatal-test12345";
    const { base } = await setup([tokenFor(secret, ["ask"])], {
      mockMode: "crash-on-turn",
    });
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("runner_fatal");
  }, 15_000);

  test("same session_id while busy → 429 side_session_busy", async () => {
    const secret = "tok-busy-test123456";
    // slow-echo mode keeps the first ask in-flight for 500ms, guaranteeing
    // the second acquire lands while inflight=1.
    const { base } = await setup([tokenFor(secret, ["ask"])], {
      mockMode: "slow-echo",
    });
    const p1 = fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "first", session_id: "contend" }),
    });
    await new Promise((r) => setTimeout(r, 100));
    const p2 = fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "second", session_id: "contend" }),
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 429]);
    const losing = r1.status === 429 ? r1 : r2;
    expect((await losing.json()).error).toBe("side_session_busy");
  }, 15_000);

  test("GET /v1/turns/:id after completed ask returns text", async () => {
    const secret = "tok-get-turn-test123";
    const { base } = await setup([tokenFor(secret, ["ask"])]);
    const askRes = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(askRes.status).toBe(200);
    const askBody = (await askRes.json()) as { turn_id: number };

    const turnRes = await fetch(`${base}/v1/turns/${askBody.turn_id}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(turnRes.status).toBe(200);
    const turnBody = (await turnRes.json()) as {
      status: string;
      text?: string;
    };
    expect(turnBody.status).toBe("done");
    expect(turnBody.text).toBe("echo: hello");
  }, 15_000);
});
