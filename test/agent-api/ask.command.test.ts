// End-to-end ask round-trip with CommandRunner (Phase 2c, US-007). Parallel
// coverage to test/agent-api/ask.test.ts (Claude) and ask.codex.test.ts
// (Codex). Validates the SideSessionPool + handleAsk + CommandRunner
// integration for each of the three protocols:
//
//   - `claude-ndjson` — side-sessions supported; long-lived per-session
//     subprocess; events routed to side emitters only.
//   - `codex-jsonl`   — side-sessions supported; long-lived per-session
//     subprocess; same event-routing contract.
//   - `jsonl-text`    — side-sessions unsupported; handler returns 501
//     `runner_does_not_support_side_sessions`.

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
import { CommandRunner } from "../../src/runner/command.js";
import { logger } from "../../src/log.js";
import type { ResolvedAgentApiToken } from "../../src/config/load.js";
import type { Config, CommandRunnerConfig } from "../../src/config/schema.js";
import { makeTestConfig, makeTestBotConfig } from "../fixtures/bots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NDJSON_MOCK = resolve(
  __dirname,
  "../runner/fixtures/command-ndjson-mock.ts",
);
const CODEX_MOCK = resolve(
  __dirname,
  "../runner/fixtures/command-codex-mock.ts",
);
// Any executable is fine for jsonl-text (the 501 path rejects before spawn).
const JSONL_MOCK = resolve(
  __dirname,
  "../integration/fixtures/test-runner.ts",
);

function hash(s: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(s, "utf8").digest());
}

let tmpDir: string;
let db: GatewayDB;
let server: Server;
let runner: CommandRunner | null = null;
let pool: SideSessionPool | null = null;
let orphans: OrphanListenerManager | null = null;

interface SetupOpts {
  protocol: "claude-ndjson" | "codex-jsonl" | "jsonl-text";
  mockPath?: string;
  mockMode?: string;
}

