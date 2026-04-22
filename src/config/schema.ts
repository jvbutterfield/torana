import { z } from "zod";

// ---------- primitives ----------

const reservedBotIds = new Set(["health", "metrics", "dashboard", "webhook"]);

export const BotIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/, "bot id must match ^[a-z][a-z0-9_-]{0,31}$")
  .refine((id) => !reservedBotIds.has(id), {
    message: `bot id is reserved (one of: ${[...reservedBotIds].join(", ")})`,
  });

const NonEmptyString = z.string().min(1, "must be non-empty after env interpolation");
const UrlString = z.string().url("must be a valid URL");
const PathString = z.string().min(1);

// Coerce env-interpolated strings into numbers. ${VAR} always yields a string.
const NumberCoerce = z.coerce.number();
const IntCoerce = z.coerce.number().int();
const BoolPermissive = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => (typeof v === "boolean" ? v : v === "true" || v === "1"));

// ---------- top-level sections ----------

export const GatewaySchema = z
  .object({
    port: IntCoerce.default(3000),
    data_dir: PathString,
    db_path: PathString.optional(),
    log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    log_format: z.enum(["json", "text"]).optional(),
  })
  .strict();

export const TelegramSchema = z
  .object({
    api_base_url: UrlString.default("https://api.telegram.org"),
  })
  .strict()
  .default({ api_base_url: "https://api.telegram.org" });

export const TransportWebhookSchema = z
  .object({
    base_url: UrlString.optional(),
    secret: NonEmptyString.optional(),
  })
  .strict();

export const TransportPollingSchema = z
  .object({
    timeout_secs: IntCoerce.min(1).max(60).default(25),
    backoff_base_ms: IntCoerce.default(1000),
    backoff_cap_ms: IntCoerce.default(30000),
    max_updates_per_batch: IntCoerce.min(1).max(100).default(100),
  })
  .strict()
  .default({
    timeout_secs: 25,
    backoff_base_ms: 1000,
    backoff_cap_ms: 30000,
    max_updates_per_batch: 100,
  });

export const TransportSchema = z
  .object({
    default_mode: z.enum(["webhook", "polling"]),
    allowed_updates: z.array(z.string()).default(["message"]),
    webhook: TransportWebhookSchema.optional(),
    polling: TransportPollingSchema,
  })
  .strict();

export const AccessControlSchema = z
  .object({
    allowed_user_ids: z.array(IntCoerce),
  })
  .strict();

export const AlertsSchema = z
  .object({
    chat_id: IntCoerce.optional(),
    via_bot: z.string().optional(),
    cooldown_ms: IntCoerce.default(600_000),
  })
  .strict();

export const WorkerTuningSchema = z
  .object({
    startup_timeout_secs: IntCoerce.default(60),
    stall_timeout_secs: IntCoerce.default(90),
    turn_timeout_secs: IntCoerce.default(1200),
    crash_loop_backoff_base_ms: IntCoerce.default(5000),
    crash_loop_backoff_cap_ms: IntCoerce.default(300_000),
    max_consecutive_failures: IntCoerce.default(10),
  })
  .strict()
  .default({
    startup_timeout_secs: 60,
    stall_timeout_secs: 90,
    turn_timeout_secs: 1200,
    crash_loop_backoff_base_ms: 5000,
    crash_loop_backoff_cap_ms: 300_000,
    max_consecutive_failures: 10,
  });

export const StreamingSchema = z
  .object({
    edit_cadence_ms: IntCoerce.default(1500),
    message_length_limit: IntCoerce.default(4096),
    message_length_safe_margin: IntCoerce.default(3800),
  })
  .strict()
  .default({
    edit_cadence_ms: 1500,
    message_length_limit: 4096,
    message_length_safe_margin: 3800,
  });

export const OutboxSchema = z
  .object({
    max_attempts: IntCoerce.default(5),
    retry_base_ms: IntCoerce.default(2000),
  })
  .strict()
  .default({ max_attempts: 5, retry_base_ms: 2000 });

export const ShutdownSchema = z
  .object({
    outbox_drain_secs: IntCoerce.default(10),
    runner_grace_secs: IntCoerce.default(5),
    hard_timeout_secs: IntCoerce.default(25),
  })
  .strict()
  .default({ outbox_drain_secs: 10, runner_grace_secs: 5, hard_timeout_secs: 25 });

