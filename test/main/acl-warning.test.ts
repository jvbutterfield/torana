// warnOnEmptyAcl emits a WARN when access_control.allowed_user_ids is empty.
// Empty-list = default-deny is a valid (if unusual) stance, so this must NOT
// be fatal — just a signal to the operator that they've wired up a gateway
// that will drop every inbound message.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { warnOnEmptyAcl } from "../../src/main.js";
import type { Config } from "../../src/config/schema.js";

type LogLine = { level: string; message: string; fields?: Record<string, unknown> };

function captureLogs(): { lines: LogLine[]; restore: () => void } {
  const lines: LogLine[] = [];
  const originalLog = console.log;
  const originalErr = console.error;
  const push = (raw: string): void => {
    try {
      const parsed = JSON.parse(raw);
      lines.push({ level: parsed.level, message: parsed.msg, fields: { ...parsed } });
    } catch {
      lines.push({ level: "raw", message: raw });
    }
  };
  console.log = (arg: unknown) => push(typeof arg === "string" ? arg : String(arg));
  console.error = (arg: unknown) => push(typeof arg === "string" ? arg : String(arg));
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.error = originalErr;
    },
  };
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    gateway: {
      port: 3000,
      data_dir: "/tmp/torana-acl-test",
      db_path: "/tmp/torana-acl-test/gateway.db",
      log_level: "info",
    },
    telegram: { api_base_url: "https://api.telegram.org" },
    transport: {
      default_mode: "polling",
      allowed_updates: ["message"],
      polling: {
        timeout_secs: 25,
        backoff_base_ms: 1000,
        backoff_cap_ms: 30000,
        max_updates_per_batch: 100,
      },
    },
    access_control: { allowed_user_ids: [] },
    worker_tuning: {
      startup_timeout_secs: 60,
      stall_timeout_secs: 90,
      turn_timeout_secs: 1200,
      crash_loop_backoff_base_ms: 5000,
      crash_loop_backoff_cap_ms: 300_000,
      max_consecutive_failures: 10,
    },
    streaming: {
      edit_cadence_ms: 1500,
      message_length_limit: 4096,
      message_length_safe_margin: 3800,
    },
    outbox: { max_attempts: 5, retry_base_ms: 2000 },
    shutdown: { outbox_drain_secs: 10, runner_grace_secs: 5, hard_timeout_secs: 25 },
    dashboard: { enabled: false, mount_path: "/dashboard" },
    metrics: { enabled: false },
    attachments: {
      max_bytes: 20 * 1024 * 1024,
      max_per_turn: 10,
      retention_secs: 86_400,
      disk_usage_cap_bytes: 1024 * 1024 * 1024,
    },
    bots: [
      {
        id: "alpha",
        token: "T",
        commands: [],
        reactions: { received_emoji: "👀" },
        runner: { type: "claude-code", cli_path: "claude", args: [], env: {}, pass_continue_flag: true },
      },
    ],
    ...overrides,
  } as Config;
}

describe("warnOnEmptyAcl", () => {
  let captured: ReturnType<typeof captureLogs>;
  beforeEach(() => {
    captured = captureLogs();
  });
  afterEach(() => {
    captured.restore();
  });

  test("logs a WARN when the global list is empty and no bot overrides", () => {
    warnOnEmptyAcl(baseConfig());
    const warn = captured.lines.find((l) => l.level === "warn");
    expect(warn?.message).toMatch(/access_control\.allowed_user_ids is empty/);
  });

  test("stays silent when the global list is populated", () => {
    warnOnEmptyAcl(
      baseConfig({ access_control: { allowed_user_ids: [42] } }),
    );
    expect(captured.lines.find((l) => l.level === "warn")).toBeUndefined();
  });

  test("stays silent when every bot overrides with a non-empty list", () => {
    const cfg = baseConfig();
    cfg.bots[0].access_control = { allowed_user_ids: [42] };
    warnOnEmptyAcl(cfg);
    expect(captured.lines.find((l) => l.level === "warn")).toBeUndefined();
  });

  test("warns for subset when only some bots are affected", () => {
    const cfg = baseConfig({ access_control: { allowed_user_ids: [1] } });
    cfg.bots.push({
      id: "beta",
      token: "T2",
      access_control: { allowed_user_ids: [] },
      commands: [],
      reactions: { received_emoji: "👀" },
      runner: { type: "claude-code", cli_path: "claude", args: [], env: {}, pass_continue_flag: true },
    } as Config["bots"][number]);
    warnOnEmptyAcl(cfg);
    const warn = captured.lines.find((l) => l.level === "warn");
    expect(warn?.message).toMatch(/empty for some bots/);
    expect(warn?.fields?.bots).toEqual(["beta"]);
  });
});
