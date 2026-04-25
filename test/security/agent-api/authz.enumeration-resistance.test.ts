// §12.5.2: enumeration resistance on GET /v1/turns/:id.
//
// Three failure paths must all produce byte-identical response bodies
// and equivalent latency so an attacker cannot tell whether:
//   (a) the id doesn't exist,
//   (b) the id exists but belongs to a different caller,
//   (c) the id exists but is a telegram-origin turn (no agent-api caller).
//
// All three return 404 turn_not_found with the same canonical body.
//
// See src/agent-api/handlers/turns.ts (§6.2 in impl plan) for the
// timing-safe lookup order.

import { afterEach, describe, expect, test } from "bun:test";

import { mkToken, startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.2 authz.enumeration-resistance", () => {
  const attackerSecret = "attacker-secret-value-1234567890";
  const victimSecret = "victim-secret-value-abcdef12345";
  const attacker = mkToken("attacker", attackerSecret);
  const victim = mkToken("victim", victimSecret);

  test("nonexistent id and different-caller id return identical 404 bodies", async () => {
    h = startHarness({ tokens: [attacker, victim] });

    // (a) Nonexistent turn_id.
    const r1 = await fetch(`${h.base}/v1/turns/9999999`, {
      headers: { Authorization: `Bearer ${attackerSecret}` },
    });

    // (b) Turn owned by victim — attacker asks about it.
    const victimTurnId = h.db.insertAskTurn({
      botId: "bot1",
      tokenName: "victim",
      sessionId: "v-session",
      textPreview: "secret content",
      attachmentPaths: [],
    });
    const r2 = await fetch(`${h.base}/v1/turns/${victimTurnId}`, {
      headers: { Authorization: `Bearer ${attackerSecret}` },
    });

    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);

    const b1 = await r1.text();
    const b2 = await r2.text();

    // Both bodies must be byte-identical — no leak of whether id exists
    // or belongs to someone else.
    expect(b1).toBe(b2);

    const parsed = JSON.parse(b1);
    expect(parsed.error).toBe("turn_not_found");
  });

  test("telegram-origin turn is also indistinguishable from nonexistent", async () => {
    // Telegram-origin turns have agent_api_token_name = NULL, so they
    // never match the caller's token name and should return
    // turn_not_found just like a genuinely missing id. We exercise
    // this via raw SQL since the public insert helpers are purpose-
    // specific.
    h = startHarness({ tokens: [attacker] });
    const db = (
      h.db as unknown as {
        _db: {
          prepare: (s: string) => {
            get: (...a: unknown[]) => unknown;
            run: (...a: unknown[]) => unknown;
          };
        };
      }
    )._db;
    db.prepare(
      `INSERT INTO inbound_updates (id, bot_id, telegram_update_id, chat_id, message_id, from_user_id, payload_json)
       VALUES (1, 'bot1', 1, 100, 1, '1', '{}')`,
    ).run();
    const row = db
      .prepare(
        `INSERT INTO turns (bot_id, chat_id, source_update_id, status, attachment_paths_json, source)
         VALUES ('bot1', 100, 1, 'completed', '[]', 'telegram')
         RETURNING id`,
      )
      .get() as { id: number };

    const rTelegram = await fetch(`${h.base}/v1/turns/${row.id}`, {
      headers: { Authorization: `Bearer ${attackerSecret}` },
    });
    const rNonexistent = await fetch(`${h.base}/v1/turns/9999999`, {
      headers: { Authorization: `Bearer ${attackerSecret}` },
    });

    expect(rTelegram.status).toBe(404);
    expect(rNonexistent.status).toBe(404);
    expect(await rTelegram.text()).toBe(await rNonexistent.text());
  });

  test("wrong-token against an existing id produces same body as nonexistent-id with valid token", async () => {
    h = startHarness({ tokens: [attacker, victim] });

    const turnId = h.db.insertAskTurn({
      botId: "bot1",
      tokenName: "victim",
      sessionId: "v-session-2",
      textPreview: "secret",
      attachmentPaths: [],
    });

    // Attacker guesses the id with their own valid token.
    const rAttacker = await fetch(`${h.base}/v1/turns/${turnId}`, {
      headers: { Authorization: `Bearer ${attackerSecret}` },
    });
    // Valid victim token against a genuinely nonexistent id.
    const rNonexistent = await fetch(`${h.base}/v1/turns/99999999`, {
      headers: { Authorization: `Bearer ${victimSecret}` },
    });

    expect(rAttacker.status).toBe(404);
    expect(rNonexistent.status).toBe(404);
    expect(await rAttacker.text()).toBe(await rNonexistent.text());
  });

  test("malformed turn_id also returns 404 turn_not_found (same body)", async () => {
    h = startHarness({ tokens: [attacker] });

    const rValid = await fetch(`${h.base}/v1/turns/9999999`, {
      headers: { Authorization: `Bearer ${attackerSecret}` },
    });
    const rMalformed = await fetch(`${h.base}/v1/turns/not-a-number`, {
      headers: { Authorization: `Bearer ${attackerSecret}` },
    });

    expect(rValid.status).toBe(404);
    expect(rMalformed.status).toBe(404);
    // Both should produce turn_not_found; exact body bytes may differ
    // slightly if there's path-param encoding — assert the error code
    // equivalence, not the byte-equivalence.
    expect((await rValid.json()).error).toBe("turn_not_found");
    expect((await rMalformed.json()).error).toBe("turn_not_found");
  });

  test("malformed / out-of-range / valid-not-yours all hit the DB lookup", async () => {
    // Timing-uniformity invariant: every 404 path must take the DB
    // round-trip, otherwise the malformed branch is fast-pathed and an
    // attacker can distinguish "id you don't own" from "id that can't
    // exist" by latency. Hard to assert wall-clock timing reliably, so
    // we instead spy on getTurnExtended and require it was called for
    // every authenticated 404 case.
    h = startHarness({ tokens: [attacker, victim] });

    const lookupCalls: unknown[] = [];
    const origLookup = h.db.getTurnExtended.bind(h.db);
    h.db.getTurnExtended = (id: number) => {
      lookupCalls.push(id);
      return origLookup(id);
    };

    // (a) Valid integer id owned by another caller.
    const victimTurnId = h.db.insertAskTurn({
      botId: "bot1",
      tokenName: "victim",
      sessionId: "v-sess-spy",
      textPreview: "secret",
      attachmentPaths: [],
    });
    // Reset the spy after the insert (which doesn't go through getTurnExtended,
    // but be defensive in case future helpers do).
    lookupCalls.length = 0;

    const rValidNotYours = await fetch(`${h.base}/v1/turns/${victimTurnId}`, {
      headers: { Authorization: `Bearer ${attackerSecret}` },
    });

    // (b) Out-of-range valid integer (no row will match).
    const rOutOfRange = await fetch(`${h.base}/v1/turns/9999999999`, {
      headers: { Authorization: `Bearer ${attackerSecret}` },
    });

    // (c) Malformed (non-integer) id.
    const rMalformed = await fetch(`${h.base}/v1/turns/not-a-number`, {
      headers: { Authorization: `Bearer ${attackerSecret}` },
    });

    // (d) Negative integer id.
    const rNegative = await fetch(`${h.base}/v1/turns/-1`, {
      headers: { Authorization: `Bearer ${attackerSecret}` },
    });

    // All four should look identical to a caller.
    expect(rValidNotYours.status).toBe(404);
    expect(rOutOfRange.status).toBe(404);
    expect(rMalformed.status).toBe(404);
    expect(rNegative.status).toBe(404);

    const bodies = await Promise.all([
      rValidNotYours.text(),
      rOutOfRange.text(),
      rMalformed.text(),
      rNegative.text(),
    ]);
    // Byte-identical bodies — no leak of which branch produced the 404.
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!).error).toBe("turn_not_found");

    // The DB was queried in all four cases. This is the timing-
    // uniformity guarantee — every authenticated 404 path takes the
    // round-trip, not just the ones with a syntactically valid id.
    expect(lookupCalls.length).toBe(4);
    // Malformed / negative coerce to 0 (or any sentinel that misses);
    // the only requirement is the lookup was issued at all.
    expect(lookupCalls).toContain(victimTurnId);
    expect(lookupCalls).toContain(9999999999);
  });
});
