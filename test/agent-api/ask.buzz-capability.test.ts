// Buzz capability lifecycle for Agent API `ask` turns.
//
// The bug this pins: `issueCapability` was called only from
// `Bot.dispatchSessionTurn`, so a turn started through /v1/bots/:id/ask had
// the pinned CLI, the configured endpoint, and TORANA_BUZZ_CAPABILITY_DIR in
// its environment but no capability file — `torana buzz` failed with "no Buzz
// capability is available for this runner session".
//
// These tests assert the property from inside the subprocess rather than from
// the gateway's own bookkeeping: the `buzz-probe` mock mode resolves the
// capability file exactly the way src/cli/buzz.ts does and reports
// `capability=yes|no` in its reply. A green assertion therefore means the
// agent could really have published during its own turn.

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import { createServer, type Server } from "../../src/server.js";
import { registerAgentApiRoutes } from "../../src/agent-api/router.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { SideSessionPool } from "../../src/agent-api/pool.js";
import { OrphanListenerManager } from "../../src/agent-api/orphan-listeners.js";
import { BuzzCredentialBroker } from "../../src/broker/buzz-broker.js";
import { ClaudeCodeRunner } from "../../src/runner/claude-code.js";
import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { logger } from "../../src/log.js";
import { makeTestConfig, makeTestBotConfig } from "../fixtures/bots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(__dirname, "../runner/fixtures/claude-mock.ts");
const KEY = "71".padStart(64, "0");
const GRANTED = "tok-buzz-granted-0123456789abcdef";
const UNGRANTED = "tok-buzz-ungranted-0123456789abcdef";

let tmpDir: string;
let db: GatewayDB;
let server: Server;
let runner: ClaudeCodeRunner | null = null;
let pool: SideSessionPool | null = null;
let orphans: OrphanListenerManager | null = null;
let broker: BuzzCredentialBroker | null = null;