async function setup(
  tokens: ResolvedAgentApiToken[],
  opts: SetupOpts,
): Promise<{ base: string; config: Config }> {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-ask-command-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);

  const mockPath =
    opts.mockPath ??
    (opts.protocol === "claude-ndjson"
      ? NDJSON_MOCK
      : opts.protocol === "codex-jsonl"
        ? CODEX_MOCK
        : JSONL_MOCK);

  const runnerConfig: CommandRunnerConfig = {
    type: "command",
    cmd: ["bun", "run", mockPath, opts.mockMode ?? "normal"],
    protocol: opts.protocol,
    env: {},
    on_reset: "signal",
  };

  const bot = makeTestBotConfig("bot1", { runner: runnerConfig });
  const config = makeTestConfig([bot]);
  config.agent_api.enabled = true;

  runner = new CommandRunner({
    botId: "bot1",
    config: runnerConfig,
    logDir: tmpDir,
    sideStartupMs: 500,
  });

  const registry = {
    bot(id: string) {
      if (id !== "bot1") return undefined;
      return {
        botConfig: { id: "bot1", runner: runnerConfig },
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
    log: logger("ask-command-test"),
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
  scopes: ("ask" | "inject")[],
): ResolvedAgentApiToken {
  return {
    name: "caller",
    secret,
    hash: hash(secret),
    bot_ids: ["bot1"],
    scopes,
  };
}

// ---------------------------------------------------------------------------
// Protocol-specific happy-path and failure-mode coverage. Parametrized over
// the two side-session-capable protocols so regressions in either surface.
// ---------------------------------------------------------------------------

for (const protocol of ["claude-ndjson", "codex-jsonl"] as const) {
  describe(`POST /v1/bots/:id/ask — CommandRunner(${protocol})`, () => {
    test("ephemeral ask returns text from the runner", async () => {
      const secret = `tok-${protocol}-ephemeral-1234`;
      const { base } = await setup([tokenFor(secret, ["ask"])], { protocol });

      const r = await fetch(`${base}/v1/bots/bot1/ask`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "hello-command" }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        text: string;
        turn_id: number;
        session_id: string;
      };
      // Ephemeral session id is an `eph-<uuid>`; the mocks stamp that id into
      // the reply text via `TORANA_SESSION_ID` so we can see routing worked.
      expect(body.session_id).toMatch(/^eph-/);
      expect(body.turn_id).toBeGreaterThan(0);
      expect(body.text).toContain("hello-command");
      // Mock stamp — proves the side subprocess saw `TORANA_SESSION_ID=<eph id>`.
      expect(body.text).toContain(`[${body.session_id}]`);
    }, 20_000);

    test("keyed session: pool keeps one entry across two turns", async () => {
      const secret = `tok-${protocol}-keyed-12345678`;
      const { base } = await setup([tokenFor(secret, ["ask"])], { protocol });

      const one = await fetch(`${base}/v1/bots/bot1/ask`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "first", session_id: "demo-cmd" }),
      });
      expect(one.status).toBe(200);
      const oneBody = (await one.json()) as { text: string };
      expect(oneBody.text).toContain("[demo-cmd]");
      expect(oneBody.text).toContain("first");

      const two = await fetch(`${base}/v1/bots/bot1/ask`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "second", session_id: "demo-cmd" }),
      });
      expect(two.status).toBe(200);
      const twoBody = (await two.json()) as { text: string };
      expect(twoBody.text).toContain("[demo-cmd]");
      expect(twoBody.text).toContain("second");

      // Pool kept the same keyed session across both turns.
      expect(pool!.listForBot("bot1").length).toBe(1);
    }, 25_000);

    test("two concurrent asks on same session_id → [200, 429] side_session_busy", async () => {
      const secret = `tok-${protocol}-busy-1234567`;
      // slow-echo gives each turn a 500ms in-flight window.
      const { base } = await setup([tokenFor(secret, ["ask"])], {
        protocol,
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

    test("GET /v1/turns/:id after ask returns the cached text", async () => {
      const secret = `tok-${protocol}-get-turn-12345`;
      const { base } = await setup([tokenFor(secret, ["ask"])], { protocol });

      const askRes = await fetch(`${base}/v1/bots/bot1/ask`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "cached-text" }),
      });
      expect(askRes.status).toBe(200);
      const askBody = (await askRes.json()) as {
        turn_id: number;
        text: string;
      };

      const turnRes = await fetch(`${base}/v1/turns/${askBody.turn_id}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      expect(turnRes.status).toBe(200);
      const turnBody = (await turnRes.json()) as {
        status: string;
        text?: string;
      };
      expect(turnBody.status).toBe("done");
      // Post-turn fetch yields the same text the ask response returned — the
      // handler persists final_text to the turns row.
      expect(turnBody.text).toBe(askBody.text);
    }, 20_000);
  });
}

// ---------------------------------------------------------------------------
// jsonl-text — protocol has no session semantics; the handler short-circuits
// at the `supportsSideSessions()` check with 501.
// ---------------------------------------------------------------------------

describe("POST /v1/bots/:id/ask — CommandRunner(jsonl-text) unsupported", () => {
  test("501 runner_does_not_support_side_sessions", async () => {
    // Doctor C011 would fail before start-up for this config in a real
    // deployment, but an operator running with `--no-doctor` or a
    // misconfigured test can still hit the handler — so the runtime path
    // must also reject cleanly.
    const secret = "tok-jsonl-text-unsupported-1234";
    const { base } = await setup([tokenFor(secret, ["ask"])], {
      protocol: "jsonl-text",
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
  }, 15_000);
});

// ---------------------------------------------------------------------------
// CommandRunner-specific fatal paths: if the side subprocess crashes on first
// turn, the ask handler must surface a 5xx (not hang). Using claude-ndjson
// since both protocols route crash events identically.
// ---------------------------------------------------------------------------

describe("POST /v1/bots/:id/ask — CommandRunner fatal paths", () => {
  test("side subprocess crashes mid-turn → 503 runner_fatal", async () => {
    const secret = "tok-cmd-fatal-crash-12345";
    const { base } = await setup([tokenFor(secret, ["ask"])], {
      protocol: "claude-ndjson",
      mockMode: "crash-on-turn",
    });

    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "boom" }),
    });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("runner_fatal");
  }, 15_000);
});
