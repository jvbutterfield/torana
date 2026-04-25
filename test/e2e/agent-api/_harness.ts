// Shared harness for §12.4 E2E tests (`AGENT_API_E2E=1`).
//
// Every E2E file needs the same three pieces:
//   1. A real gateway (startGateway from src/main.ts) — not a stubbed
//      router — because the point of E2E is exercising the actual
//      wiring (pool + registry + runner factory + HTTP dispatch).
//   2. A bot configured with a REAL runner (ClaudeCodeRunner /
//      CodexRunner). The CLI path is either "claude" / "codex" on
//      $PATH or an override via env.
//   3. A FakeTelegram stand-in (from test/integration/fake-telegram.ts)
//      for send paths that need to verify delivery. The ask path
//      never touches Telegram.
//
// The whole suite is gated by `AGENT_API_E2E=1`. Without it, every
// file's `describe` is a `describe.skip`, so a bare `bun test` stays
// fast. We also expose a `telegramE2eEnabled()` helper for
// send-claude which additionally needs TELEGRAM_TEST_BOT_TOKEN +
// TELEGRAM_TEST_CHAT_ID.
//
// Notes on cost + flakiness:
//   - Each `ask` round-trip spawns a real claude/codex subprocess
//     and waits for a model response. Tests budget 90s per turn.
//   - Prompts are deliberately minimal ("reply with the word pong")
//     to keep tokens cheap.
//   - Callers poll `GET /v1/turns/:id` rather than awaiting the
//     handler's 200 path — ask handlers will return 202 (in-progress)
//     after `default_timeout_ms`, and callers are expected to poll.
//     This is the documented behaviour and what we should exercise.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway, type RunningGateway } from "../../../src/main.js";
import { FakeTelegram, findFreePort } from "../../integration/fake-telegram.js";
import { GatewayDB } from "../../../src/db/gateway-db.js";
import type { Config, BotConfig } from "../../../src/config/schema.js";
import type { ResolvedAgentApiToken } from "../../../src/config/load.js";

export interface E2EHarness {
  gateway: RunningGateway;
  fake: FakeTelegram | null;
  base: string;
  port: number;
  botToken: string;
  tmpDir: string;
  /** Second handle on the gateway's DB for test-side seeding. */
  db: GatewayDB;
  close: () => Promise<void>;
}

/** True when AGENT_API_E2E=1 — the suite-level gate. */
export function e2eEnabled(): boolean {
  return process.env.AGENT_API_E2E === "1";
}

/**
 * Build a safe string-only snapshot of the test process's env for
 * passing through to a real runner subprocess. Claude (and codex)
 * rely on more than HOME + PATH for auth (e.g. keychain handles,
 * XDG_*); safest is to pass everything the test has. Returns only
 * entries whose value is a string (process.env lookups can return
 * undefined).
 */
export function inheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * True when send-claude.test.ts may run. Needs the suite gate PLUS a
 * pair of TELEGRAM_TEST_* env vars pointing at a throwaway test bot +
 * chat. Without them the whole file is skipped because we can't
 * verify the delivery side of the round-trip.
 */
export function telegramE2eEnabled(): boolean {
  return (
    e2eEnabled() &&
    !!process.env.TELEGRAM_TEST_BOT_TOKEN &&
    !!process.env.TELEGRAM_TEST_CHAT_ID
  );
}

function hash(s: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(s, "utf8").digest());
}

export function mkToken(
  name: string,
  secret: string,
  overrides: Partial<ResolvedAgentApiToken> = {},
): ResolvedAgentApiToken {
  return {
    name,
    secret,
    hash: hash(secret),
    bot_ids: ["alpha"],
    scopes: ["ask", "send"],
    ...overrides,
  };
}

export interface StartE2EOptions {
  /** Bot config including the real runner (claude-code or codex). */
  botConfig: BotConfig;
  /** Tokens to register. At least one is required. */
  tokens: ResolvedAgentApiToken[];
  /**
   * If true, spin up a FakeTelegram and point the gateway at it.
   * Ask-path tests can set this to false — ask never touches telegram.
   */
  fakeTelegram?: boolean;
  /**
   * When fakeTelegram is false and you still want polling to be
   * harmless, we point the config at localhost:<unused-port>, which
   * will error out on the Telegram poll but not affect the agent-api
   * HTTP surface. Defaults to a disabled polling config.
   */
  allowedUserId?: number;
  allowedChatId?: number;
  /**
   * Override the gateway's agent-api token list shape — tests that
   * want to exercise specific scopes / bot allowlists can construct
   * their own.
   */
  configOverride?: (c: Config) => void;
}

