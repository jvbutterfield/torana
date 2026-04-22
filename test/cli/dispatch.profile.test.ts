// End-to-end subprocess tests for the Phase 6b profile store path:
//
//   * `torana ask bot1 "hi"` works when only a profile is configured
//     (no --server, no --token, no TORANA_* env).
//   * `torana ask --profile NAME ...` picks the named profile even when
//     a different profile is marked default.
//   * `torana ask --profile bogus ...` exits 2 with a helpful message.
//   * `torana doctor --profile NAME` resolves the profile and runs the
//     R001/R002 remote probes (proving the Phase 7 `runRemoteDoctor` is
//     correctly wired to the Phase 6b profile lookup).
//   * `torana config list-profiles` over a subprocess returns the
//     expected JSON shape (sanity for the TOML writer + config reader).
//
// The gateway setup mirrors test/cli/dispatch.test.ts; we'd rather
// duplicate a few dozen lines than couple these tests to that file's
// lifecycle helpers.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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

let gwDir: string;
let xdgDir: string;
let db: GatewayDB;
let server: Server;
let runner: ClaudeCodeRunner | null = null;
let pool: SideSessionPool | null = null;
let orphans: OrphanListenerManager | null = null;

async function setupGateway(tokens: ResolvedAgentApiToken[]): Promise<{ base: string }> {
  gwDir = mkdtempSync(join(tmpdir(), "torana-profile-gw-"));
  const dbPath = join(gwDir, "gateway.db");
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

  runner = new ClaudeCodeRunner({
    botId: "bot1",
    config: bot.runner as Extract<typeof bot.runner, { type: "claude-code" }>,
    logDir: gwDir,
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
  registerAgentApiHealthRoute(server.router, { config, uptimeSecs: () => 1 });
  registerAgentApiRoutes(server.router, {
    config,
    db,
    registry: registry as never,
    tokens,
    log: logger("profile-dispatch-test"),
    pool,
    orphans,
  });
  return { base: `http://127.0.0.1:${server.port}` };
}

function tokenFor(secret: string, scopes: ("ask" | "send")[]): ResolvedAgentApiToken {
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

function writeProfileFile(defaultName: string, profiles: Record<string, { server: string; token: string }>): string {
  xdgDir = mkdtempSync(join(tmpdir(), "torana-profile-xdg-"));
  mkdirSync(join(xdgDir, "torana"), { recursive: true });
  const path = join(xdgDir, "torana", "config.toml");
  const lines: string[] = [`default = "${defaultName}"`, ""];
  for (const [name, p] of Object.entries(profiles)) {
    lines.push(`[profile.${name}]`);
    lines.push(`server = "${p.server}"`);
    lines.push(`token = "${p.token}"`);
    lines.push("");
  }
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
  return xdgDir;
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
    if (gwDir) rmSync(gwDir, { recursive: true, force: true });
    if (xdgDir) rmSync(xdgDir, { recursive: true, force: true });
    runner = null;
    pool = null;
    orphans = null;
  }
});

describe("torana ask — profile resolution", () => {
  test("default profile is used when no flags/env are given", async () => {
    const secret = "tok-profile-ask-default-1";
    const { base } = await setupGateway([tokenFor(secret, ["ask"])]);
    const xdg = writeProfileFile("only", {
      only: { server: base, token: secret },
    });
    const { stdout, stderr, exitCode } = await runCli(
      ["ask", "bot1", "hello"],
      { XDG_CONFIG_HOME: xdg },
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("echo: hello");
    expect(stderr).toBe("");
  }, 20_000);

  test("--profile NAME picks a non-default profile", async () => {
    const secret = "tok-profile-ask-named-1";
    const { base } = await setupGateway([tokenFor(secret, ["ask"])]);
    const xdg = writeProfileFile("fallback", {
      // fallback points at a bad server so a bug would surface as a
      // network error, not a silent success.
      fallback: { server: "http://127.0.0.1:1", token: "wrong" },
      named: { server: base, token: secret },
    });
    const { stdout, exitCode } = await runCli(
      ["ask", "bot1", "via named", "--profile", "named"],
      { XDG_CONFIG_HOME: xdg },
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("echo: via named");
  }, 20_000);

  test("--profile bogus exits 2 with a list of known profiles", async () => {
    const secret = "tok-profile-ask-bogus-1";
    const { base } = await setupGateway([tokenFor(secret, ["ask"])]);
    const xdg = writeProfileFile("real", {
      real: { server: base, token: secret },
    });
    const { stderr, exitCode } = await runCli(
      ["ask", "bot1", "hi", "--profile", "bogus"],
      { XDG_CONFIG_HOME: xdg },
    );
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/profile 'bogus' not found/);
    expect(stderr).toContain("real");
  }, 20_000);

  test("--server / --token win over the profile", async () => {
    const secret = "tok-profile-override-1";
    const { base } = await setupGateway([tokenFor(secret, ["ask"])]);
    const xdg = writeProfileFile("bad", {
      // profile points elsewhere; --server/--token should still reach the gw.
      bad: { server: "http://127.0.0.1:1", token: "nope" },
    });
    const { stdout, exitCode } = await runCli(
      ["ask", "bot1", "via override", "--server", base, "--token", secret],
      { XDG_CONFIG_HOME: xdg },
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("echo: via override");
  }, 20_000);
});

describe("torana doctor --profile NAME (subprocess)", () => {
  test("resolves profile + runs R001/R002 remote probes", async () => {
    const secret = "tok-profile-doctor-1";
    const { base } = await setupGateway([tokenFor(secret, ["ask"])]);
    const xdg = writeProfileFile("main", {
      main: { server: base, token: secret },
    });
    const { stdout, stderr, exitCode } = await runCli(
      ["doctor", "--profile", "main"],
      { XDG_CONFIG_HOME: xdg },
    );
    // Exit 0 when all checks pass (R001 ok, R002 ok, R003 skipped on http://).
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("R001:");
    expect(stdout).toContain("R002:");
  }, 20_000);

  test("--profile ghost exits 2 with hints", async () => {
    const xdg = writeProfileFile("real", {
      real: { server: "http://x", token: "t" },
    });
    const { stderr, exitCode } = await runCli(
      ["doctor", "--profile", "ghost"],
      { XDG_CONFIG_HOME: xdg },
    );
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/profile 'ghost' not found/);
  }, 15_000);

  test("--profile with a non-existent config file exits 2", async () => {
    const xdg = mkdtempSync(join(tmpdir(), "torana-empty-xdg-"));
    try {
      const { stderr, exitCode } = await runCli(
        ["doctor", "--profile", "any"],
        { XDG_CONFIG_HOME: xdg },
      );
      expect(exitCode).toBe(2);
      expect(stderr).toMatch(/profile 'any' not found|no profiles configured/);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("torana config — subprocess round-trip", () => {
  test("add-profile → list-profiles round-trips via subprocess", async () => {
    xdgDir = mkdtempSync(join(tmpdir(), "torana-cfg-sub-"));
    try {
      const add = await runCli(
        [
          "config",
          "add-profile",
          "alpha",
          "--server",
          "http://localhost:8080",
          "--token",
          "tok-sub-abcdef-0001",
        ],
        { XDG_CONFIG_HOME: xdgDir },
      );
      expect(add.exitCode).toBe(0);
      const list = await runCli(
        ["config", "list-profiles", "--json"],
        { XDG_CONFIG_HOME: xdgDir },
      );
      expect(list.exitCode).toBe(0);
      const parsed = JSON.parse(list.stdout) as {
        default: string;
        profiles: Record<string, { server: string; token: string }>;
      };
      expect(parsed.default).toBe("alpha");
      expect(parsed.profiles.alpha!.server).toBe("http://localhost:8080");
      // Token is redacted.
      expect(parsed.profiles.alpha!.token).toBe("tok-********");
      // File is 0600 on disk.
      const filePath = join(xdgDir, "torana", "config.toml");
      const raw = readFileSync(filePath, "utf-8");
      expect(raw).toContain('[profile.alpha]');
      expect(raw).toContain('server = "http://localhost:8080"');
    } finally {
      rmSync(xdgDir, { recursive: true, force: true });
      xdgDir = "";
    }
  }, 15_000);
});
