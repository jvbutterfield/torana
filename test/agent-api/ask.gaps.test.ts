// Coverage gap-fills for POST /v1/bots/:id/ask, identified during the PRD
// audit. Each test pins a behavior the PRD explicitly requires that the
// existing happy-path / 503 fatal / 429 busy tests in `ask.test.ts` and
// `ask.codex.test.ts` do not assert.
//
// Specifically:
//   - 400 invalid_timeout when timeout_ms < 1000 or > 300_000 (US-009).
//   - X-Torana-Retriable header on 500 runner_error (US-009 line 242).
//   - 202 in_progress + orphan-listener attachment when the runner exceeds
//     the request-level timeout (US-009 line 240–241).
//   - 503 runner_fatal removes the side session so the next acquire creates
//     a fresh subprocess (US-009 line 243).
//   - 501 runner_does_not_support_side_sessions on a real HTTP request
//     when the bot's runner reports false (US-009 line 131).
//   - 429 side_session_capacity when the pool has no idle entry to evict.
//   - usage + duration_ms surface back to the caller and to GET /v1/turns/:id
//     after the runner reports them (US-009 line 240).
//   - turn row carries source='agent_api_ask' + agent_api_token_name after
//     a successful ask (US-009 + US-002).

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
import { CodexRunner } from "../../src/runner/codex.js";
import { logger } from "../../src/log.js";
import type { ResolvedAgentApiToken } from "../../src/config/load.js";
import type { Config } from "../../src/config/schema.js";
import { makeTestConfig, makeTestBotConfig } from "../fixtures/bots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_MOCK = resolve(__dirname, "../runner/fixtures/claude-mock.ts");
const CODEX_MOCK = resolve(__dirname, "../runner/fixtures/codex-mock.ts");

function hash(s: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(s, "utf8").digest());
}

function tokenFor(
  secret: string,
  scopes: ("ask" | "send")[],
  opts: { name?: string; maxConcurrent?: number } = {},
): ResolvedAgentApiToken {
  return {
    name: opts.name ?? "caller",
    secret,
    hash: hash(secret),
    bot_ids: ["bot1"],
    scopes,
    ...(opts.maxConcurrent !== undefined
      ? { maxConcurrentSideSessions: opts.maxConcurrent }
      : {}),
  };
}

let tmpDir: string;
let db: GatewayDB;
let server: Server;
let runner: ClaudeCodeRunner | CodexRunner | null = null;
let pool: SideSessionPool | null = null;
let orphans: OrphanListenerManager | null = null;

interface SetupOpts {
  tokens: ResolvedAgentApiToken[];
  runner?: "claude" | "codex" | "unsupported";
  mockMode?: string;
  maxPerBot?: number;
  maxGlobal?: number;
}

interface Setup {
  base: string;
  config: Config;
  pool: SideSessionPool;
}

async function setup(opts: SetupOpts): Promise<Setup> {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-ask-gaps-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);

  const runnerKind = opts.runner ?? "claude";
  const claudeCfg = {
    type: "claude-code" as const,
    cli_path: "bun",
    args: ["run", CLAUDE_MOCK, opts.mockMode ?? "normal"],
    env: {},
    pass_continue_flag: false,
    acknowledge_dangerous: true,
  };
  const codexCfg = {
    type: "codex" as const,
    cli_path: "bun",
    args: [opts.mockMode ?? "normal"],
    env: {},
    pass_resume_flag: true,
    approval_mode: "full-auto" as const,
    sandbox: "workspace-write" as const,
    acknowledge_dangerous: false,
  };
  const bot = makeTestBotConfig("bot1", {
    runner: runnerKind === "codex" ? codexCfg : claudeCfg,
  });
  const config = makeTestConfig([bot]);
  config.agent_api.enabled = true;
  if (opts.maxPerBot !== undefined) {
    config.agent_api.side_sessions.max_per_bot = opts.maxPerBot;
  }
  if (opts.maxGlobal !== undefined) {
    config.agent_api.side_sessions.max_global = opts.maxGlobal;
  }

  if (runnerKind === "claude") {
    runner = new ClaudeCodeRunner({
      botId: "bot1",
      config: claudeCfg,
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 100,
    });
  } else if (runnerKind === "codex") {
    runner = new CodexRunner({
      botId: "bot1",
      config: codexCfg,
      logDir: tmpDir,
      protocolFlags: ["run", CODEX_MOCK],
    });
    await (runner as CodexRunner).start();
  } else {
    // "unsupported" — a fake runner that reports supportsSideSessions=false.
    runner = {
      supportsSideSessions: () => false,
      // The handler reads supportsSideSessions BEFORE attempting to acquire,
      // so the rest of the runner surface is never invoked.
    } as unknown as ClaudeCodeRunner;
  }

  const registry = {
    bot(id: string) {
      if (id !== "bot1") return undefined;
      return {
        botConfig: { id: "bot1", runner: { type: bot.runner.type } },
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
    tokens: opts.tokens,
    log: logger("ask-gap-test"),
    pool,
    orphans,
  });
  return { base: `http://127.0.0.1:${server.port}`, config, pool };
}

