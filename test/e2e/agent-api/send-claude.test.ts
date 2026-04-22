// §12.4: send round-trip against REAL claude + a REAL Telegram
// sandbox bot. Additionally gated by TELEGRAM_TEST_BOT_TOKEN +
// TELEGRAM_TEST_CHAT_ID; without them the whole file is skipped.
//
// What this covers beyond the integration-level FakeTelegram send
// test:
//   1. The claude runner actually processes the marker-wrapped prompt
//      and produces a response the streaming manager + outbox will
//      ship to Telegram.
//   2. The Telegram HTTP client posts to api.telegram.org successfully
//      (config auth + network path).
//   3. A human can verify the message arrived in the test chat.
//
// Setup: create a disposable test bot via @BotFather, DM it from a
// test account so user_chats lands, put the chat_id + bot token in
// env, and run:
//
//   AGENT_API_E2E=1 \
//   TELEGRAM_TEST_BOT_TOKEN='123:abc' \
//   TELEGRAM_TEST_CHAT_ID='111222333' \
//   TELEGRAM_TEST_USER_ID='111222333' \
//   bun test test/e2e/agent-api/send-claude.test.ts

import { afterEach, describe, expect, test } from "bun:test";

import {
  inheritedEnv,
  mkToken,
  pollTurn,
  startE2E,
  telegramE2eEnabled,
  type E2EHarness,
} from "./_harness.js";
import type { BotConfig } from "../../../src/config/schema.js";

const describeOrSkip = telegramE2eEnabled() ? describe : describe.skip;

let h: E2EHarness | null = null;

afterEach(async () => {
  if (h) {
    await h.close();
    h = null;
  }
});

function claudeBot(): BotConfig {
  return {
    id: "alpha",
    token: process.env.TELEGRAM_TEST_BOT_TOKEN ?? "missing",
    commands: [],
    reactions: { received_emoji: "👀" },
    runner: {
      type: "claude-code",
      cli_path: process.env.CLAUDE_CLI_PATH ?? "claude",
      args: [],
      env: inheritedEnv(),
      pass_continue_flag: false,
    },
  };
}

describeOrSkip("§12.4 send-claude — real claude + real Telegram sandbox", () => {
  test("send turn lands on the sandbox Telegram chat", async () => {
    const secret = "e2e-send-claude-secret-abcde1234";
    const token = mkToken("e2e-send", secret, { scopes: ["send"] });

    // Seed user_chats by inserting a row directly — we can't DM the
    // sandbox bot from within the test. ALLOWED_USER must match
    // TELEGRAM_TEST_USER_ID. In most setups the test user + test chat
    // are the same id (private chat).
    const allowedUserId = Number(process.env.TELEGRAM_TEST_USER_ID);
    const allowedChatId = Number(process.env.TELEGRAM_TEST_CHAT_ID);
    expect(Number.isFinite(allowedUserId)).toBe(true);
    expect(Number.isFinite(allowedChatId)).toBe(true);

    h = await startE2E({
      botConfig: claudeBot(),
      tokens: [token],
      fakeTelegram: false,
      allowedUserId,
      allowedChatId,
      configOverride: (c) => {
        // Real Telegram.
        c.telegram.api_base_url = "https://api.telegram.org";
      },
    });

    // Seed user_chats so chat resolution by user_id succeeds.
    h.db.upsertUserChat("alpha", String(allowedUserId), allowedChatId);

    const marker = `e2e-send-${Date.now().toString(36)}`;
    const r = await fetch(`${h.base}/v1/bots/alpha/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `e2e-send-key-${Date.now().toString(36)}-abcd1234`,
      },
      body: JSON.stringify({
        text: `Reply with ONLY the exact token ${marker}`,
        source: "e2e-test",
        user_id: String(allowedUserId),
      }),
    });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { turn_id: number; status: string };

    // Give the dispatch loop + runner + telegram client time to do their
    // thing. The handler goes to status=done once the streaming manager
    // + outbox have posted to Telegram.
    const done = await pollTurn(h.base, secret, body.turn_id, 180_000);
    expect(done.status).toBe("done");

    // Can't programmatically verify Telegram delivery without calling
    // the bot's getUpdates / reading the chat as the test user — both
    // are outside our control here. The test operator checks their
    // test chat manually. What we CAN assert is that the gateway
    // believes it delivered successfully.
  }, 300_000);
});
