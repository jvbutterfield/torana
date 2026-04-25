// §12.5.5: a token scoped to bot A tries to send on bot B → 403
// bot_not_permitted. Duplicates some coverage in authz.wrong-bot but
// specifically frames it as an attacker actively trying to escalate
// cross-bot, which is a common threat model in multi-tenant setups.

import { afterEach, describe, expect, test } from "bun:test";

import { mkToken, startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.5 send-attack.cross-bot", () => {
  const secretForA = "tok-a-send-secret-value-abcd";
  const tokenForA = mkToken("opA", secretForA, {
    bot_ids: ["botA"],
    scopes: ["send"],
  });

  test("token-for-A tries to send on botB → 403 bot_not_permitted", async () => {
    h = startHarness({ botIds: ["botA", "botB"], tokens: [tokenForA] });
    h.db.upsertUserChat("botB", "111", 999);

    const r = await fetch(`${h.base}/v1/bots/botB/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretForA}`,
        "Idempotency-Key": "cross-bot-key-abc-efgh-ijklmnop",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "xfer", source: "attack", user_id: "111" }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("bot_not_permitted");
  });

  test("403 bot_not_permitted is returned BEFORE any body parse (no content leak on cross-bot)", async () => {
    h = startHarness({ botIds: ["botA", "botB"], tokens: [tokenForA] });

    // If the handler were to parse the body first, an attacker could
    // probe by timing body-parse latency against bodies of different
    // sizes. We assert the authz gate fires up-front: a deliberately
    // malformed body still returns bot_not_permitted, not invalid_body.
    const r = await fetch(`${h.base}/v1/bots/botB/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretForA}`,
        "Idempotency-Key": "cross-bot-key2-abc-efgh-ijklmnop",
        "Content-Type": "application/json",
      },
      body: "NOT A VALID JSON BODY AT ALL {",
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("bot_not_permitted");
  });

  test("token-for-A probing a nonexistent bot ID gets 403 bot_not_permitted (not 404 unknown_bot — no enumeration)", async () => {
    // Enumeration defense: a token scoped only to botA must not be able to
    // distinguish "phantom bot doesn't exist" from "I'm not permitted on
    // this bot". The router enforces authorization BEFORE the registry
    // lookup, so both cases return the same 403 response and an attacker
    // holding a legitimate-but-narrow token cannot map out other bot ids.
    h = startHarness({ botIds: ["botA"], tokens: [tokenForA] });
    const r = await fetch(`${h.base}/v1/bots/phantom/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretForA}`,
        "Idempotency-Key": "cross-bot-key3-abc-efgh-ijklmnop",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi", source: "attack", user_id: "111" }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("bot_not_permitted");
  });
});
