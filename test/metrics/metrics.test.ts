// Metrics + AlertManager unit tests.

import { describe, expect, test } from "bun:test";

import { Metrics } from "../../src/metrics.js";
import { AlertManager } from "../../src/alerts.js";
import { TelegramClient } from "../../src/telegram/client.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

describe("Metrics", () => {
  test("pre-initializes counters + timers for every bot in config", () => {
    const config = makeTestConfig([
      makeTestBotConfig("alpha"),
      makeTestBotConfig("beta"),
    ]);
    const m = new Metrics(config);
    const snap = m.snapshot();
    expect(Object.keys(snap).sort()).toEqual(["alpha", "beta"]);
    expect(snap.alpha.counters.inbound_received).toBe(0);
    expect(snap.alpha.timers.last_turn_duration_ms).toBeNull();
  });

  test("inc increments counter for the targeted bot only", () => {
    const config = makeTestConfig([
      makeTestBotConfig("alpha"),
      makeTestBotConfig("beta"),
    ]);
    const m = new Metrics(config);
    m.inc("alpha", "turns_completed");
    m.inc("alpha", "turns_completed", 4);
    m.inc("beta", "turns_failed");
    const snap = m.snapshot();
    expect(snap.alpha.counters.turns_completed).toBe(5);
    expect(snap.alpha.counters.turns_failed).toBe(0);
    expect(snap.beta.counters.turns_failed).toBe(1);
  });

  test("inc for unknown bot is a no-op (doesn't throw)", () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")]);
    const m = new Metrics(config);
    m.inc("unknown" as "alpha", "turns_completed");
    const snap = m.snapshot();
    expect(snap.alpha.counters.turns_completed).toBe(0);
  });

  test("recordTimer sets last-N value", () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")]);
    const m = new Metrics(config);
    m.recordTimer("alpha", "last_turn_duration_ms", 1234);
    const snap = m.snapshot();
    expect(snap.alpha.timers.last_turn_duration_ms).toBe(1234);
  });

  test("snapshot returns deep-copied counters (caller can't mutate internal state)", () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")]);
    const m = new Metrics(config);
    m.inc("alpha", "turns_completed");
    const snap = m.snapshot();
    snap.alpha.counters.turns_completed = 999;
    const snap2 = m.snapshot();
    expect(snap2.alpha.counters.turns_completed).toBe(1);
  });

  test("uptimeSecs is monotonic non-decreasing", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")]);
    const m = new Metrics(config);
    const u1 = m.uptimeSecs();
    await new Promise((r) => setTimeout(r, 1100));
    const u2 = m.uptimeSecs();
    expect(u2).toBeGreaterThanOrEqual(u1);
    expect(u2 - u1).toBeGreaterThanOrEqual(1);
  });

  test("recordTelegramCall buckets by status class", () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")]);
    const m = new Metrics(config);
    m.recordTelegramCall("2xx");
    m.recordTelegramCall("2xx");
    m.recordTelegramCall("4xx");
    m.recordTelegramCall("network_err");
    // Only observable via renderPrometheus.
    const body = m.renderPrometheus({ alpha: 2 });
    expect(body).toContain('telegram_api_calls_total{status="2xx"} 2');
    expect(body).toContain('telegram_api_calls_total{status="4xx"} 1');
    expect(body).toContain('telegram_api_calls_total{status="network_err"} 1');
  });

  test("renderPrometheus includes all required metric families", () => {
    const config = makeTestConfig([
      makeTestBotConfig("alpha"),
      makeTestBotConfig("beta"),
    ]);
    const m = new Metrics(config);
    m.inc("alpha", "turns_completed", 3);
    m.inc("alpha", "turns_failed", 1);
    m.inc("beta", "telegram_send_failures", 2);
    const body = m.renderPrometheus({ alpha: 2, beta: 1 });
    expect(body).toContain("# HELP gateway_uptime_secs");
    expect(body).toContain("# HELP turns_total");
    expect(body).toContain('turns_total{bot_id="alpha",status="completed"} 3');
    expect(body).toContain('turns_total{bot_id="alpha",status="failed"} 1');
    expect(body).toContain("# HELP bot_state");
    expect(body).toContain('bot_state{bot_id="alpha"} 2');
    expect(body).toContain('bot_state{bot_id="beta"} 1');
    expect(body).toContain("# HELP outbox_attempts_total");
    expect(body).toMatch(/outbox_attempts_total\{bot_id="beta",result="retry"\} 2/);
    expect(body).toContain("# HELP telegram_api_calls_total");
    // Ends with trailing newline.
    expect(body.endsWith("\n")).toBe(true);
  });
});

