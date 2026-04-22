// End-to-end integration tests: inbound update → runner → outbound Telegram
// API call. The gateway runs in-process; the fake Telegram API runs on a
// random port. Both webhook and polling flows are exercised.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { startGateway, type RunningGateway } from "../../src/main.js";
import { FakeTelegram, findFreePort } from "./fake-telegram.js";
import type { Config } from "../../src/config/schema.js";
import type { TelegramUpdate } from "../../src/telegram/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_SCRIPT = resolve(__dirname, "fixtures/test-runner.ts");
const ALLOWED_USER = 111_222_333;

let tmpDir: string;
let fake: FakeTelegram | null = null;
let gateway: RunningGateway | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-integ-"));
});

afterEach(async () => {
  if (gateway) {
    await gateway.shutdown("test-teardown");
    gateway = null;
  }
  if (fake) {
    await fake.stop();
    fake = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(options: {
  apiBaseUrl: string;
  port: number;
  mode: "webhook" | "polling";
  webhookBaseUrl?: string;
  webhookSecret?: string;
  bots: Array<{ id: string; token: string }>;
}): Config {
  const base: Config = {
    version: 1,
    gateway: {
      port: options.port,
      data_dir: tmpDir,
      db_path: join(tmpDir, "gateway.db"),
      log_level: "warn",
    },
    telegram: { api_base_url: options.apiBaseUrl },
    transport: {
      default_mode: options.mode,
      allowed_updates: ["message"],
      webhook:
        options.mode === "webhook"
          ? {
              base_url: options.webhookBaseUrl!,
              secret: options.webhookSecret!,
            }
          : undefined,
      polling: {
        timeout_secs: 1,
        backoff_base_ms: 100,
        backoff_cap_ms: 1000,
        max_updates_per_batch: 100,
      },
    },
    access_control: { allowed_user_ids: [ALLOWED_USER] },
    worker_tuning: {
      startup_timeout_secs: 10,
      stall_timeout_secs: 90,
      turn_timeout_secs: 60,
      crash_loop_backoff_base_ms: 5000,
      crash_loop_backoff_cap_ms: 300_000,
      max_consecutive_failures: 10,
    },
    streaming: {
      edit_cadence_ms: 1500,
      message_length_limit: 4096,
      message_length_safe_margin: 3800,
    },
    outbox: { max_attempts: 5, retry_base_ms: 2000 },
    shutdown: { outbox_drain_secs: 10, runner_grace_secs: 5, hard_timeout_secs: 25 },
    dashboard: { enabled: false, mount_path: "/dashboard" },
    metrics: { enabled: false },
    attachments: {
      max_bytes: 20 * 1024 * 1024,
      max_per_turn: 10,
      retention_secs: 86_400,
      disk_usage_cap_bytes: 1024 * 1024 * 1024,
    },
    agent_api: {
      enabled: false,
      tokens: [],
      side_sessions: {
        idle_ttl_ms: 3_600_000,
        hard_ttl_ms: 86_400_000,
        max_per_bot: 8,
        max_global: 64,
      },
      send: { idempotency_retention_ms: 86_400_000 },
      ask: {
        default_timeout_ms: 60_000,
        max_timeout_ms: 300_000,
        max_body_bytes: 100 * 1024 * 1024,
        max_files_per_request: 10,
      },
    },
    bots: options.bots.map((b) => ({
      id: b.id,
      token: b.token,
      commands: [{ trigger: "/reset", action: "builtin:reset" as const }],
      reactions: { received_emoji: "👀" },
      runner: {
        type: "command" as const,
        cmd: ["bun", RUNNER_SCRIPT],
        protocol: "jsonl-text" as const,
        env: {},
        on_reset: "restart" as const,
      },
    })),
  };
  return base;
}

/** True iff any sendMessage or editMessageText call for `botId` has text containing `needle`. */
function telegramHasEchoOf(fake: FakeTelegram, botId: string, needle: string): boolean {
  for (const method of ["sendMessage", "editMessageText"] as const) {
    for (const call of fake.callsFor(botId, method)) {
      const text = call.body.text;
      if (typeof text === "string" && text.includes(needle)) return true;
    }
  }
  return false;
}

function makeTextUpdate(id: number, text: string): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 111, type: "private" },
      from: { id: ALLOWED_USER, is_bot: false },
      text,
    },
  };
}

