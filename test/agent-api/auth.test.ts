import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { authenticate, authorize } from "../../src/agent-api/auth.js";
import type { ResolvedAgentApiToken } from "../../src/config/load.js";

function mkToken(
  name: string,
  secret: string,
  overrides: Partial<ResolvedAgentApiToken> = {},
): ResolvedAgentApiToken {
  const hash = new Uint8Array(
    createHash("sha256").update(secret, "utf8").digest(),
  );
  return {
    name,
    secret,
    hash,
    bot_ids: ["bot1"],
    scopes: ["ask"],
    ...overrides,
  };
}

describe("agent-api/auth: authenticate", () => {
  const tokens = [
    mkToken("cos", "s3cret-cos-value-1234"),
    mkToken("cal", "s3cret-cal-value-5678"),
  ];

  test("null header → missing_auth", () => {
    const r = authenticate(tokens, null);
    expect(r).toEqual({ kind: "missing_auth" });
  });

  test("non-bearer → missing_auth", () => {
    expect(authenticate(tokens, "Basic abc")).toEqual({ kind: "missing_auth" });
    expect(authenticate(tokens, "Bearer")).toEqual({ kind: "missing_auth" });
  });

  test("wrong secret → invalid_token", () => {
    expect(authenticate(tokens, "Bearer nope")).toEqual({
      kind: "invalid_token",
    });
  });

  test("correct secret → token", () => {
    const r = authenticate(tokens, "Bearer s3cret-cos-value-1234");
    expect("token" in r).toBe(true);
    if ("token" in r) expect(r.token.name).toBe("cos");
  });

  test("header case-insensitive scheme", () => {
    const r = authenticate(tokens, "bearer s3cret-cos-value-1234");
    expect("token" in r).toBe(true);
  });
});

describe("agent-api/auth: authorize", () => {
  const token = mkToken("cos", "s3cret", {
    bot_ids: ["bot1"],
    scopes: ["ask"],
  });

  test("wrong bot → bot_not_permitted", () => {
    expect(authorize(token, "bot2", "ask")).toEqual({
      kind: "bot_not_permitted",
      botId: "bot2",
    });
  });

  test("wrong scope → scope_not_permitted", () => {
    expect(authorize(token, "bot1", "send")).toEqual({
      kind: "scope_not_permitted",
      scope: "send",
    });
  });

  test("ok → null", () => {
    expect(authorize(token, "bot1", "ask")).toBeNull();
  });
});
