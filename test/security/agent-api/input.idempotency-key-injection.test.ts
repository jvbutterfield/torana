// §12.5.3: the Idempotency-Key header is constrained to
// `^[A-Za-z0-9_-]{16,128}$`. Whitespace, control chars, HTTP header
// injection attempts (CR/LF), and non-ASCII must 400.

import { afterEach, describe, expect, test } from "bun:test";

import { mkToken, startHarness, type Harness } from "./_harness.js";
import { validateIdempotencyKey } from "../../../src/agent-api/schemas.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.3 input.idempotency-key-injection (unit-level — fetch drops ctrl chars)", () => {
  // fetch() in Bun will silently reject/strip headers containing
  // invalid characters (CR/LF/NUL), so we validate the invariant at
  // the function level where the regex actually runs. This is the
  // authoritative check — the HTTP-level test below exercises the
  // one attack class that actually reaches us (over-long keys,
  // illegal printable chars).

  const badUnit = [
    "too-short", // <16
    "a".repeat(129), // >128
    "has space inside this key here and padding",
    "has\ttabinsidethiskeyherepaddingbeyond16",
    "unicodéchárfullofutf8thingsthirtytwo12",
    "dots.are.not.allowed.dotsaredotsdotsdots",
    "slash/not/allowed/butfillerenough1234567",
    "!@#$%^&*()_-+=allofthesefillstofix161718",
  ];
  // Empty-string is handled as missing_idempotency_key (the falsiness
  // branch fires first) — see the next test.

  test.each(badUnit)("validateIdempotencyKey(%p) rejects as invalid_idempotency_key", (key) => {
    const r = validateIdempotencyKey(key);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_idempotency_key");
  });

  test("missing key → missing_idempotency_key (not invalid)", () => {
    const r = validateIdempotencyKey(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_idempotency_key");
  });

  test("empty-string key → missing_idempotency_key (falsiness branch beats regex branch)", () => {
    // The validator's first check is a truthy-test on the key, so ""
    // becomes missing, not invalid. This is a deliberate design
    // choice — an empty header is semantically "absent", not
    // "malformed".
    const r = validateIdempotencyKey("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_idempotency_key");
  });

  test("well-formed key passes", () => {
    const r = validateIdempotencyKey("aB-_0123456789abcdef");
    expect(r.ok).toBe(true);
  });
});

describe("§12.5.3 input.idempotency-key-injection (HTTP-level)", () => {
  const secret = "idem-key-secret-value-abcd12345";
  const token = mkToken("cos", secret, { scopes: ["inject"] });

  test("POST /v1/bots/:id/inject with no Idempotency-Key → 400 missing_idempotency_key", async () => {
    h = startHarness({ tokens: [token] });
    const r = await fetch(`${h.base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi", source: "test", user_id: "123" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("missing_idempotency_key");
  });

  test("POST with a too-short Idempotency-Key → 400 invalid_idempotency_key", async () => {
    h = startHarness({ tokens: [token] });
    const r = await fetch(`${h.base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": "too-short",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi", source: "test", user_id: "123" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_idempotency_key");
  });

  test("POST with a too-long Idempotency-Key → 400 invalid_idempotency_key", async () => {
    h = startHarness({ tokens: [token] });
    const r = await fetch(`${h.base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": "a".repeat(200),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi", source: "test", user_id: "123" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_idempotency_key");
  });

  test("POST with a key containing illegal but fetch-legal chars → 400 invalid_idempotency_key", async () => {
    h = startHarness({ tokens: [token] });
    const r = await fetch(`${h.base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": "has.dots.and.punct.here.lots.of.filler.to.make.length.ok",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi", source: "test", user_id: "123" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_idempotency_key");
  });
});
