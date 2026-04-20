// §12.5.1: POST without Authorization → 401 missing_auth.
// Body must NOT contain "Bearer" — discovered error messages sometimes
// include the phrase "Bearer token required"; we want to be deliberate
// about *not* telling attackers that bearer is the accepted scheme.

import { afterEach, describe, expect, test } from "bun:test";

import { startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.1 auth.no-header", () => {
  test("POST /v1/bots/:id/ask without header → 401 missing_auth", async () => {
    h = startHarness();
    const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.error).toBe("missing_auth");
  });

  test("response body does not contain the word 'Bearer'", async () => {
    h = startHarness();
    const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    const text = await r.text();
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("bearer");
    expect(text).not.toMatch(/WWW-Authenticate/i);
  });

  test("WWW-Authenticate header is NOT set (no scheme disclosure)", async () => {
    h = startHarness();
    const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.headers.get("www-authenticate")).toBeNull();
  });

  test("GET /v1/turns/:id without header → 401 missing_auth (same shape)", async () => {
    h = startHarness();
    const r = await fetch(`${h.base}/v1/turns/123`);
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("missing_auth");
  });
});
