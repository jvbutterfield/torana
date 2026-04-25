// §12.5.1: Authorization header with a non-Bearer scheme → 401 missing_auth.
// The auth parser is deliberately strict about the scheme keyword — any
// mismatched prefix is treated as "no valid bearer header" (not as an
// "invalid_token" response, which would leak that a bearer scheme exists).

import { afterEach, describe, expect, test } from "bun:test";

import { startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.1 auth.wrong-scheme", () => {
  const schemes = [
    "Basic dXNlcjpwYXNz",
    'Digest username="admin"',
    "Token abcdef",
    "APIKey xyz123",
    "OAuth oauth_token=abc",
    'Hawk id="dh37"',
    "Bearer", // bearer with no token
    "  Bearer  ", // bearer-like with no token
  ];

  test.each(schemes)("scheme %p → 401 missing_auth", async (auth) => {
    h = startHarness();
    const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: auth },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("missing_auth");
  });

  test("even when scheme is 'Bearer' but missing space + token, → 401 missing_auth", async () => {
    h = startHarness();
    const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: "BearerABC" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("missing_auth");
  });
});