async function setup(
  opts: { mockMode?: string; turnTimeoutSecs?: number } = {},
): Promise<{ base: string }> {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-ask-buzz-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);

  const bot = makeTestBotConfig("bot1", {
    runner: {
      type: "claude-code" as const,
      cli_path: "bun",
      args: ["run", MOCK, opts.mockMode ?? "buzz-probe"],
      env: {},
      pass_continue_flag: false,
      acknowledge_dangerous: true,
    },
  });
  const upgraded = upgradeV1Object(makeTestConfig([bot])) as any;
  if (opts.turnTimeoutSecs !== undefined) {
    upgraded.worker_tuning.turn_timeout_secs = opts.turnTimeoutSecs;
  }
  upgraded.gateway.data_dir = tmpDir;
  upgraded.gateway.db_path = dbPath;
  upgraded.platforms.buzz.enabled = true;
  upgraded.agents[0].endpoints.push({
    id: "bot1-buzz",
    platform: "buzz",
    enabled: true,
    community_id: "primary",
    relay_url: "wss://relay.example",
    private_key: KEY,
    respond_to: "anyone",
    subscribe: "all_channels",
    reactions: {},
    triggers: {},
    channel_overrides: {},
  });
  upgraded.agents[0].tools = {
    buzz: {
      policy: "collaborate",
      allowed_commands: [],
      default_endpoint_id: "bot1-buzz",
      allowed_endpoint_ids: ["bot1-buzz"],
      expose_private_key_to_runner: false,
      acknowledge_dangerous: false,
    },
  };
  upgraded.agent_api = {
    enabled: true,
    tokens: [
      {
        name: "granted",
        secret_ref: GRANTED,
        bot_ids: ["bot1"],
        scopes: ["ask"],
        buzz_tools: true,
      },
      {
        name: "ungranted",
        secret_ref: UNGRANTED,
        bot_ids: ["bot1"],
        scopes: ["ask"],
      },
    ],
  };

  const loaded = loadConfigFromString(yaml.dump(upgraded), {
    skipInterpolation: true,
  });
  const config = loaded.config;

  broker = new BuzzCredentialBroker({
    config,
    normalized: loaded.normalized,
    spawnCli: async () => ({ exitCode: 0, stdout: "[]\n", stderr: "" }),
    discoverMembership: async () => new Set<string>(),
  });
  // main.ts starts the broker before serving; start() is what creates the
  // capability directory the CLI shim reads from.
  broker.start();

  runner = new ClaudeCodeRunner({
    botId: "bot1",
    config: {
      ...(bot.runner as Extract<typeof bot.runner, { type: "claude-code" }>),
      // The gateway injects these at Bot.instantiateRunner; this test builds
      // the runner directly, so mirror what production would hand it.
      env: broker.runnerEnvironment("bot1"),
    },
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
  registerAgentApiRoutes(server.router, {
    config,
    db,
    registry: registry as never,
    tokens: loaded.agentApiTokens,
    log: logger("ask-buzz-test"),
    pool,
    orphans,
    buzzBroker: broker,
  });
  return { base: `http://127.0.0.1:${server.port}` };
}

afterEach(async () => {
  try {
    if (orphans) orphans.shutdown();
    if (pool) await pool.shutdown(1000);
    if (server) await server.stop();
    if (broker) await broker.stop();
  } finally {
    if (db) db.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    runner = null;
    pool = null;
    orphans = null;
    broker = null;
  }
});

async function ask(
  base: string,
  secret: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const r = await fetch(`${base}/v1/bots/bot1/ask`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

function capabilityFiles(): string[] {
  return readdirSync(broker!.capabilityDir).filter((f) => f.endsWith(".json"));
}

describe("ask — Buzz capability during the turn", () => {
  test("a granted token can publish from inside its own turn", async () => {
    const { base } = await setup();
    const { status, json } = await ask(base, GRANTED, { text: "digest" });
    expect(status).toBe(200);
    // The subprocess resolved a valid capability at the path the CLI shim
    // reads. This is the assertion that fails without the fix.
    expect(json.text).toContain("capability=yes");
    // ...and it was keyed on the id the subprocess actually saw.
    expect(json.text).toContain(`session=${json.session_id}`);
  }, 15_000);

  test("an ungranted token gets no capability", async () => {
    const { base } = await setup();
    const { status, json } = await ask(base, UNGRANTED, { text: "digest" });
    expect(status).toBe(200);
    expect(json.text).toContain("capability=no");
  }, 15_000);

  test("the capability is revoked once the turn completes", async () => {
    const { base } = await setup();
    const { json } = await ask(base, GRANTED, { text: "digest" });
    expect(json.text).toContain("capability=yes");
    expect(capabilityFiles()).toEqual([]);
    expect(
      existsSync(join(broker!.capabilityDir, `${json.session_id}.json`)),
    ).toBe(false);
  }, 15_000);

  test("a reused session does not leak its capability to an ungranted caller", async () => {
    // The escalation this guards: durable sessions outlive a turn, so a
    // capability left behind by a granted caller would be sitting at the
    // same path when the next turn on that session runs.
    const { base } = await setup();
    const first = await ask(base, GRANTED, {
      text: "one",
      session_id: "shared-session",
    });
    expect(first.json.text).toContain("capability=yes");
    const second = await ask(base, UNGRANTED, {
      text: "two",
      session_id: "shared-session",
    });
    expect(second.json.text).toContain("capability=no");
  }, 20_000);

  test("a granted token re-mints on each turn of a reused session", async () => {
    const { base } = await setup();
    const one = await ask(base, GRANTED, {
      text: "one",
      session_id: "regrant-session",
    });
    const two = await ask(base, GRANTED, {
      text: "two",
      session_id: "regrant-session",
    });
    expect(one.json.text).toContain("capability=yes");
    expect(two.json.text).toContain("capability=yes");
    expect(capabilityFiles()).toEqual([]);
  }, 20_000);
});

describe("ask — Buzz capability outlives a 202", () => {
  test("survives the response and dies with the orphan's release", async () => {
    // `very-slow` blocks past the timeout, so the handler returns 202 while
    // the turn keeps running. Revoking in the handler's finally would strip
    // the capability mid-turn — exactly the bug, one step later.
    const { base } = await setup({ mockMode: "very-slow" });
    const { status, json } = await ask(base, GRANTED, {
      text: "slow",
      timeout_ms: 1_000,
    });
    expect(status).toBe(202);
    const path = join(broker!.capabilityDir, `${json.session_id}.json`);
    expect(existsSync(path)).toBe(true);

    // Terminal arrives (~2s in this mode); the orphan listener owns release.
    const deadline = Date.now() + 10_000;
    while (existsSync(path) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(path)).toBe(false);
  }, 20_000);

  test("orphan shutdown revokes a still-pending capability", async () => {
    const { base } = await setup({ mockMode: "very-slow" });
    const { status, json } = await ask(base, GRANTED, {
      text: "slow",
      timeout_ms: 1_000,
    });
    expect(status).toBe(202);
    const path = join(broker!.capabilityDir, `${json.session_id}.json`);
    expect(existsSync(path)).toBe(true);
    orphans!.shutdown();
    expect(existsSync(path)).toBe(false);
  }, 20_000);
});

describe("ask — Buzz capability TTL", () => {
  test("expiry tracks the ask timeout, not the managed-turn budget", async () => {
    // The two clocks are independent: an operator who tightens
    // `worker_tuning.turn_timeout_secs` for managed conversations does not
    // thereby shorten what `agent_api.ask.max_timeout_ms` permits. At 30s the
    // managed-derived lifetime is 90s (30s + 60s slack), while this turn is
    // allowed 300s — deriving from the managed budget would expire the
    // capability with the turn still running.
    const { base } = await setup({
      mockMode: "very-slow",
      turnTimeoutSecs: 30,
    });
    const managedTtlMs = 30 * 1000 + 60_000;
    // The turn completes well inside 300s, so read the capability while it is
    // still inflight rather than waiting for a 202 that will not come.
    const inflight = ask(base, GRANTED, { text: "slow", timeout_ms: 300_000 });
    const deadline = Date.now() + 5_000;
    let files: string[] = [];
    while (files.length === 0 && Date.now() < deadline) {
      files = capabilityFiles();
      if (files.length === 0) await new Promise((r) => setTimeout(r, 25));
    }
    expect(files).toHaveLength(1);
    const file = JSON.parse(
      readFileSync(join(broker!.capabilityDir, files[0]!), "utf8"),
    ) as { expiresAt: number };
    const remainingMs = file.expiresAt - Date.now();
    expect(remainingMs).toBeGreaterThan(managedTtlMs);
    // 300s turn + 60s slack, minus the time spent getting here.
    expect(remainingMs).toBeGreaterThan(300_000);
    expect(remainingMs).toBeLessThanOrEqual(360_000);
    expect((await inflight).status).toBe(200);
  }, 30_000);
});
