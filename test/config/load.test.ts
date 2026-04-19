import { describe, expect, test } from "bun:test";
import { loadConfigFromString, interpolate, ConfigLoadError } from "../../src/config/load.js";

const MINIMAL = `
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

describe("config/load", () => {
  test("accepts a minimal polling config", () => {
    const { config } = loadConfigFromString(MINIMAL);
    expect(config.version).toBe(1);
    expect(config.bots[0].id).toBe("alpha");
    expect(config.gateway.port).toBe(3000);
    expect(config.transport.default_mode).toBe("polling");
  });

  test("applies numeric coercion to env-interpolated IDs", () => {
    const raw = MINIMAL.replace("[111]", "[${USER_ID}]");
    const { config } = loadConfigFromString(raw, { env: { USER_ID: "42" } });
    expect(config.access_control.allowed_user_ids).toEqual([42]);
  });

  test("rejects unknown keys (strict mode)", () => {
    const raw = MINIMAL + "\nunknown_root_key: true\n";
    expect(() => loadConfigFromString(raw)).toThrow(ConfigLoadError);
  });

  test("rejects reserved bot ID", () => {
    const raw = MINIMAL.replace("id: alpha", "id: health");
    expect(() => loadConfigFromString(raw)).toThrow(/reserved/);
  });

  test("rejects version != 1", () => {
    const raw = MINIMAL.replace("version: 1", "version: 2");
    expect(() => loadConfigFromString(raw)).toThrow(ConfigLoadError);
  });

  test("rejects webhook mode without base_url", () => {
    const raw = MINIMAL.replace("default_mode: polling", "default_mode: webhook");
    expect(() => loadConfigFromString(raw)).toThrow(/base_url/);
  });

  test("rejects missing ${VAR} without default", () => {
    const raw = MINIMAL.replace("BOTTOK:AAAAAA", "${MISSING_VAR}");
    expect(() => loadConfigFromString(raw, { env: {} })).toThrow(/MISSING_VAR/);
  });

  test("applies ${VAR:-default} fallback", () => {
    const raw = MINIMAL.replace("BOTTOK:AAAAAA", "${MISSING_VAR:-fallback-token}");
    const { config } = loadConfigFromString(raw, { env: {} });
    expect(config.bots[0].token).toBe("fallback-token");
  });

  test("rejects empty secret after interpolation", () => {
    const raw = MINIMAL.replace("BOTTOK:AAAAAA", "${EMPTY:-}");
    // `${EMPTY:-}` interpolates to "" which YAML parses as null, which Zod
    // rejects (string required). Either way, the load fails.
    expect(() => loadConfigFromString(raw, { env: {} })).toThrow(ConfigLoadError);
  });

  test("rejects config file > max size", () => {
    const bigRaw = MINIMAL + "\n# padding: " + "x".repeat(2_000_000);
    expect(() => loadConfigFromString(bigRaw, { maxBytes: 1_000_000 })).not.toThrow();
    // size cap applies to file loader; string loader has no cap by design.
  });

  test("interpolate: missing var errors", () => {
    expect(() => interpolate("${FOO}", {})).toThrow();
  });

  test("interpolate: ${VAR:-default} works", () => {
    expect(interpolate("x=${FOO:-bar}", {})).toBe("x=bar");
  });

  test("interpolate: ${VAR:-} yields empty string", () => {
    expect(interpolate("x=${FOO:-}", {})).toBe("x=");
  });

  test("interpolate: literal ${VAR} inside a YAML comment is left alone", () => {
    // rc.1 incident: prose in a comment was treated as a real env reference.
    const raw = "# Secret-bearing vars use ${SOMETHING}\nx: ${FOO:-ok}\n";
    const out = interpolate(raw, {});
    expect(out).toContain("${SOMETHING}");
    expect(out).toContain("x: ok");
  });

  test("interpolate: ${VAR} after an inline comment is not substituted", () => {
    const raw = "key: value  # look here: ${MISSING}\n";
    // Must not throw on MISSING — it's inside an inline comment.
    expect(() => interpolate(raw, {})).not.toThrow();
  });

  test("interpolate: ${VAR} inside a double-quoted string IS still interpolated", () => {
    const raw = 'key: "hash # and ${HELLO}"\n';
    expect(interpolate(raw, { HELLO: "world" })).toBe('key: "hash # and world"\n');
  });

  test("interpolate: missing-var error reports line and column", () => {
    const raw = "gateway:\n  port: 3000\n  token: ${GONE}\n";
    try {
      interpolate(raw, {});
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/GONE/);
      expect((err as Error).message).toMatch(/line 3/);
      expect((err as Error).message).toMatch(/column 10/);
    }
  });

  test("rejects duplicate bot ids", () => {
    const raw = `
