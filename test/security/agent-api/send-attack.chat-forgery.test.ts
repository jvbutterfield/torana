// §12.5.5: an attacker sends send with a chat_id that is NOT
// associated with this bot — the chat belongs to a different bot
// or was never observed. Expected: 403 chat_not_permitted (not
// 200 — that would leak a cross-bot DM channel).

import { afterEach, describe, expect, test } from "bun:test";

import { mkToken, startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.5 send-attack.chat-forgery", () => {
  const secret = "chat-forge-secret-value-abcd1234";
  const token = mkToken("cos", secret, {
    bot_ids: ["bot1"],
    scopes: ["send"],
  });

  test("chat_id never associated with bot1 → 403 chat_not_permitted", async () => {
    h = startHarness({ tokens: [token] });
    // No user_chats rows have been seeded; chat_id 4242 is unknown.
    const r = await fetch(`${h.base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": "chat-forge-key-abcd-efgh-ijklmnop",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "forged", source: "attack", chat_id: 4242 }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("chat_not_permitted");
  });

  test("chat_id associated with a DIFFERENT bot → 403 chat_not_permitted", async () => {
    h = startHarness({ botIds: ["bot1", "bot2"], tokens: [token] });
    // User 111 opened bot2 (but not bot1).
    h.db.upsertUserChat("bot2", "111", 5555);
    const r = await fetch(`${h.base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": "chat-forge-key2-abc-efgh-ijklmnop",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "forged", source: "attack", chat_id: 5555 }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("chat_not_permitted");
  });

  test("response body does not leak information about which bot owns the chat", async () => {
    h = startHarness({ botIds: ["bot1", "bot2"], tokens: [token] });
    h.db.upsertUserChat("bot2", "111", 5555);
    const r = await fetch(`${h.base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": "chat-forge-key3-abc-efgh-ijklmnop",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "forged", source: "attack", chat_id: 5555 }),
    });
    const body = await r.text();
    expect(body).not.toContain("bot2");
  });
});
