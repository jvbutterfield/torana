// §12.5.2: valid token with one scope tries to use a route that
// requires a different scope → 403 scope_not_permitted. Scopes are
// per-route:
//   - POST /v1/bots/:id/ask    requires "ask"
//   - POST /v1/bots/:id/send requires "send"
//   - GET  /v1/bots/:id/sessions           requires "ask"
//   - DELETE /v1/bots/:id/sessions/:sid    requires "ask"

import { afterEach, describe, expect, test } from "bun:test";

import { mkToken, startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.2 authz.wrong-scope", () => {
  const askSecret = "ask-only-secret-value-abcd1234";
  const sendSecret = "send-only-secret-value-wxyz789";
  const askOnly = mkToken("askOnly", askSecret, {
    bot_ids: ["bot1"],
    scopes: ["ask"],
  });
  const sendOnly = mkToken("sendOnly", sendSecret, {
    bot_ids: ["bot1"],
    scopes: ["send"],
  });

  test("send-only token → POST /v1/bots/:id/ask → 403 scope_not_permitted", async () => {
    h = startHarness({ tokens: [sendOnly] });
    const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sendSecret}` },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error).toBe("scope_not_permitted");
    expect(body.scope).toBe("ask");
  });

  test("ask-only token → POST /v1/bots/:id/send → 403 scope_not_permitted", async () => {
    h = startHarness({ tokens: [askOnly] });
    const r = await fetch(`${h.base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${askSecret}`,
        "Idempotency-Key": "key-abcdefghijklmno",
      },
      body: JSON.stringify({ text: "hi", user_id: 123 }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("scope_not_permitted");
  });

  test("send-only token → GET /v1/bots/:id/sessions → 403 (needs 'ask')", async () => {
    h = startHarness({ tokens: [sendOnly] });
    const r = await fetch(`${h.base}/v1/bots/bot1/sessions`, {
      headers: { Authorization: `Bearer ${sendSecret}` },
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("scope_not_permitted");
  });

  test("send-only token → DELETE /v1/bots/:id/sessions/:sid → 403 (needs 'ask')", async () => {
    h = startHarness({ tokens: [sendOnly] });
    const r = await fetch(`${h.base}/v1/bots/bot1/sessions/sess-xyz`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${sendSecret}` },
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("scope_not_permitted");
  });
});