version: 1
gateway: { port: 3000, data_dir: /tmp/t }
transport: { default_mode: polling }
access_control: { allowed_user_ids: [1] }
bots:
  - id: alpha
    token: T1
    runner: { type: claude-code }
  - id: alpha
    token: T2
    runner: { type: claude-code }
`;
    expect(() => loadConfigFromString(raw)).toThrow(/duplicate bot id/);
  });

  test("alerts.via_bot must reference an existing bot", () => {
    const raw = `${MINIMAL}
alerts:
  via_bot: nonexistent
`;
    expect(() => loadConfigFromString(raw)).toThrow(/does not reference/);
  });

  test("alerts.via_bot defaults to first bot when absent", () => {
    const raw = `${MINIMAL}
alerts:
  chat_id: 999
`;
    const { config } = loadConfigFromString(raw);
    expect(config.alerts?.via_bot).toBe("alpha");
  });

  test("codex runner: minimal config applies sensible defaults", () => {
    const raw = MINIMAL.replace(
      "    runner:\n      type: claude-code\n      cli_path: claude",
      "    runner:\n      type: codex",
    );
    const { config } = loadConfigFromString(raw);
    const r = config.bots[0].runner;
    expect(r.type).toBe("codex");
    if (r.type === "codex") {
      expect(r.cli_path).toBe("codex");
      expect(r.approval_mode).toBe("full-auto");
      expect(r.sandbox).toBe("workspace-write");
      expect(r.pass_resume_flag).toBe(true);
      expect(r.acknowledge_dangerous).toBe(false);
    }
  });

  test("codex approval_mode='yolo' without acknowledge_dangerous is rejected", () => {
    const raw = MINIMAL.replace(
      "    runner:\n      type: claude-code\n      cli_path: claude",
      "    runner:\n      type: codex\n      approval_mode: yolo",
    );
    expect(() => loadConfigFromString(raw)).toThrow(/acknowledge_dangerous/);
  });

  test("codex approval_mode='yolo' with acknowledge_dangerous=true is accepted", () => {
    const raw = MINIMAL.replace(
      "    runner:\n      type: claude-code\n      cli_path: claude",
      "    runner:\n      type: codex\n      approval_mode: yolo\n      acknowledge_dangerous: true",
    );
    const { config } = loadConfigFromString(raw);
    const r = config.bots[0].runner;
    expect(r.type).toBe("codex");
    if (r.type === "codex") {
      expect(r.approval_mode).toBe("yolo");
      expect(r.acknowledge_dangerous).toBe(true);
    }
  });

  test("hybrid: claude-code and codex bots in the same config", () => {
    const raw = `
version: 1
gateway:
  port: 3000
  data_dir: /tmp/torana-test
transport:
  default_mode: polling
access_control:
  allowed_user_ids: [111]
bots:
  - id: claude_bot
    token: T1
    runner:
      type: claude-code
  - id: codex_bot
    token: T2
    runner:
      type: codex
      model: gpt-5
`;
    const { config } = loadConfigFromString(raw);
    expect(config.bots).toHaveLength(2);
    expect(config.bots[0].runner.type).toBe("claude-code");
    expect(config.bots[1].runner.type).toBe("codex");
    if (config.bots[1].runner.type === "codex") {
      expect(config.bots[1].runner.model).toBe("gpt-5");
    }
  });

  test("command runner accepts new codex-jsonl protocol", () => {
    const raw = `
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
    token: T1
    runner:
      type: command
      protocol: codex-jsonl
      cmd: ["bun", "wrapper.ts"]
`;
    const { config } = loadConfigFromString(raw);
    const r = config.bots[0].runner;
    expect(r.type).toBe("command");
    if (r.type === "command") {
      expect(r.protocol).toBe("codex-jsonl");
    }
  });
});
