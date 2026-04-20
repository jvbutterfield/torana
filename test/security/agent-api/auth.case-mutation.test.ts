// §12.5.1: HTTP header names are case-insensitive (RFC 7230 §3.2). The
// auth layer must accept Authorization, authorization, AuThOrIzAtIoN,
// etc. This is defensive coverage against someone accidentally using
// case-sensitive header-reading in a refactor.
//
// The scheme keyword ("Bearer") is ALSO accepted case-insensitively —
// see src/agent-api/auth.ts's BEARER_RE (/^Bearer\s+(.+)$/i). We pin
// both properties here so case-handling regressions show up loud.

import { afterEach, describe, expect, test } from "bun:test";

import { mkToken, startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.1 auth.case-mutation", () => {
  const secret = "real-secret-value-casemut-1234";
  const token = mkToken("cos", secret);

  const headerCases = [
    "Authorization",
    "authorization",
    "AUTHORIZATION",
    "AuThOrIzAtIoN",
  ];

  test.each(headerCases)("header case %p is accepted", async (headerName) => {
    h = startHarness({ tokens: [token] });
    const r = await fetch(`${h.base}/v1/bots`, {
      method: "GET",
      headers: { [headerName]: `Bearer ${secret}` },
    });
    // If the header is read correctly, we reach handleListBots and get 200.
    // If the header is missed, we'd get 401 missing_auth.
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.bots)).toBe(true);
  });

  const schemeCases = ["Bearer", "bearer", "BEARER", "BeArEr"];

  test.each(schemeCases)("Bearer scheme case %p is accepted", async (scheme) => {
    h = startHarness({ tokens: [token] });
    const r = await fetch(`${h.base}/v1/bots`, {
      method: "GET",
      headers: { Authorization: `${scheme} ${secret}` },
    });
    expect(r.status).toBe(200);
  });
});