describe("AlertManager", () => {
  function makeClient(sends: Array<{ chatId: number; text: string }>): TelegramClient {
    return {
      async sendMessage(chatId: number, text: string) {
        sends.push({ chatId, text });
        return { messageId: 1 };
      },
    } as unknown as TelegramClient;
  }

  test("no alerts block → alerts are logged at warn only (no sendMessage)", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")]);
    const sends: Array<{ chatId: number; text: string }> = [];
    const clients = new Map([["alpha", makeClient(sends)]]);
    const a = new AlertManager(config, clients);
    await a.workerDegraded("alpha", "reason");
    expect(sends).toHaveLength(0);
  });

  test("configured alerts block → sends via the via_bot client", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha"), makeTestBotConfig("beta")], {
      alerts: { chat_id: 99_999, via_bot: "beta", cooldown_ms: 0 },
    });
    const sends: Array<{ chatId: number; text: string }> = [];
    const clients = new Map([
      ["alpha", makeClient([])], // subject bot — not the delivery bot
      ["beta", makeClient(sends)],
    ]);
    const a = new AlertManager(config, clients);
    await a.tokenInvalid("alpha");
    expect(sends).toHaveLength(1);
    expect(sends[0].chatId).toBe(99_999);
    expect(sends[0].text).toContain("alpha");
    expect(sends[0].text).toContain("token invalid");
  });

  test("cooldown: same-key alerts within cooldown are suppressed", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")], {
      alerts: { chat_id: 1, via_bot: "alpha", cooldown_ms: 60_000 },
    });
    const sends: Array<{ chatId: number; text: string }> = [];
    const clients = new Map([["alpha", makeClient(sends)]]);
    const a = new AlertManager(config, clients);
    await a.workerDegraded("alpha", "reason");
    await a.workerDegraded("alpha", "reason");
    await a.workerDegraded("alpha", "different reason");
    expect(sends).toHaveLength(1);
  });

  test("cooldown: different keys are independent", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha"), makeTestBotConfig("beta")], {
      alerts: { chat_id: 1, via_bot: "alpha", cooldown_ms: 60_000 },
    });
    const sends: Array<{ chatId: number; text: string }> = [];
    const clients = new Map([
      ["alpha", makeClient(sends)],
      ["beta", makeClient([])],
    ]);
    const a = new AlertManager(config, clients);
    // Different subject (alpha vs. beta) → different cooldown key.
    await a.workerDegraded("alpha", "r");
    await a.workerDegraded("beta", "r");
    // Different kind → different cooldown key.
    await a.tokenInvalid("alpha");
    expect(sends).toHaveLength(3);
  });

  test("cooldown expires after cooldown_ms", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")], {
      alerts: { chat_id: 1, via_bot: "alpha", cooldown_ms: 50 },
    });
    const sends: Array<{ chatId: number; text: string }> = [];
    const clients = new Map([["alpha", makeClient(sends)]]);
    const a = new AlertManager(config, clients);
    await a.workerDegraded("alpha", "r");
    await new Promise((r) => setTimeout(r, 80));
    await a.workerDegraded("alpha", "r");
    expect(sends).toHaveLength(2);
  });

  test("send failure is caught (doesn't throw from emit)", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")], {
      alerts: { chat_id: 1, via_bot: "alpha", cooldown_ms: 0 },
    });
    const failClient = {
      async sendMessage() { throw new Error("network"); },
    } as unknown as TelegramClient;
    const a = new AlertManager(config, new Map([["alpha", failClient]]));
    // Must not throw.
    await a.tokenInvalid("alpha");
  });

  test("each alert kind emits a distinct emoji + text", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")], {
      alerts: { chat_id: 1, via_bot: "alpha", cooldown_ms: 0 },
    });
    const sends: Array<{ chatId: number; text: string }> = [];
    const clients = new Map([["alpha", makeClient(sends)]]);
    const a = new AlertManager(config, clients);
    await a.workerDegraded("alpha", "r");
    await a.workerCrashLoop("alpha", 5);
    await a.tokenInvalid("alpha");
    await a.mailboxBacklog("alpha", 12);
    await a.outboxFailures("alpha", 3);
    await a.turnStalled("alpha", 42);
    await a.attachmentDiskFull();
    await a.webhookSetFailed("alpha", "bad url");
    expect(sends).toHaveLength(8);
    expect(sends[0].text).toMatch(/degraded/);
    expect(sends[1].text).toMatch(/crash loop/);
    expect(sends[2].text).toMatch(/token invalid/);
    expect(sends[3].text).toMatch(/backlog/);
    expect(sends[4].text).toMatch(/outbox/);
    expect(sends[5].text).toMatch(/stalled/);
    expect(sends[6].text).toMatch(/disk|full/i);
    expect(sends[7].text).toMatch(/webhook|setWebhook/i);
  });

  test("via_bot pointing at a bot with no client: falls back to log-only", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")], {
      alerts: { chat_id: 1, via_bot: "alpha", cooldown_ms: 0 },
    });
    // Empty clients map — AlertManager will have deliveryClient = null.
    const a = new AlertManager(config, new Map());
    // Should NOT throw.
    await a.tokenInvalid("alpha");
  });
});
