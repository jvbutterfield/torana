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
    allowed_updates: z.array(z.string()).default(["message"]),
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
export const ClaudeCodeRunnerSchema = z
  .object({
    type: z.literal("claude-code"),
    cli_path: z.string().default("claude"),
    args: z
      .array(z.string())
      .default([
        "--print",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--include-partial-messages",
        "--replay-user-messages",
        "--verbose",
        "--dangerously-skip-permissions",
      ]),
    cwd: PathString.optional(),
    env: z.record(z.string(), z.string()).default({}),
    pass_continue_flag: BoolPermissive.default(true),
  })
  .strict();

// Command runner
export const CommandRunnerSchema = z
  .object({
    type: z.literal("command"),
    cmd: z.array(z.string()).min(1),
    protocol: z.enum(["jsonl-text", "claude-ndjson"]),
    cwd: PathString.optional(),
    env: z.record(z.string(), z.string()).default({}),
    on_reset: z.enum(["signal", "restart"]).default("signal"),
  })
  .strict();

export const RunnerSchema = z.discriminatedUnion("type", [
  ClaudeCodeRunnerSchema,
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
  });

export type BotId = string;
export type Config = z.infer<typeof ConfigSchema>;
export type BotConfig = z.infer<typeof BotSchema>;
export type RunnerConfig = z.infer<typeof RunnerSchema>;
export type ClaudeCodeRunnerConfig = z.infer<typeof ClaudeCodeRunnerSchema>;
export type CommandRunnerConfig = z.infer<typeof CommandRunnerSchema>;

/** Fields whose resolved values are to be collected by the redactor. Leaves: (config root) -> dotted path. */
export const SECRET_PATHS = [
  "transport.webhook.secret",
  "bots[].token",
] as const;
