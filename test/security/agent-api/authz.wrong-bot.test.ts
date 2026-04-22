// §12.5.2: valid token scoped to bot A tries to use bot B → 403
// bot_not_permitted. Every route that takes :bot_id in the path must
// check authz against the token's bot_ids list.

import { afterEach, describe, expect, test } from "bun:test";

import { mkToken, startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.2 authz.wrong-bot", () => {
  const secret = "bot-a-secret-value-abcd1234";
  const tokenForA = mkToken("coA", secret, {
    bot_ids: ["botA"],
    scopes: ["ask", "send"],
  });

  test("POST /v1/bots/botB/ask with token-for-botA → 403 bot_not_permitted", async () => {
    h = startHarness({ botIds: ["botA", "botB"], tokens: [tokenForA] });
    const r = await fetch(`${h.base}/v1/bots/botB/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error).toBe("bot_not_permitted");
    expect(body.bot_id).toBe("botB");
  });

  test("POST /v1/bots/botB/send with token-for-botA → 403 bot_not_permitted", async () => {
    h = startHarness({ botIds: ["botA", "botB"], tokens: [tokenForA] });
    const r = await fetch(`${h.base}/v1/bots/botB/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": "key-abcdefghijklmno",
      },
      body: JSON.stringify({ text: "hi", user_id: 123 }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("bot_not_permitted");
  });

  test("GET /v1/bots/botB/sessions with token-for-botA → 403 bot_not_permitted", async () => {
    h = startHarness({ botIds: ["botA", "botB"], tokens: [tokenForA] });
    const r = await fetch(`${h.base}/v1/bots/botB/sessions`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("bot_not_permitted");
  });

  test("DELETE /v1/bots/botB/sessions/:id with token-for-botA → 403", async () => {
    h = startHarness({ botIds: ["botA", "botB"], tokens: [tokenForA] });
    const r = await fetch(`${h.base}/v1/bots/botB/sessions/sess-123`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("bot_not_permitted");
  });

  test("GET /v1/bots returns ONLY permitted bots (bot allowlist applied)", async () => {
    h = startHarness({ botIds: ["botA", "botB"], tokens: [tokenForA] });
    const r = await fetch(`${h.base}/v1/bots`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    const ids = body.bots.map((b: { bot_id: string }) => b.bot_id);
    expect(ids).toEqual(["botA"]);
    expect(ids).not.toContain("botB");
  });
});
