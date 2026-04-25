// End-to-end CLI dispatcher tests — spawn `bun run src/cli.ts <subcmd>` as
// a subprocess and let it talk to a real in-process torana gateway. This
// exercises:
//
//   - the dispatcher's argv detection (subcommand routing)
//   - credential resolution from --server / --token (and TORANA_SERVER /
//     TORANA_TOKEN env when flags are omitted)
//   - exit codes (mapped per src/cli/shared/exit.ts)
//   - real HTTP transport (Bun fetch) + multipart construction in the
//     production code path (no fake fetchImpl here)
//
// Mirrors the setup in test/agent-api/ask.test.ts so the same claude-mock
// runner + fake registry are reused. We deliberately don't share helpers
// with that file because the e2e shape is different (subprocess vs in-
// process fetch) and a small amount of duplication is preferable to
// coupling unrelated tests.

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
import { makeTestConfig, makeTestBotConfig } from "../fixtures/bots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(__dirname, "../../src/cli.ts");
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

async function setupGateway(
  tokens: ResolvedAgentApiToken[],
): Promise<{ base: string }> {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-cli-dispatch-"));
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
      acknowledge_dangerous: true,
    },
  });
  const config = makeTestConfig([bot]);
  config.agent_api.enabled = true;

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
    log: logger("cli-dispatch-test"),
    pool,
    orphans,
  });
  return { base: `http://127.0.0.1:${server.port}` };
}

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

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode: exitCode ?? 0 };
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

describe("torana ask — subprocess dispatch", () => {
  test("happy path: returns echoed text on stdout, exit 0", async () => {
    const secret = "tok-cli-ask-happy-12345";
    const { base } = await setupGateway([tokenFor(secret, ["ask"])]);
    const { stdout, stderr, exitCode } = await runCli([
      "ask",
      "bot1",
      "hello",
      "--server",
      base,
      "--token",
      secret,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("echo: hello");
    expect(stderr).toBe("");
  }, 20_000);

  test("env vars (TORANA_SERVER + TORANA_TOKEN) work without flags", async () => {
    const secret = "tok-cli-ask-env-1234567";
    const { base } = await setupGateway([tokenFor(secret, ["ask"])]);
    const { stdout, exitCode } = await runCli(["ask", "bot1", "via env"], {
      TORANA_SERVER: base,
      TORANA_TOKEN: secret,
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("echo: via env");
  }, 20_000);

  test("--json mode emits parseable JSON", async () => {
    const secret = "tok-cli-ask-json-1234567";
    const { base } = await setupGateway([tokenFor(secret, ["ask"])]);
    const { stdout, exitCode } = await runCli([
      "ask",
      "bot1",
      "structured",
      "--server",
      base,
      "--token",
      secret,
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("done");
    expect(parsed.text).toBe("echo: structured");
    expect(parsed.session_id).toMatch(/^eph-/);
  }, 20_000);

  test("missing creds → exit 2 bad usage", async () => {
    const { exitCode, stderr } = await runCli(["ask", "bot1", "hi"]);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/--server/);
  }, 15_000);

  test("invalid token → exit 3 authFailed", async () => {
    const realSecret = "tok-cli-real-secret-123";
    const { base } = await setupGateway([tokenFor(realSecret, ["ask"])]);
    const { exitCode, stderr } = await runCli([
      "ask",
      "bot1",
      "hi",
      "--server",
      base,
      "--token",
      "wrong-token-xx",
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain("invalid_token");
  }, 20_000);

  test("send scope token rejected on ask → exit 3", async () => {
    const secret = "tok-cli-send-only-123";
    const { base } = await setupGateway([tokenFor(secret, ["send"])]);
    const { exitCode, stderr } = await runCli([
      "ask",
      "bot1",
      "hi",
      "--server",
      base,
      "--token",
      secret,
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain("scope_not_permitted");
  }, 20_000);

  test("--help works without --server/--token", async () => {
    const { stdout, exitCode } = await runCli(["ask", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: torana ask");
  }, 15_000);
});

describe("torana bots list — subprocess dispatch", () => {
  test("table output, exit 0", async () => {
    const secret = "tok-cli-bots-list-1234";
    const { base } = await setupGateway([tokenFor(secret, ["ask"])]);
    const { stdout, exitCode } = await runCli([
      "bots",
      "list",
      "--server",
      base,
      "--token",
      secret,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("BOT_ID");
    expect(stdout).toContain("bot1");
    // `runner_type` is hidden by default (`agent_api.expose_runner_type:
    // false`), so the RUNNER column shouldn't render.
    expect(stdout).not.toContain("RUNNER");
    expect(stdout).not.toContain("claude-code");
  }, 15_000);

  test("--json mode parseable", async () => {
    const secret = "tok-cli-bots-json-1234";
    const { base } = await setupGateway([tokenFor(secret, ["ask"])]);
    const { stdout, exitCode } = await runCli([
      "bots",
      "list",
      "--server",
      base,
      "--token",
      secret,
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.bots[0].bot_id).toBe("bot1");
  }, 15_000);
});

describe("torana turns get — subprocess dispatch", () => {
  test("after a real ask, turns get returns done", async () => {
    const secret = "tok-cli-turns-get-12345";
    const { base } = await setupGateway([tokenFor(secret, ["ask"])]);
    const askRes = await runCli([
      "ask",
      "bot1",
      "hello",
      "--server",
      base,
      "--token",
      secret,
      "--json",
    ]);
    expect(askRes.exitCode).toBe(0);
    const turnId = JSON.parse(askRes.stdout).turn_id as number;

    const { stdout, exitCode } = await runCli([
      "turns",
      "get",
      String(turnId),
      "--server",
      base,
      "--token",
      secret,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("status: done");
    expect(stdout).toContain("echo: hello");
  }, 30_000);

  test("nonexistent turn → exit 4 notFound", async () => {
    const secret = "tok-cli-turns-404-12345";
    const { base } = await setupGateway([tokenFor(secret, ["ask"])]);
    const { exitCode, stderr } = await runCli([
      "turns",
      "get",
      "999999",
      "--server",
      base,
      "--token",
      secret,
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain("turn_not_found");
  }, 15_000);
});

describe("dispatcher — usage errors before network", () => {
  test("ask without text positional → exit 2", async () => {
    const { exitCode, stderr } = await runCli([
      "ask",
      "bot1",
      "--server",
      "http://x",
      "--token",
      "t",
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/<bot_id> and <text>/);
  }, 15_000);

  test("turns without action → exit 2", async () => {
    const { exitCode, stderr } = await runCli(["turns"]);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/turns requires/);
  }, 15_000);

  test("send missing --source → exit 2", async () => {
    const secret = "tok-cli-send-nosrc-12";
    const { base } = await setupGateway([tokenFor(secret, ["send"])]);
    const { exitCode, stderr } = await runCli([
      "send",
      "bot1",
      "hi",
      "--user-id",
      "1",
      "--server",
      base,
      "--token",
      secret,
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/--source/);
  }, 15_000);
});

describe("legacy gateway commands still work", () => {
  // Sanity check that the dispatcher fallthrough preserves the existing
  // `version` subcommand. Other legacy commands (start/doctor/migrate/
  // validate) are exhaustively covered by test/cli/cli.test.ts.
  test("torana version still exits 0", async () => {
    const { stdout, exitCode } = await runCli(["version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/torana \d/);
  }, 15_000);
});
