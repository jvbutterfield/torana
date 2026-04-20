// Config-loader coverage for the `agent_api` block (PRD US-001).
//
// The other config tests (test/config/load.test.ts) only exercise the legacy
// surface — they don't touch tokens, side-session caps, or the secret-set
// integration. This file fills those gaps.
//
// Specifically we pin:
//   - SHA-256 hash is computed at load time and the raw secret is added to
//     the redaction set (collectSecrets).
//   - Literal-token (non-${VAR}) `secret_ref` emits a warning.
//   - `agent_api.enabled=true` with no tokens emits a warning.
//   - `agent_api.tokens` with `enabled=false` emits a (different) warning.
//   - All `superRefine` failures: duplicate token name, unknown bot id,
//     idle_ttl > hard_ttl, max_per_bot > max_global,
//     default_timeout_ms > max_timeout_ms, empty `scopes`, scopes
//     containing an unknown value, `bot_ids` empty.
//   - Default values land when the block is omitted entirely
//     (PRD line 48 — agent_api.enabled defaults to false).

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { loadConfigFromString, ConfigLoadError } from "../../src/config/load.js";

const BASE = `
version: 1
gateway:
  port: 3000
  data_dir: /tmp/torana-test
transport:
  default_mode: polling
access_control:
  allowed_user_ids: [111]
bots:
  - id: alpha
    token: BOTTOK:AAAAAA
    runner:
      type: claude-code
      cli_path: claude
`;

function withAgentApi(block: string): string {
  return BASE + "\nagent_api:\n" + block;
}

describe("config/load — agent_api defaults + token resolution", () => {
  test("omitting the block leaves agent_api.enabled at false (PRD line 48)", () => {
    const { config, agentApiTokens, warnings } = loadConfigFromString(BASE);
    expect(config.agent_api.enabled).toBe(false);
    expect(agentApiTokens).toEqual([]);
    expect(warnings.filter((w) => w.includes("agent_api"))).toEqual([]);
  });

  test("hashes secret_ref at load and includes it in the redaction set", () => {
    const raw = withAgentApi(`
  enabled: true
  tokens:
    - name: cos
      secret_ref: \${COS_SECRET}
      bot_ids: [alpha]
      scopes: [ask]
`);
    const { agentApiTokens, secrets } = loadConfigFromString(raw, {
      env: { COS_SECRET: "supersecret-value-123" },
    });
    expect(agentApiTokens).toHaveLength(1);
    const tok = agentApiTokens[0]!;
    expect(tok.name).toBe("cos");
    expect(tok.secret).toBe("supersecret-value-123");
    expect(tok.bot_ids).toEqual(["alpha"]);
    expect(tok.scopes).toEqual(["ask"]);
    // SHA-256 of the secret bytes — caller can recompute and compare.
    const expectedHash = new Uint8Array(
      createHash("sha256").update("supersecret-value-123", "utf8").digest(),
    );
    expect([...tok.hash]).toEqual([...expectedHash]);
    // The raw secret is in the redaction set so structured logs scrub it.
    expect(secrets).toContain("supersecret-value-123");
  });

  test("literal (non-${VAR}) secret_ref emits a warning", () => {
    const raw = withAgentApi(`
  enabled: true
  tokens:
    - name: literal
      secret_ref: this-is-literal-not-an-env-ref
      bot_ids: [alpha]
      scopes: [ask]
`);
    const { warnings } = loadConfigFromString(raw);
    const literal = warnings.find((w) =>
      w.includes("secret_ref looks like a literal"),
    );
    expect(literal).toBeDefined();
    expect(literal!).toContain("literal");
  });

  test("enabled=true with no tokens emits a warning", () => {
    const raw = withAgentApi(`
  enabled: true
  tokens: []
`);
    const { warnings } = loadConfigFromString(raw);
    expect(warnings.some((w) => w.includes("no tokens defined"))).toBe(true);
  });

  test("enabled=false with tokens emits a different warning (tokens are inert)", () => {
    const raw = withAgentApi(`
  enabled: false
  tokens:
    - name: cos
      secret_ref: \${T}
      bot_ids: [alpha]
      scopes: [ask]
`);
    const { warnings } = loadConfigFromString(raw, { env: { T: "abcdef" } });
    expect(warnings.some((w) => w.includes("tokens are inert"))).toBe(true);
  });
});