export const DashboardSchema = z
  .object({
    enabled: BoolPermissive.default(false),
    proxy_target: UrlString.optional(),
    mount_path: z.string().default("/dashboard"),
  })
  .strict()
  .default({ enabled: false, mount_path: "/dashboard" })
  .refine((d) => !d.enabled || !!d.proxy_target, {
    message: "dashboard.proxy_target is required when dashboard.enabled is true",
    path: ["proxy_target"],
  });

export const MetricsSchema = z
  .object({
    enabled: BoolPermissive.default(false),
  })
  .strict()
  .default({ enabled: false });

export const AttachmentsSchema = z
  .object({
    max_bytes: IntCoerce.default(20 * 1024 * 1024),
    max_per_turn: IntCoerce.default(10),
    retention_secs: IntCoerce.default(86_400),
    disk_usage_cap_bytes: IntCoerce.default(1024 * 1024 * 1024),
  })
  .strict()
  .default({
    max_bytes: 20 * 1024 * 1024,
    max_per_turn: 10,
    retention_secs: 86_400,
    disk_usage_cap_bytes: 1024 * 1024 * 1024,
  });

// ---------- per-bot ----------

export const BotTransportOverrideSchema = z
  .object({
    mode: z.enum(["webhook", "polling"]),
  })
  .strict();

export const BotAccessControlSchema = z
  .object({
    allowed_user_ids: z.array(IntCoerce),
  })
  .strict();

export const BotCommandSchema = z
  .object({
    trigger: z.string().regex(/^\/[A-Za-z0-9_]+$/, "trigger must start with / and be alphanumeric"),
    action: z.enum(["builtin:reset", "builtin:status", "builtin:health"]),
  })
  .strict();

export const BotReactionsSchema = z
  .object({
    received_emoji: z.union([z.string(), z.null()]).default("👀"),
  })
  .strict()
  .default({ received_emoji: "👀" });

// Claude-Code runner
//
// Protocol-required flags (--print --output-format stream-json --input-format
// stream-json --include-partial-messages --replay-user-messages --verbose
// --dangerously-skip-permissions) are always applied by the runner and are
// NOT user-configurable — they are what makes torana able to parse the
// CLI's output. The `args` key is for USER extras (e.g. `--agent cato`)
// that get appended to the protocol flags.
export const ClaudeCodeRunnerSchema = z
  .object({
    type: z.literal("claude-code"),
    cli_path: z.string().default("claude"),
    args: z.array(z.string()).default([]),
    cwd: PathString.optional(),
    env: z.record(z.string(), z.string()).default({}),
    pass_continue_flag: BoolPermissive.default(true),
  })
  .strict();

// Codex runner
//
// Wraps the OpenAI Codex CLI (`codex exec`). Codex is one-shot per turn:
// each `sendTurn()` spawns a fresh `codex exec` (or `codex exec resume <id>`)
// rather than feeding stdin envelopes to a long-lived process. The runner
// captures the `thread_id` from the first turn's `thread.started` event and
// uses it for subsequent turns when `pass_resume_flag` is true.
//
// Protocol-required flag (`--json`) and the prompt-on-stdin sentinel (`-`) are
// always applied by the runner and are NOT user-configurable. `args` is for
// USER extras (e.g. `--model`, `--profile`).
export const CodexRunnerSchema = z
  .object({
    type: z.literal("codex"),
    cli_path: z.string().default("codex"),
    args: z.array(z.string()).default([]),
    cwd: PathString.optional(),
    env: z.record(z.string(), z.string()).default({}),
    /** Capture the first turn's thread_id and resume on subsequent turns. */
    pass_resume_flag: BoolPermissive.default(true),
    /**
     * Approval mode → maps to `--ask-for-approval`, `--full-auto`, or `--yolo`.
     * `yolo` requires `acknowledge_dangerous: true` (validated at config root).
     */
    approval_mode: z
      .enum(["untrusted", "on-request", "never", "full-auto", "yolo"])
      .default("full-auto"),
    /** Sandbox mode → `--sandbox`. */
    sandbox: z
      .enum(["read-only", "workspace-write", "danger-full-access"])
      .default("workspace-write"),
    /** Optional `--model` override. */
    model: z.string().optional(),
    /** Required to enable `approval_mode: yolo`. */
    acknowledge_dangerous: BoolPermissive.default(false),
  })
  .strict();

// Command runner
export const CommandRunnerSchema = z
  .object({
    type: z.literal("command"),
    cmd: z.array(z.string()).min(1),
    protocol: z.enum(["jsonl-text", "claude-ndjson", "codex-jsonl"]),
    cwd: PathString.optional(),
    env: z.record(z.string(), z.string()).default({}),
    on_reset: z.enum(["signal", "restart"]).default("signal"),
  })
  .strict();

