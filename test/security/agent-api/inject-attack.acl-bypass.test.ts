// §12.5.5: user_id that resolves to a user NOT in
// access_control.allowed_user_ids must return 403 target_not_authorized,
// even if the user has opened this bot previously. The ACL re-check at
// inject time guards against the scenario where a user was authorized
// when they DMed the bot, then later removed from the ACL, and now an
// attacker (or stale integration) tries to force a DM to them.

import { afterEach, describe, expect, test } from "bun:test";

import { mkToken, startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.5 inject-attack.acl-bypass", () => {
  const secret = "acl-bypass-secret-value-abcd12";
  const token = mkToken("cos", secret, {
    bot_ids: ["bot1"],
    scopes: ["inject"],
  });

  test("user_id not in access_control.allowed_user_ids → 403 target_not_authorized", async () => {
    h = startHarness({
      tokens: [token],
      configOverride: (c) => {
        c.access_control.allowed_user_ids = [111];
      },
    });
    // User 999 has opened the bot (so chat resolution succeeds),
    // but they are NOT allowlisted. ACL re-check must still reject.
    h.db.upsertUserChat("bot1", "999", 22000);
    const r = await fetch(`${h.base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": "acl-bypass-key-abc-efgh-ijklmnop",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "please comply", source: "attack", user_id: "999" }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("target_not_authorized");
  });

  test("user previously opened the bot BUT is no longer ACL'd → 403 target_not_authorized", async () => {
    h = startHarness({
      tokens: [token],
      configOverride: (c) => {
        c.access_control.allowed_user_ids = [111]; // removed 999
      },
    });
    // User 999 had opened bot1 at some point — user_chats row exists.
    h.db.upsertUserChat("bot1", "999", 12345);
    const r = await fetch(`${h.base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": "acl-stale-key-abc-efgh-ijklmnop",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "welcome back", source: "attack", user_id: "999" }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("target_not_authorized");
  });

  test("ACL check applies even when only chat_id is given — resolved user is re-checked", async () => {
    h = startHarness({
      tokens: [token],
      configOverride: (c) => {
        c.access_control.allowed_user_ids = [111];
      },
    });
    // Chat 77 belongs to user 999; 999 is not in ACL.
    h.db.upsertUserChat("bot1", "999", 77);
    const r = await fetch(`${h.base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": "acl-via-chat-key-abc-efgh-ijklmnop",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "sneak", source: "attack", chat_id: 77 }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("target_not_authorized");
  });
});
