// makeTestBot factory — lets each test pick its own bot cardinality.

import type {
  BotConfig,
  Config,
  ClaudeCodeRunnerConfig,
} from "../../src/config/schema.js";

export function makeTestBotConfig(
  id: string,
  overrides: Partial<BotConfig> = {},
): BotConfig {
  const base: BotConfig = {
    id,
    token: `TEST_TOKEN_${id.toUpperCase()}:AAAAAAAAAAAAAAAAAAAAAAAAA`,
    commands: [],
    reactions: { received_emoji: "👀" },
    runner: defaultRunner(),
  };
  return { ...base, ...overrides };
}

function defaultRunner(): ClaudeCodeRunnerConfig {
  return {
    type: "claude-code",
    cli_path: "claude",
    args: [],
    env: {},
    pass_continue_flag: true,
    // Required by schema (the runner always runs unsandboxed in cwd).
    acknowledge_dangerous: true,
  };
}

export function makeTestConfig(
  bots: BotConfig[],
  overrides: Partial<Config> = {},
): Config {
  const base: Config = {
    version: 1,
    gateway: {
      port: 3000,
      bind_host: "127.0.0.1",
      data_dir: "/tmp/torana-test",
      db_path: "/tmp/torana-test/gateway.db",
      log_level: "info",
    },
    telegram: { api_base_url: "https://api.telegram.org" },
    transport: {
      default_mode: "polling",
      allowed_updates: ["message"],
      polling: {
        timeout_secs: 25,
        backoff_base_ms: 1000,
        backoff_cap_ms: 30_000,
        max_updates_per_batch: 100,
      },
    },
    access_control: {
      allowed_user_ids: [111_222_333],
    },
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
    shutdown: {
      outbox_drain_secs: 10,
      runner_grace_secs: 5,
      hard_timeout_secs: 25,
    },
    dashboard: {
      enabled: false,
      mount_path: "/dashboard",
      allow_non_loopback_proxy_target: false,
    },
    metrics: { enabled: false },
    attachments: {
      max_bytes: 20 * 1024 * 1024,
      max_per_turn: 10,
      retention_secs: 86_400,
      disk_usage_cap_bytes: 1024 * 1024 * 1024,
    },
    agent_api: {
      enabled: false,
      tokens: [],
      side_sessions: {
        idle_ttl_ms: 3_600_000,
        hard_ttl_ms: 86_400_000,
        max_per_bot: 8,
        max_global: 64,
      },
      send: {
        max_body_bytes: 100 * 1024 * 1024,
        idempotency_retention_ms: 86_400_000,
      },
      ask: {
        default_timeout_ms: 60_000,
        max_timeout_ms: 300_000,
        max_body_bytes: 100 * 1024 * 1024,
        max_files_per_request: 10,
      },
      expose_runner_type: false,
    },
    bots,
  };
  return { ...base, ...overrides };
}