export const RunnerSchema = z.discriminatedUnion("type", [
  ClaudeCodeRunnerSchema,
  CodexRunnerSchema,
  CommandRunnerSchema,
]);

export const BotSchema = z
  .object({
    id: BotIdSchema,
    token: NonEmptyString,
    transport_override: BotTransportOverrideSchema.optional(),
    access_control: BotAccessControlSchema.optional(),
    commands: z.array(BotCommandSchema).default([]),
    reactions: BotReactionsSchema,
    runner: RunnerSchema,
  })
  .strict();

// ---------- agent API ----------

export const AgentApiScopeSchema = z.enum(["ask", "send"]);
export type AgentApiScope = z.infer<typeof AgentApiScopeSchema>;

export const AgentApiTokenSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/, "name must be lowercase alnum/_-, max 64 chars"),
    secret_ref: NonEmptyString,
    bot_ids: z.array(BotIdSchema).min(1),
    scopes: z.array(AgentApiScopeSchema).min(1),
  })
  .strict();

export const AgentApiSideSessionsSchema = z
  .object({
    idle_ttl_ms: IntCoerce.min(60_000).default(3_600_000),
    hard_ttl_ms: IntCoerce.min(60_000).default(86_400_000),
    max_per_bot: IntCoerce.min(1).max(64).default(8),
    max_global: IntCoerce.min(1).max(512).default(64),
  })
  .strict()
  .default({
    idle_ttl_ms: 3_600_000,
    hard_ttl_ms: 86_400_000,
    max_per_bot: 8,
    max_global: 64,
  });

export const AgentApiSendSchema = z
  .object({
    idempotency_retention_ms: IntCoerce.min(60_000).default(86_400_000),
  })
  .strict()
  .default({ idempotency_retention_ms: 86_400_000 });

export const AgentApiAskSchema = z
  .object({
    default_timeout_ms: IntCoerce.min(1_000).max(300_000).default(60_000),
    max_timeout_ms: IntCoerce.min(1_000).max(300_000).default(300_000),
    max_body_bytes: IntCoerce.min(4_096).default(100 * 1024 * 1024),
    max_files_per_request: IntCoerce.min(1).max(50).default(10),
  })
  .strict()
  .default({
    default_timeout_ms: 60_000,
    max_timeout_ms: 300_000,
    max_body_bytes: 100 * 1024 * 1024,
    max_files_per_request: 10,
  });

export const AgentApiSchema = z
  .object({
    enabled: BoolPermissive.default(false),
    tokens: z.array(AgentApiTokenSchema).default([]),
    side_sessions: AgentApiSideSessionsSchema,
    send: AgentApiSendSchema,
    ask: AgentApiAskSchema,
  })
  .strict()
  .default({
    enabled: false,
    tokens: [],
    side_sessions: {
      idle_ttl_ms: 3_600_000,
      hard_ttl_ms: 86_400_000,
      max_per_bot: 8,
      max_global: 64,
    },
    send: { idempotency_retention_ms: 86_400_000 },
    ask: {
      default_timeout_ms: 60_000,
      max_timeout_ms: 300_000,
      max_body_bytes: 100 * 1024 * 1024,
      max_files_per_request: 10,
    },
  });

// ---------- root ----------

