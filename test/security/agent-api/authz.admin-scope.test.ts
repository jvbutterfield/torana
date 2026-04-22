// §12.5.2: the admin-ish session-management routes (list/delete
// sessions) require scope "ask". A send-only token must NOT be able
// to enumerate or stop other callers' sessions. This pins the guard
// against an over-permissive refactor where "any valid token" is
// treated as sufficient for /v1/bots/:id/sessions.

import { afterEach, describe, expect, test } from "bun:test";

import { mkToken, startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.2 authz.admin-scope", () => {
  const askSecret = "ask-admin-secret-value-abcd1234";
  const sendSecret = "send-only-secret-value-xyz567";
  const askToken = mkToken("askOp", askSecret, {
    bot_ids: ["bot1"],
    scopes: ["ask"],
  });
  const sendOnly = mkToken("sendOnly", sendSecret, {
    bot_ids: ["bot1"],
    scopes: ["send"],
  });

  test("send-only token on LIST sessions → 403 scope_not_permitted", async () => {
    h = startHarness({ tokens: [askToken, sendOnly] });
    const r = await fetch(`${h.base}/v1/bots/bot1/sessions`, {
      headers: { Authorization: `Bearer ${sendSecret}` },
    });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error).toBe("scope_not_permitted");
    expect(body.scope).toBe("ask");
  });

  test("send-only token on DELETE session → 403 scope_not_permitted", async () => {
    h = startHarness({ tokens: [askToken, sendOnly] });
    const r = await fetch(`${h.base}/v1/bots/bot1/sessions/sess-xyz`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${sendSecret}` },
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("scope_not_permitted");
  });

  test("ask token on LIST sessions → 200 (sanity: scope check is the gate, not a blanket deny)", async () => {
    h = startHarness({ tokens: [askToken, sendOnly] });
    const r = await fetch(`${h.base}/v1/bots/bot1/sessions`, {
      headers: { Authorization: `Bearer ${askSecret}` },
    });
    expect(r.status).toBe(200);
  });
});