export async function startE2E(opts: StartE2EOptions): Promise<E2EHarness> {
  const tmpDir = mkdtempSync(join(tmpdir(), "torana-e2e-"));
  const port = await findFreePort();

  const allowedUserId = opts.allowedUserId ?? 111;
  const allowedChatId = opts.allowedChatId ?? 222;

  const botToken = opts.botConfig.token;
  let fake: FakeTelegram | null = null;
  let apiBaseUrl = "http://127.0.0.1:65535"; // unreachable stub

  if (opts.fakeTelegram) {
    fake = new FakeTelegram({ bots: { [botToken]: opts.botConfig.id } });
    apiBaseUrl = await fake.start();
  }

  const config: Config = {
    version: 1,
    gateway: {
      port,
      data_dir: tmpDir,
      db_path: join(tmpDir, "gateway.db"),
      log_level: "warn",
    },
    telegram: { api_base_url: apiBaseUrl },
    transport: {
      default_mode: "polling",
      allowed_updates: ["message"],
      polling: {
        timeout_secs: 1,
        backoff_base_ms: 100,
        backoff_cap_ms: 1000,
        max_updates_per_batch: 100,
      },
    },
    access_control: { allowed_user_ids: [allowedUserId] },
    worker_tuning: {
      startup_timeout_secs: 30,
      stall_timeout_secs: 90,
      turn_timeout_secs: 300,
      crash_loop_backoff_base_ms: 5000,
      crash_loop_backoff_cap_ms: 300_000,
      max_consecutive_failures: 10,
    },
    streaming: {
      edit_cadence_ms: 1500,
      message_length_limit: 4096,
      message_length_safe_margin: 3800,
    },
    outbox: { max_attempts: 2, retry_base_ms: 500 },
    shutdown: { outbox_drain_secs: 5, runner_grace_secs: 5, hard_timeout_secs: 15 },
    dashboard: { enabled: false, mount_path: "/dashboard" },
    metrics: { enabled: false },
    attachments: {
      max_bytes: 20 * 1024 * 1024,
      max_per_turn: 10,
      retention_secs: 86_400,
      disk_usage_cap_bytes: 1024 * 1024 * 1024,
    },
    agent_api: {
      enabled: true,
      tokens: opts.tokens.map((t) => ({
        name: t.name,
        secret_ref: `\${INLINE:${t.secret}}`,
        bot_ids: [...t.bot_ids],
        scopes: [...t.scopes],
      })),
      side_sessions: {
        idle_ttl_ms: 3_600_000,
        hard_ttl_ms: 86_400_000,
        max_per_bot: 4,
        max_global: 8,
      },
      send: { idempotency_retention_ms: 86_400_000 },
      ask: {
        default_timeout_ms: 90_000,
        max_timeout_ms: 300_000,
        max_body_bytes: 10 * 1024 * 1024,
        max_files_per_request: 5,
      },
      expose_runner_type: false,
    },
    bots: [opts.botConfig],
  };

  opts.configOverride?.(config);

  const gateway = await startGateway({
    config,
    secrets: [botToken, ...opts.tokens.map((t) => t.secret)],
    autoMigrate: true,
    agentApiTokens: opts.tokens,
  });

  // Second handle on the same DB for test-side seeding (user_chats,
  // etc.). The gateway owns the primary handle; sqlite's per-process
  // concurrency semantics are fine for our low-volume test writes.
  const db = new GatewayDB(config.gateway.db_path!);

  return {
    gateway,
    fake,
    base: `http://127.0.0.1:${port}`,
    port,
    botToken,
    tmpDir,
    db,
    close: async () => {
      db.close();
      await gateway.shutdown("test-teardown");
      if (fake) await fake.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/**
 * Poll `GET /v1/turns/:id` until the turn transitions to a terminal
 * state (done / failed). Returns the final body. Throws on timeout.
 */
export async function pollTurn(
  base: string,
  bearer: string,
  turnId: number,
  timeoutMs: number,
): Promise<{ status: string; text?: string; error?: string; [k: string]: unknown }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${base}/v1/turns/${turnId}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (r.status !== 200) {
      throw new Error(`poll got HTTP ${r.status} for turn ${turnId}`);
    }
    const body = (await r.json()) as {
      status: string;
      text?: string;
      error?: string;
    };
    if (body.status === "done" || body.status === "failed") return body;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`pollTurn(${turnId}) timed out after ${timeoutMs}ms`);
}