describe("integration: round-trip", () => {
  test("polling: inbound text → runner echoes → sendMessage hits fake", async () => {
    const token = "TOK_POLL:AAAAAAA";
    fake = new FakeTelegram({ bots: { [token]: "alpha" } });
    const apiBase = await fake.start();
    const port = await findFreePort();

    const config = makeConfig({
      apiBaseUrl: apiBase,
      port,
      mode: "polling",
      bots: [{ id: "alpha", token }],
    });

    gateway = await startGateway({ config, secrets: [token], autoMigrate: true });

    // Queue an inbound update; the polling loop should pick it up.
    fake.queuePollingUpdate("alpha", makeTextUpdate(1, "hello"));

    // Wait for the runner's output to reach Telegram via outbox. The stream
    // manager queues a placeholder send first; depending on timing the final
    // response arrives as either an edit of that placeholder or as a fresh
    // sendMessage. Accept either.
    await fake.waitFor(
      () => telegramHasEchoOf(fake!, "alpha", "echo: hello"),
      { timeoutMs: 12_000 },
    );

    // Reaction was applied too.
    expect(fake.callsFor("alpha", "setMessageReaction")).toHaveLength(1);

    // Polling offset persisted.
    await fake.waitFor(
      () =>
        fake!.callsFor("alpha", "getUpdates").some((c) => {
          const offset = c.body.offset;
          return typeof offset === "number" && offset > 1;
        }),
      { timeoutMs: 5_000 },
    );
  }, 20_000);

  test("webhook: setWebhook + secret-verified POST → runner → reply", async () => {
    const token = "TOK_WEBHOOK:BBBBBBB";
    const webhookSecret = "super-secret-value";
    fake = new FakeTelegram({ bots: { [token]: "beta" } });
    const apiBase = await fake.start();
    const port = await findFreePort();

    const config = makeConfig({
      apiBaseUrl: apiBase,
      port,
      mode: "webhook",
      webhookBaseUrl: `http://127.0.0.1:${port}`,
      webhookSecret,
      bots: [{ id: "beta", token }],
    });

    gateway = await startGateway({ config, secrets: [token, webhookSecret], autoMigrate: true });

    // The gateway registered its webhook at startup; the fake recorded it.
    // Simulate Telegram POSTing an update to the gateway.
    const resp = await fake.deliverWebhookUpdate("beta", makeTextUpdate(1, "ping"));
    expect(resp.status).toBe(200);

    await fake.waitFor(
      () => telegramHasEchoOf(fake!, "beta", "echo: ping"),
      { timeoutMs: 12_000 },
    );

    expect(fake.callsFor("beta", "setWebhook")).toHaveLength(1);
    expect(fake.callsFor("beta", "setMessageReaction")).toHaveLength(1);
  }, 20_000);

  test("webhook: wrong secret and unknown bot return identical responses (no enumeration)", async () => {
    const token = "TOK_SEC:CCCCCCC";
    fake = new FakeTelegram({ bots: { [token]: "gamma" } });
    const apiBase = await fake.start();
    const port = await findFreePort();

    const config = makeConfig({
      apiBaseUrl: apiBase,
      port,
      mode: "webhook",
      webhookBaseUrl: `http://127.0.0.1:${port}`,
      webhookSecret: "right-secret",
      bots: [{ id: "gamma", token }],
    });
    gateway = await startGateway({ config, secrets: [token, "right-secret"], autoMigrate: true });

    // Wait for setWebhook to complete so we know the route is registered.
    await fake.waitFor(() => fake!.callsFor("gamma", "setWebhook").length > 0, {
      timeoutMs: 5_000,
    });

    // Known bot, wrong secret.
    const wrongSecret = await fetch(`http://127.0.0.1:${port}/webhook/gamma`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "wrong-secret",
      },
      body: JSON.stringify(makeTextUpdate(1, "ping")),
    });
    // Unknown bot, wrong secret.
    const unknownBot = await fetch(`http://127.0.0.1:${port}/webhook/does-not-exist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "wrong-secret",
      },
      body: JSON.stringify(makeTextUpdate(1, "ping")),
    });

    // Both return 200 with the same body, so an unauthenticated requester
    // can't tell bot existence from response shape alone.
    expect(wrongSecret.status).toBe(200);
    expect(unknownBot.status).toBe(200);
    expect(await wrongSecret.text()).toBe(await unknownBot.text());

    // And the runner did NOT dispatch despite the 200.
    await new Promise((r) => setTimeout(r, 500));
    expect(fake.callsFor("gamma", "setMessageReaction")).toHaveLength(0);
    expect(telegramHasEchoOf(fake, "gamma", "echo: ping")).toBe(false);
  }, 15_000);

  test("polling: unauthorized sender → rejected, no runner dispatch", async () => {
    const token = "TOK_ACL:DDDDDDD";
    fake = new FakeTelegram({ bots: { [token]: "delta" } });
    const apiBase = await fake.start();
    const port = await findFreePort();

    const config = makeConfig({
      apiBaseUrl: apiBase,
      port,
      mode: "polling",
      bots: [{ id: "delta", token }],
    });
    gateway = await startGateway({ config, secrets: [token], autoMigrate: true });

    // Allowlist is [ALLOWED_USER]; this one isn't.
    const update: TelegramUpdate = {
      update_id: 7,
      message: {
        message_id: 7,
        date: 1,
        chat: { id: 111, type: "private" },
        from: { id: 99_999, is_bot: false },
        text: "hi",
      },
    };
    fake.queuePollingUpdate("delta", update);

    // Give the polling loop and dispatcher time to run. No echo should ever
    // arrive — if it did it'd show up as editMessageText with "echo: hi".
    await new Promise((r) => setTimeout(r, 1200));
    expect(telegramHasEchoOf(fake, "delta", "echo: hi")).toBe(false);
    // No reaction either (plan §3.6: rejected ACL doesn't acknowledge).
    expect(fake.callsFor("delta", "setMessageReaction")).toHaveLength(0);
  }, 10_000);
});
