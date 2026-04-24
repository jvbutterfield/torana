// End-to-end ask round-trip with CodexRunner — parallel coverage to
// test/agent-api/ask.test.ts which uses ClaudeCodeRunner. Same plumbing,
// different runner: validates the SideSessionPool + handleAsk + Codex
// per-turn-spawn path together.

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
import { CodexRunner } from "../../src/runner/codex.js";
import { logger } from "../../src/log.js";
import type { ResolvedAgentApiToken } from "../../src/config/load.js";
import type { Config } from "../../src/config/schema.js";
import { makeTestConfig, makeTestBotConfig } from "../fixtures/bots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(__dirname, "../runner/fixtures/codex-mock.ts");
const TEST_PROTOCOL_FLAGS = ["run", MOCK];

function hash(s: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(s, "utf8").digest());
}

let tmpDir: string;
let db: GatewayDB;
let server: Server;
let runner: CodexRunner | null = null;
let pool: SideSessionPool | null = null;
let orphans: OrphanListenerManager | null = null;

async function setup(
  tokens: ResolvedAgentApiToken[],
  opts: { mockMode?: string } = {},
): Promise<{ base: string; config: Config }> {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-ask-codex-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);

  const bot = makeTestBotConfig("bot1", {
    runner: {
      type: "codex" as const,
      cli_path: "bun",
      args: [opts.mockMode ?? "normal"],
      env: {},
      pass_resume_flag: true,
      approval_mode: "full-auto" as const,
      sandbox: "workspace-write" as const,
      acknowledge_dangerous: false,
    },
  });
  const config = makeTestConfig([bot]);
  config.agent_api.enabled = true;

  runner = new CodexRunner({
    botId: "bot1",
    config: bot.runner as Extract<typeof bot.runner, { type: "codex" }>,
    logDir: tmpDir,
    protocolFlags: TEST_PROTOCOL_FLAGS,
  });
  await runner.start();

  const registry = {
    bot(id: string) {
      if (id !== "bot1") return undefined;
      return {
        botConfig: { id: "bot1", runner: { type: "codex" } },
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
    log: logger("ask-codex-test"),
    pool,
    orphans,
  });
  return { base: `http://127.0.0.1:${server.port}`, config };
}

afterEach(async () => {
  try {
    if (orphans) orphans.shutdown();
    if (pool) await pool.shutdown(2000);
    if (server) await server.stop();
    if (runner) await runner.stop(2000);
  } finally {
    if (db) db.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    runner = null;
    pool = null;
    orphans = null;
  }
});

beforeEach(() => {
  /* per-test setup */
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

describe("POST /v1/bots/:id/ask — Codex runner", () => {
  test("ephemeral ask returns text from Codex's per-turn spawn", async () => {
    const secret = "tok-codex-ephemeral-12345";
    const { base } = await setup([tokenFor(secret, ["ask"])]);

    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hello-codex" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      text: string;
      turn_id: number;
      session_id: string;
    };
    expect(body.text).toBe("echo: hello-codex");
    expect(body.session_id).toMatch(/^eph-/);
    expect(body.turn_id).toBeGreaterThan(0);
  }, 20_000);

  test("keyed session reuses entry; subprocess respawns per turn but threadId is reused", async () => {
    const secret = "tok-codex-keyed-1234567";
    const { base } = await setup([tokenFor(secret, ["ask"])], {
      mockMode: "replay-resume",
    });

    const one = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "first", session_id: "demo-codex" }),
    });
    expect(one.status).toBe(200);
    const oneBody = (await one.json()) as { text: string };
    expect(oneBody.text).toBe("replay: first");

    const two = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "second", session_id: "demo-codex" }),
    });
    expect(two.status).toBe(200);
    const twoBody = (await two.json()) as { text: string };
    expect(twoBody.text).toBe("replay: second");

    // Pool kept the same keyed session across two turns.
    expect(pool!.listForBot("bot1").length).toBe(1);

    // Per-side-session log captured TWO `thread.started` lines: the first
    // without resume, the second with `resume tid-replay`.
    const logPath = resolve(tmpDir, "bot1.side.demo-codex.log");
    const content = await Bun.file(logPath).text();
    const lines = content
      .split("\n")
      .filter((l) => l.includes('"thread.started"'))
      .map((l) => JSON.parse(l) as { __resuming?: boolean; __argv?: string[] });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]!.__resuming).toBe(false);
    expect(lines[1]!.__resuming).toBe(true);
    expect(lines[1]!.__argv?.join(" ")).toContain("resume tid-replay");
  }, 25_000);

  test("two concurrent asks on same session_id → [200, 429] side_session_busy", async () => {
    // slow-echo gives each turn a 500ms in-flight window.
    const secret = "tok-codex-busy-1234567";
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
  }, 20_000);

  test("turn-failed → 500 runner_error (codex emits turn.failed)", async () => {
    const secret = "tok-codex-turn-fail-123";
    const { base } = await setup([tokenFor(secret, ["ask"])], {
      mockMode: "turn-failed",
    });

    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "x" }),
    });
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string; message?: string };
    expect(body.error).toBe("runner_error");
    expect(body.message).toContain("model refused");
  }, 20_000);

  test("auth failure → 503 runner_fatal", async () => {
    const secret = "tok-codex-auth-fail-123";
    const { base } = await setup([tokenFor(secret, ["ask"])], {
      mockMode: "auth-fail",
    });

    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "x" }),
    });
    expect(r.status).toBe(503);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("runner_fatal");
  }, 20_000);

  test("GET /v1/turns/:id after Codex ask returns the cached text", async () => {
    const secret = "tok-codex-get-turn-1234";
    const { base } = await setup([tokenFor(secret, ["ask"])]);

    const askRes = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "cached" }),
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
    expect(turnBody.text).toBe("echo: cached");
  }, 20_000);
});
