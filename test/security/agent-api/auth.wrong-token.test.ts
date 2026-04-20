// §12.5.1: Bearer + unknown token → 401 invalid_token.
// The submitted token must NEVER appear in the response body. Some
// auth libraries helpfully echo the token in the error message; ours
// must not. We test with a distinctive sentinel string so grep-style
// assertions are deterministic.

import { afterEach, describe, expect, test } from "bun:test";

import { mkToken, startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.1 auth.wrong-token", () => {
  const goodSecret = "real-secret-value-abcdef1234";
  const goodToken = mkToken("cos", goodSecret);
  const attackerSecret = "NEEDLE-IN-HAYSTACK-XX8vN7q2mQ";

  test("wrong Bearer token → 401 invalid_token", async () => {
    h = startHarness({ tokens: [goodToken] });
    const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${attackerSecret}` },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("invalid_token");
  });

  test("response body does NOT echo the submitted token (disclosure guard)", async () => {
    h = startHarness({ tokens: [goodToken] });
    const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${attackerSecret}` },
      body: JSON.stringify({ text: "hi" }),
    });
    const body = await r.text();
    expect(body).not.toContain(attackerSecret);
    expect(body).not.toContain(attackerSecret.slice(0, 8));
    expect(body).not.toContain("NEEDLE");
  });

  test("response body also does NOT leak the real configured token", async () => {
    // Defence-in-depth: even on a wrong-token 401, the response must not
    // mention any configured token. Tests with an obviously-distinctive
    // real secret so grep has low false-positive risk.
    h = startHarness({ tokens: [goodToken] });
    const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${attackerSecret}` },
      body: JSON.stringify({ text: "hi" }),
    });
    const body = await r.text();
    expect(body).not.toContain(goodSecret);
    expect(body).not.toContain(goodToken.name);
  });

  test("response shape is exactly {error, message} — no extra leaky fields", async () => {
    h = startHarness({ tokens: [goodToken] });
    const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${attackerSecret}` },
      body: JSON.stringify({ text: "hi" }),
    });
    const body = await r.json();
    expect(Object.keys(body).sort()).toEqual(["error", "message"]);
  });
});