export const ConfigSchema = z
  .object({
    version: z.literal(1, {
      errorMap: () => ({
        message: "only config version 1 is supported by this gateway release",
      }),
    }),
    gateway: GatewaySchema,
    telegram: TelegramSchema,
    transport: TransportSchema,
    access_control: AccessControlSchema,
    alerts: AlertsSchema.optional(),
    worker_tuning: WorkerTuningSchema,
    streaming: StreamingSchema,
    outbox: OutboxSchema,
    shutdown: ShutdownSchema,
    dashboard: DashboardSchema,
    metrics: MetricsSchema,
    attachments: AttachmentsSchema,
    agent_api: AgentApiSchema,
    bots: z.array(BotSchema).min(1, "at least one bot is required"),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // webhook.base_url/secret required iff any bot uses webhook.
    const usesWebhook =
      cfg.transport.default_mode === "webhook" ||
      cfg.bots.some((b) => b.transport_override?.mode === "webhook");
    if (usesWebhook) {
      if (!cfg.transport.webhook?.base_url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transport", "webhook", "base_url"],
          message: "required because at least one bot uses webhook transport",
        });
      }
      if (!cfg.transport.webhook?.secret) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transport", "webhook", "secret"],
          message: "required because at least one bot uses webhook transport",
        });
      }
    }

    // Unique bot IDs.
    const ids = new Set<string>();
    for (const [idx, bot] of cfg.bots.entries()) {
      if (ids.has(bot.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bots", idx, "id"],
          message: `duplicate bot id '${bot.id}'`,
        });
      }
      ids.add(bot.id);
    }

    // alerts.via_bot must reference an existing bot.
    if (cfg.alerts?.via_bot && !ids.has(cfg.alerts.via_bot)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["alerts", "via_bot"],
        message: `alerts.via_bot='${cfg.alerts.via_bot}' does not reference any bot in bots[]`,
      });
    }

    // Unique command triggers per bot.
    for (const [idx, bot] of cfg.bots.entries()) {
      const triggers = new Set<string>();
      for (const [cidx, cmd] of bot.commands.entries()) {
        if (triggers.has(cmd.trigger)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["bots", idx, "commands", cidx, "trigger"],
            message: `duplicate command trigger '${cmd.trigger}' for bot '${bot.id}'`,
          });
        }
        triggers.add(cmd.trigger);
      }
    }

    // codex approval_mode='yolo' requires explicit acknowledge_dangerous=true.
    for (const [idx, bot] of cfg.bots.entries()) {
      if (
        bot.runner.type === "codex" &&
        bot.runner.approval_mode === "yolo" &&
        !bot.runner.acknowledge_dangerous
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bots", idx, "runner", "acknowledge_dangerous"],
          message:
            "approval_mode='yolo' requires acknowledge_dangerous=true (skips all sandboxing — use only inside an externally hardened environment)",
        });
      }
    }

    // Dashboard mount_path must not collide with any bot id used as URL segment.
    if (cfg.dashboard.enabled) {
      const mp = cfg.dashboard.mount_path.replace(/^\/+/, "").split("/")[0];
      if (mp && ids.has(mp)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dashboard", "mount_path"],
          message: `dashboard.mount_path first segment '${mp}' collides with bot id`,
        });
      }
    }

    // ACL default-deny requires non-empty list; empty is allowed but will generate a warning at load time.

    // Agent API: referenced bot_ids must exist; token names must be unique;
    // TTL + cap invariants hold.
    if (cfg.agent_api) {
      const tokenNames = new Set<string>();
      for (const [tIdx, tok] of cfg.agent_api.tokens.entries()) {
        if (tokenNames.has(tok.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["agent_api", "tokens", tIdx, "name"],
            message: `duplicate agent_api token name '${tok.name}'`,
          });
        }
        tokenNames.add(tok.name);
        for (const [bIdx, botId] of tok.bot_ids.entries()) {
          if (!ids.has(botId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["agent_api", "tokens", tIdx, "bot_ids", bIdx],
              message: `agent_api.tokens[${tIdx}].bot_ids references unknown bot '${botId}'`,
            });
          }
        }
      }

      const ss = cfg.agent_api.side_sessions;
      if (ss.idle_ttl_ms > ss.hard_ttl_ms) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agent_api", "side_sessions", "idle_ttl_ms"],
          message: "idle_ttl_ms must be <= hard_ttl_ms",
        });
      }
      if (ss.max_per_bot > ss.max_global) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agent_api", "side_sessions", "max_per_bot"],
          message: "max_per_bot must be <= max_global",
        });
      }

      const ask = cfg.agent_api.ask;
      if (ask.default_timeout_ms > ask.max_timeout_ms) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agent_api", "ask", "default_timeout_ms"],
          message: "default_timeout_ms must be <= max_timeout_ms",
        });
      }
    }
  });

export type BotId = string;
export type Config = z.infer<typeof ConfigSchema>;
export type BotConfig = z.infer<typeof BotSchema>;
export type RunnerConfig = z.infer<typeof RunnerSchema>;
export type ClaudeCodeRunnerConfig = z.infer<typeof ClaudeCodeRunnerSchema>;
export type CodexRunnerConfig = z.infer<typeof CodexRunnerSchema>;
export type CommandRunnerConfig = z.infer<typeof CommandRunnerSchema>;

/** Fields whose resolved values are to be collected by the redactor. Leaves: (config root) -> dotted path. */
export const SECRET_PATHS = [
  "transport.webhook.secret",
  "bots[].token",
  "agent_api.tokens[].secret_ref",
] as const;

export type AgentApiTokenConfig = z.infer<typeof AgentApiTokenSchema>;
export type AgentApiConfig = z.infer<typeof AgentApiSchema>;