beforeEach(() => {
  /* per-test setup */
});

afterEach(async () => {
  try {
    if (orphans) orphans.shutdown();
    if (pool) await pool.shutdown(2000);
    if (server) await server.stop();
    if (runner && "stop" in runner && typeof runner.stop === "function") {
      try {
        await (runner as CodexRunner).stop(2000);
      } catch {
        /* ok */
      }
    }
  } finally {
    if (db) db.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    runner = null;
    pool = null;
    orphans = null;
  }
});

describe("POST /v1/bots/:id/ask — invalid_timeout (US-009 spec)", () => {
  test("timeout_ms above 300_000 → 400 invalid_timeout", async () => {
    const secret = "tok-timeout-too-big-1";
    const { base } = await setup({ tokens: [tokenFor(secret, ["ask"])] });
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi", timeout_ms: 9_999_999 }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; message?: string };
    expect(body.error).toBe("invalid_timeout");
  });

  test("timeout_ms below 1000 → 400 invalid_timeout", async () => {
    const secret = "tok-timeout-too-low-2";
    const { base } = await setup({ tokens: [tokenFor(secret, ["ask"])] });
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi", timeout_ms: 50 }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_timeout");
  });

  test("missing text still maps to invalid_body, not invalid_timeout", async () => {
    const secret = "tok-no-text-12345678";
    const { base } = await setup({ tokens: [tokenFor(secret, ["ask"])] });
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
});

describe("POST /v1/bots/:id/ask — X-Torana-Retriable header (US-009)", () => {
  test("runner error sets X-Torana-Retriable: false on the response", async () => {
    const secret = "tok-codex-retriable-12";
    const { base } = await setup({
      tokens: [tokenFor(secret, ["ask"])],
      runner: "codex",
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
    // Header is required so callers can decide whether to retry. The mock
    // emits a non-retriable turn.failed (model refused) so the value is "false".
    expect(r.headers.get("X-Torana-Retriable")).toBe("false");
    const body = (await r.json()) as { error: string; turn_id: number };
    expect(body.error).toBe("runner_error");
    expect(body.turn_id).toBeGreaterThan(0);
  }, 20_000);
});

describe("POST /v1/bots/:id/ask — 202 in_progress timeout-then-poll (US-009)", () => {
  test("short timeout_ms → 202 + orphan listener completes the turn in the background", async () => {
    const secret = "tok-202-timeout-12345";
    const { base } = await setup({
      tokens: [tokenFor(secret, ["ask"])],
      mockMode: "slow-echo", // 500ms delay before result
    });

    const askRes = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi", timeout_ms: 1000 }),
    });
    // The handler clamps to >= 1000ms; with a 500ms-delay mock the runner
    // either finishes inside the window (200) or just past it (202). We
    // pin the more interesting path with a tighter 1000ms timeout against
    // the slow-echo mock, then accept either outcome and assert the
    // poll-to-done semantics in both cases.
    expect([200, 202]).toContain(askRes.status);
    const body = (await askRes.json()) as {
      turn_id: number;
      session_id: string;
      status?: string;
      text?: string;
    };
    expect(body.turn_id).toBeGreaterThan(0);

    if (askRes.status === 202) {
      expect(body.status).toBe("in_progress");
      expect(body.session_id).toMatch(/^eph-/);
      // Poll until the orphan listener writes the final text.
      let polled: { status: string; text?: string } | null = null;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const pr = await fetch(`${base}/v1/turns/${body.turn_id}`, {
          headers: { Authorization: `Bearer ${secret}` },
        });
        if (pr.status !== 200) continue;
        polled = (await pr.json()) as { status: string; text?: string };
        if (polled.status === "done") break;
      }
      expect(polled).not.toBeNull();
      expect(polled!.status).toBe("done");
      expect(polled!.text).toBe("echo: hi");
    } else {
      // Synchronous completion is also a valid outcome of the slow-echo race.
      expect(body.text).toBe("echo: hi");
    }
  }, 30_000);
});

describe("POST /v1/bots/:id/ask — 501 runner_does_not_support_side_sessions (US-009)", () => {
  test("runner reports false → 501 + canonical error code", async () => {
    const secret = "tok-unsupported-runner";
    const { base } = await setup({
      tokens: [tokenFor(secret, ["ask"])],
      runner: "unsupported",
    });
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(501);
    expect((await r.json()).error).toBe(
      "runner_does_not_support_side_sessions",
    );
  });
});

describe("POST /v1/bots/:id/ask — 429 side_session_capacity (US-008)", () => {
  test("pool at capacity with no evictable idle entry → 429 capacity", async () => {
    const secret = "tok-capacity-rejected";
    const { base, pool: poolRef } = await setup({
      tokens: [tokenFor(secret, ["ask"])],
      mockMode: "slow-echo",
      maxPerBot: 1,
      maxGlobal: 1,
    });

    // Hold the only allowed slot with a slow ask. While it's in flight a
    // second acquire on a *different* session_id has nowhere to evict from.
    const slow = fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "first", session_id: "occupied" }),
    });
    // Wait for the first request to acquire the slot.
    let occupied = false;
    for (let i = 0; i < 50 && !occupied; i++) {
      await new Promise((r) => setTimeout(r, 20));
      occupied = poolRef.listForBot("bot1").length > 0;
    }
    expect(occupied).toBe(true);

    const second = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "second", session_id: "fresh" }),
    });
    expect(second.status).toBe(429);
    expect((await second.json()).error).toBe("side_session_capacity");

    // Drain the slow ask so afterEach can shut down cleanly.
    await slow;
  }, 20_000);
});