describe("config/load — agent_api superRefine error paths", () => {
  test("duplicate token name → fails", () => {
    const raw = withAgentApi(`
  enabled: true
  tokens:
    - name: dup
      secret_ref: \${A}
      bot_ids: [alpha]
      scopes: [ask]
    - name: dup
      secret_ref: \${B}
      bot_ids: [alpha]
      scopes: [inject]
`);
    expect(() =>
      loadConfigFromString(raw, { env: { A: "secret-a-1234", B: "secret-b-1234" } }),
    ).toThrow(/duplicate agent_api token name/);
  });

  test("token bot_ids references unknown bot → fails", () => {
    const raw = withAgentApi(`
  enabled: true
  tokens:
    - name: cos
      secret_ref: \${T}
      bot_ids: [no-such-bot]
      scopes: [ask]
`);
    expect(() =>
      loadConfigFromString(raw, { env: { T: "abcdef" } }),
    ).toThrow(/unknown bot 'no-such-bot'/);
  });

  test("scopes empty → fails (PRD: 'non-empty subset of [ask, inject]')", () => {
    const raw = withAgentApi(`
  enabled: true
  tokens:
    - name: cos
      secret_ref: \${T}
      bot_ids: [alpha]
      scopes: []
`);
    expect(() =>
      loadConfigFromString(raw, { env: { T: "abcdef" } }),
    ).toThrow(ConfigLoadError);
  });

  test("scopes contains unknown value → fails", () => {
    const raw = withAgentApi(`
  enabled: true
  tokens:
    - name: cos
      secret_ref: \${T}
      bot_ids: [alpha]
      scopes: [admin]
`);
    expect(() =>
      loadConfigFromString(raw, { env: { T: "abcdef" } }),
    ).toThrow(ConfigLoadError);
  });

  test("bot_ids empty → fails", () => {
    const raw = withAgentApi(`
  enabled: true
  tokens:
    - name: cos
      secret_ref: \${T}
      bot_ids: []
      scopes: [ask]
`);
    expect(() =>
      loadConfigFromString(raw, { env: { T: "abcdef" } }),
    ).toThrow(ConfigLoadError);
  });

  test("idle_ttl_ms > hard_ttl_ms → fails", () => {
    const raw = withAgentApi(`
  enabled: true
  tokens: []
  side_sessions:
    idle_ttl_ms: 10000
    hard_ttl_ms: 5000
`);
    expect(() => loadConfigFromString(raw)).toThrow(/idle_ttl_ms must be <= hard_ttl_ms/);
  });

  test("max_per_bot > max_global → fails", () => {
    const raw = withAgentApi(`
  enabled: true
  tokens: []
  side_sessions:
    max_per_bot: 100
    max_global: 10
`);
    expect(() => loadConfigFromString(raw)).toThrow(/max_per_bot must be <= max_global/);
  });

  test("default_timeout_ms > max_timeout_ms → fails", () => {
    const raw = withAgentApi(`
  enabled: true
  tokens: []
  ask:
    default_timeout_ms: 600000
    max_timeout_ms: 300000
`);
    expect(() =>
      loadConfigFromString(raw),
    ).toThrow(/default_timeout_ms must be <= max_timeout_ms/);
  });
});

describe("config/load — agent_api: secrets redaction integration", () => {
  test("multiple distinct token secrets all land in the redaction set", () => {
    const raw = withAgentApi(`
  enabled: true
  tokens:
    - name: cos
      secret_ref: \${COS}
      bot_ids: [alpha]
      scopes: [ask]
    - name: cal
      secret_ref: \${CAL}
      bot_ids: [alpha]
      scopes: [inject]
`);
    const { secrets } = loadConfigFromString(raw, {
      env: { COS: "secret-cos-12345", CAL: "secret-cal-67890" },
    });
    expect(secrets).toContain("secret-cos-12345");
    expect(secrets).toContain("secret-cal-67890");
  });

  test("the bot token and the agent_api tokens are both in the redaction set", () => {
    const raw = withAgentApi(`
  enabled: true
  tokens:
    - name: cos
      secret_ref: \${COS}
      bot_ids: [alpha]
      scopes: [ask]
`);
    const { secrets } = loadConfigFromString(raw, {
      env: { COS: "agent-api-secret-12345" },
    });
    expect(secrets).toContain("BOTTOK:AAAAAA");
    expect(secrets).toContain("agent-api-secret-12345");
  });
});