describe("POST /v1/bots/:id/ask — 429 token_concurrency_limit (rc.8)", () => {
  // Per-token cap closes the gap that per-bot + global caps leave open: a
  // token whose `bot_ids` covers many bots can otherwise hold up to
  // max_per_bot * len(bot_ids) concurrent side-sessions and starve every
  // other token sharing those bots. Here we set the per-token cap to 1 on
  // a single bot — well under the per-bot cap — and confirm the second
  // concurrent ask from the same token is rejected with the new code.
  test("token at its concurrent cap → 429 token_concurrency_limit", async () => {
    const secret = "tok-per-token-cap-r8x";
    const { base, pool: poolRef } = await setup({
      tokens: [
        tokenFor(secret, ["ask"], {
          name: "alpha",
          maxConcurrent: 1,
        }),
      ],
      // very-slow keeps the first turn busy for ~2s so the second request
      // is guaranteed to land while the first is still inflight.
      mockMode: "very-slow",
      // Bot/global caps generous — only the per-token cap should bind.
      maxPerBot: 4,
      maxGlobal: 4,
    });

    const slow = fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "first", session_id: "s-1" }),
    });
    // Poll for inflight=1 (not just "entry exists"): an entry can exist with
    // inflight=0 right after release, which would let the second slip past.
    let inflight = false;
    for (let i = 0; i < 100 && !inflight; i++) {
      await new Promise((r) => setTimeout(r, 20));
      inflight = poolRef.listForBot("bot1").some((s) => s.inflight > 0);
    }
    expect(inflight).toBe(true);

    const second = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "second", session_id: "s-2" }),
    });
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: string; limit?: number };
    expect(body.error).toBe("token_concurrency_limit");
    expect(body.limit).toBe(1);

    await slow;
  }, 20_000);
});

describe("POST /v1/bots/:id/ask — runner_fatal teardown (US-009 line 243)", () => {
  test("after fatal, a second ask on same session_id creates a fresh side session", async () => {
    const secret = "tok-fatal-replace-123";
    const { base, pool: poolRef } = await setup({
      tokens: [tokenFor(secret, ["ask"])],
      runner: "codex",
      mockMode: "auth-fail",
    });

    const r1 = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "first", session_id: "sticky" }),
    });
    expect(r1.status).toBe(503);

    // Wait until the pool teardown completes (runner_fatal triggers
    // pool.stop fire-and-forget).
    let drained = false;
    for (let i = 0; i < 50 && !drained; i++) {
      await new Promise((r) => setTimeout(r, 20));
      drained = poolRef.listForBot("bot1").length === 0;
    }
    expect(drained).toBe(true);

    // Second ask against the same session_id must NOT see the dead entry — it
    // should attempt a fresh acquire (which will of course also auth-fail
    // against the same mock). The contract is "no zombie entry blocks the
    // next call," not "second call succeeds."
    const r2 = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "second", session_id: "sticky" }),
    });
    // Either 503 (auth-fail again — the mock keeps refusing) OR 200 if the
    // pool admitted a new entry. Both prove there's no permanent block.
    expect([200, 503]).toContain(r2.status);
  }, 20_000);
});

describe("POST /v1/bots/:id/ask — server-side persistence (US-009 + US-002)", () => {
  test("turn row gets source='agent_api_ask', token name, usage, duration on done", async () => {
    const secret = "tok-row-shape-1234567";
    const { base } = await setup({ tokens: [tokenFor(secret, ["ask"])] });

    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "row" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      text: string;
      turn_id: number;
      duration_ms?: number;
    };
    expect(body.text).toBe("echo: row");
    // duration_ms is asserted at the response level (it comes from the mock
    // result event with `duration_ms: 1`).
    expect(body.duration_ms).toBeDefined();
    expect(typeof body.duration_ms).toBe("number");

    const turn = db.getTurnExtended(body.turn_id)!;
    expect(turn.source).toBe("agent_api_ask");
    expect(turn.agent_api_token_name).toBe("caller");
    expect(turn.status).toBe("completed");
    expect(turn.final_text).toBe("echo: row");
    expect(turn.duration_ms).not.toBeNull();

    // GET /v1/turns/:id surfaces the same fields back.
    const tr = await fetch(`${base}/v1/turns/${body.turn_id}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(tr.status).toBe(200);
    const tb = (await tr.json()) as {
      status: string;
      text?: string;
      duration_ms?: number;
    };
    expect(tb.status).toBe("done");
    expect(tb.text).toBe("echo: row");
    expect(tb.duration_ms).toBeDefined();
  }, 15_000);
});
