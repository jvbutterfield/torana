import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "./schema.js";
import {
  AgentApiSchema,
  AttachmentsSchema,
  BotCommandSchema,
  BotIdSchema,
  BotReactionsSchema,
  DashboardSchema,
  GatewaySchema,
  MetricsSchema,
  OutboxSchema,
  RunnerSchema,
  ShutdownSchema,
  StreamingSchema,
  WorkerTuningSchema,
} from "./schema.js";

const Int = z.coerce.number().int();
const Bool = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) =>
    typeof value === "boolean" ? value : value === "true" || value === "1",
  );
const EndpointId = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{0,47}$/,
    "endpoint id must match ^[a-z][a-z0-9_-]{0,47}$",
  );
const SessionScope = z
  .string()
  .regex(
    /^(conversation|legacy_agent|ephemeral|channel|thread|alias:[a-z][a-z0-9_-]{0,47})$/,
    "invalid session scope",
  );

const TelegramDeliverySchema = z
  .object({
    default_mode: z.enum(["webhook", "polling"]),
    allowed_updates: z.array(z.string()).default(["message"]),
    webhook: z
      .object({
        base_url: z.string().url().optional(),
        secret: z.string().min(32).optional(),
      })
      .strict()
      .optional(),
    polling: z
      .object({
        timeout_secs: Int.min(1).max(60).default(25),
        backoff_base_ms: Int.default(1000),
        backoff_cap_ms: Int.default(30_000),
        max_updates_per_batch: Int.min(1).max(100).default(100),
      })
      .strict()
      .default({}),
  })
  .strict();

const PlatformsSchema = z
  .object({
    telegram: z
      .object({
        enabled: Bool.default(true),
        api_base_url: z.string().url().default("https://api.telegram.org"),
        delivery: TelegramDeliverySchema,
      })
      .strict(),
    buzz: z
      .object({
        enabled: Bool.default(false),
      })
      .passthrough()
      .default({ enabled: false }),
  })
  .strict();

const SessionsSchema = z
  .object({
    scope: SessionScope.default("conversation"),
    idle_process_ttl_ms: Int.min(60_000).default(3_600_000),
    hard_process_ttl_ms: Int.min(60_000).default(86_400_000),
    context_retention_ms: Int.min(60_000).default(7_776_000_000),
    max_per_agent: Int.min(1).max(64).default(8),
    max_global: Int.min(1).max(512).default(32),
    max_per_token_default: Int.min(1).max(512).default(8),
    max_concurrent_turns_per_agent: Int.min(1).max(64).default(2),
    max_concurrent_turns_global: Int.min(1).max(512).default(12),
    max_queue_depth_per_conversation: Int.min(1).default(50),
    max_queue_depth_per_agent: Int.min(1).default(500),
    overflow: z.enum(["queue", "reject"]).default("queue"),
    aliases: z
      .array(z.object({ name: EndpointId, agent_id: BotIdSchema }).strict())
      .default([]),
  })
  .strict()
  .default({});

const ChatOverrideSchema = z
  .object({ session_scope: SessionScope.optional() })
  .strict();

const TelegramEndpointSchema = z
  .object({
    id: EndpointId,
    platform: z.literal("telegram"),
    enabled: Bool.default(true),
    token: z.string().min(1),
    transport_override: z
      .object({ mode: z.enum(["webhook", "polling"]) })
      .strict()
      .optional(),
    allowed_user_ids: z.array(Int).optional(),
    reactions: BotReactionsSchema,
    commands: z.array(BotCommandSchema).default([]),
    chat_overrides: z.record(z.string(), ChatOverrideSchema).default({}),
  })
  .strict();

const BuzzEndpointSchema = z
  .object({
    id: EndpointId,
    platform: z.literal("buzz"),
    enabled: Bool.default(false),
    community_id: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
    relay_url: z.string().url(),
    private_key: z.string().min(1),
    auth_tag: z.string().optional(),
    respond_to: z
      .enum(["owner_only", "allowlist", "anyone", "nobody"])
      .default("owner_only"),
    owner_pubkey: z.string().optional(),
    allowed_pubkeys: z.array(z.string()).default([]),
    allow_shared_identity: Bool.default(false),
  })
  .passthrough();

const AgentSchema = z
  .object({
    id: BotIdSchema,
    runner: RunnerSchema,
    endpoints: z
      .array(
        z.discriminatedUnion("platform", [
          TelegramEndpointSchema,
          BuzzEndpointSchema,
        ]),
      )
      .min(1),
    tools: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const AlertsV2Schema = z
  .object({
    cooldown_ms: Int.default(600_000),
    target: z
      .object({
        endpoint_id: EndpointId,
        external_conversation_id: z.string().min(1),
      })
      .strict()
      .optional(),
    via_bot: BotIdSchema.optional(),
    chat_id: Int.optional(),
  })
  .strict()
  .refine((value) => !(value.target && (value.via_bot || value.chat_id)), {
    message: "alerts.target cannot be combined with legacy via_bot/chat_id",
  });

export const ConfigV2Schema = z
  .object({
    version: z.literal(2),
    gateway: GatewaySchema,
    platforms: PlatformsSchema,
    access_control: z
      .object({
        default_policy: z.enum(["allow", "deny"]).default("deny"),
        allowed_user_ids: z.array(Int).default([]),
      })
      .strict(),
    sessions: SessionsSchema,
    alerts: AlertsV2Schema.optional(),
    worker_tuning: WorkerTuningSchema,
    streaming: StreamingSchema,
    outbox: OutboxSchema,
    shutdown: ShutdownSchema,
    dashboard: DashboardSchema,
    metrics: MetricsSchema,
    attachments: AttachmentsSchema,
    agent_api: AgentApiSchema,
    agents: z.array(AgentSchema).min(1),
  })
  .strict()
  .superRefine((config, ctx) => {
    const agentIds = new Set<string>();
    const endpointIds = new Set<string>();
    const aliases = new Map(
      config.sessions.aliases.map((a) => [a.name, a.agent_id]),
    );
    for (const [agentIndex, agent] of config.agents.entries()) {
      if (agentIds.has(agent.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", agentIndex, "id"],
          message: `duplicate agent id '${agent.id}'`,
        });
      }
      agentIds.add(agent.id);
      let telegramCount = 0;
      for (const [endpointIndex, endpoint] of agent.endpoints.entries()) {
        if (endpointIds.has(endpoint.id) || endpoint.id === agent.id) {
          ctx.addIssue({
            code: "custom",
            path: ["agents", agentIndex, "endpoints", endpointIndex, "id"],
            message: `endpoint id '${endpoint.id}' must be globally unique and must not equal an agent id`,
          });
        }
        if (endpoint.id === `${agent.id}-agent-api`) {
          ctx.addIssue({
            code: "custom",
            path: ["agents", agentIndex, "endpoints", endpointIndex, "id"],
            message:
              "endpoint id collides with the reserved Agent API endpoint",
          });
        }
        endpointIds.add(endpoint.id);
        if (endpoint.platform === "telegram" && endpoint.enabled)
          telegramCount += 1;
        if (endpoint.platform === "buzz" && endpoint.enabled) {
          ctx.addIssue({
            code: "custom",
            path: ["agents", agentIndex, "endpoints", endpointIndex, "enabled"],
            message: "Buzz endpoints must remain disabled until Phase 4",
          });
        }
        if (endpoint.platform === "telegram") {
          for (const [chatId, override] of Object.entries(
            endpoint.chat_overrides,
          )) {
            if (!/^-?[1-9]\d*$/.test(chatId)) {
              ctx.addIssue({
                code: "custom",
                path: [
                  "agents",
                  agentIndex,
                  "endpoints",
                  endpointIndex,
                  "chat_overrides",
                  chatId,
                ],
                message:
                  "Telegram chat override keys must be canonical decimal IDs",
              });
            }
            const alias = override.session_scope?.startsWith("alias:")
              ? override.session_scope.slice(6)
              : null;
            if (alias && aliases.get(alias) !== agent.id) {
              ctx.addIssue({
                code: "custom",
                path: [
                  "agents",
                  agentIndex,
                  "endpoints",
                  endpointIndex,
                  "chat_overrides",
                  chatId,
                  "session_scope",
                ],
                message: `alias '${alias}' is not declared for agent '${agent.id}'`,
              });
            }
          }
        }
      }
      if (telegramCount !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", agentIndex, "endpoints"],
          message:
            "Phase 2 runtime requires exactly one enabled Telegram endpoint per agent",
        });
      }
      if (
        agent.runner.type === "command" &&
        agent.runner.resume_model !== "stable_session_id" &&
        config.sessions.scope !== "ephemeral" &&
        config.sessions.scope !== "legacy_agent"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", agentIndex, "runner", "resume_model"],
          message:
            "explicit v2 durable session scopes require resume_model: stable_session_id; otherwise use sessions.scope: ephemeral",
        });
      }
    }
    for (const [index, alias] of config.sessions.aliases.entries()) {
      if (!agentIds.has(alias.agent_id)) {
        ctx.addIssue({
          code: "custom",
          path: ["sessions", "aliases", index, "agent_id"],
          message: `unknown agent '${alias.agent_id}'`,
        });
      }
    }
    if (
      config.sessions.idle_process_ttl_ms > config.sessions.hard_process_ttl_ms
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sessions", "idle_process_ttl_ms"],
        message: "must be <= hard_process_ttl_ms",
      });
    }
    if (config.sessions.max_per_agent > config.sessions.max_global) {
      ctx.addIssue({
        code: "custom",
        path: ["sessions", "max_per_agent"],
        message: "must be <= max_global",
      });
    }
    if (
      config.alerts?.target &&
      !endpointIds.has(config.alerts.target.endpoint_id)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["alerts", "target", "endpoint_id"],
        message: "does not reference a configured endpoint",
      });
    }
    if (config.alerts?.target) {
      const targetEndpoint = config.agents
        .flatMap((agent) => agent.endpoints)
        .find((endpoint) => endpoint.id === config.alerts!.target!.endpoint_id);
      const externalId = config.alerts.target.external_conversation_id;
      if (
        targetEndpoint?.platform === "telegram" &&
        (!/^-?[1-9]\d*$/.test(externalId) ||
          !Number.isSafeInteger(Number(externalId)))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["alerts", "target", "external_conversation_id"],
          message:
            "Telegram alert targets require a safe canonical decimal conversation ID",
        });
      }
    }
  });

export type ConfigV2 = z.infer<typeof ConfigV2Schema>;

export interface NormalizedEndpointConfig {
  id: string;
  agentId: string;
  platform: "telegram" | "buzz" | "agent_api";
  enabled: boolean;
  communityId: string | null;
  externalIdentity: string | null;
  sessionScopes?: Record<string, string>;
}

export interface NormalizedConfigModel {
  sourceVersion: 1 | 2;
  endpoints: NormalizedEndpointConfig[];
  sessions: ConfigV2["sessions"];
  alertsTarget?: { endpointId: string; externalConversationId: string };
}

export function normalizeV2(config: ConfigV2): {
  config: Config;
  model: NormalizedConfigModel;
} {
  const bots = config.agents.map((agent) => {
    const endpoint = agent.endpoints.find(
      (candidate) => candidate.platform === "telegram" && candidate.enabled,
    );
    if (!endpoint || endpoint.platform !== "telegram") {
      throw new Error(`agent '${agent.id}' has no enabled Telegram endpoint`);
    }
    return {
      id: agent.id,
      token: endpoint.token,
      transport_override: endpoint.transport_override,
      access_control: endpoint.allowed_user_ids
        ? { allowed_user_ids: endpoint.allowed_user_ids }
        : undefined,
      commands: endpoint.commands,
      reactions: endpoint.reactions,
      runner: agent.runner,
    };
  });
  const telegram = config.platforms.telegram;
  const legacyAlerts = config.alerts
    ? resolveLegacyAlerts(config, config.alerts)
    : undefined;
  const runtime: Config = {
    version: 1,
    gateway: config.gateway,
    telegram: { api_base_url: telegram.api_base_url },
    transport: telegram.delivery,
    access_control: {
      allowed_user_ids: config.access_control.allowed_user_ids,
    },
    alerts: legacyAlerts,
    worker_tuning: config.worker_tuning,
    streaming: config.streaming,
    outbox: config.outbox,
    shutdown: config.shutdown,
    dashboard: config.dashboard,
    metrics: config.metrics,
    attachments: config.attachments,
    agent_api: {
      ...config.agent_api,
      side_sessions: {
        ...config.agent_api.side_sessions,
        idle_ttl_ms: config.sessions.idle_process_ttl_ms,
        hard_ttl_ms: config.sessions.hard_process_ttl_ms,
        max_per_bot: config.sessions.max_per_agent,
        max_global: config.sessions.max_global,
        max_per_token_default: config.sessions.max_per_token_default,
      },
    },
    bots,
  };
  return {
    config: runtime,
    model: {
      sourceVersion: 2,
      endpoints: config.agents.flatMap((agent) => [
        ...agent.endpoints.map((endpoint) => ({
          id: endpoint.id,
          agentId: agent.id,
          platform: endpoint.platform,
          enabled: endpoint.enabled,
          communityId:
            endpoint.platform === "buzz" ? endpoint.community_id : null,
          externalIdentity:
            endpoint.platform === "buzz"
              ? createHash("sha256")
                  .update(endpoint.private_key)
                  .digest("hex")
                  .slice(0, 64)
              : null,
          sessionScopes:
            endpoint.platform === "telegram"
              ? Object.fromEntries(
                  Object.entries(endpoint.chat_overrides).flatMap(
                    ([id, override]) =>
                      override.session_scope
                        ? [[id, override.session_scope]]
                        : [],
                  ),
                )
              : {},
        })),
        {
          id: `${agent.id}-agent-api`,
          agentId: agent.id,
          platform: "agent_api" as const,
          enabled: config.agent_api.enabled,
          communityId: null,
          externalIdentity: null,
          sessionScopes: {},
        },
      ]),
      sessions: config.sessions,
      alertsTarget: config.alerts?.target
        ? {
            endpointId: config.alerts.target.endpoint_id,
            externalConversationId:
              config.alerts.target.external_conversation_id,
          }
        : undefined,
    },
  };
}

function resolveLegacyAlerts(
  config: ConfigV2,
  alerts: NonNullable<ConfigV2["alerts"]>,
): Config["alerts"] {
  if (alerts.target) {
    const agent = config.agents.find((candidate) =>
      candidate.endpoints.some(
        (endpoint) => endpoint.id === alerts.target!.endpoint_id,
      ),
    );
    const endpoint = agent?.endpoints.find(
      (candidate) => candidate.id === alerts.target!.endpoint_id,
    );
    if (!agent || endpoint?.platform !== "telegram") {
      return undefined;
    }
    return {
      via_bot: agent.id,
      chat_id: Number(alerts.target.external_conversation_id),
      cooldown_ms: alerts.cooldown_ms,
    };
  }
  return {
    via_bot: alerts.via_bot,
    chat_id: alerts.chat_id,
    cooldown_ms: alerts.cooldown_ms,
  };
}

export function normalizedV1Model(config: Config): NormalizedConfigModel {
  return {
    sourceVersion: 1,
    endpoints: config.bots.flatMap((bot) => [
      {
        id: `${bot.id}-telegram`,
        agentId: bot.id,
        platform: "telegram" as const,
        enabled: true,
        communityId: null,
        externalIdentity: null,
        sessionScopes: {},
      },
      {
        id: `${bot.id}-agent-api`,
        agentId: bot.id,
        platform: "agent_api" as const,
        enabled: config.agent_api.enabled,
        communityId: null,
        externalIdentity: null,
        sessionScopes: {},
      },
    ]),
    sessions: {
      scope: "legacy_agent",
      idle_process_ttl_ms: config.agent_api.side_sessions.idle_ttl_ms,
      hard_process_ttl_ms: config.agent_api.side_sessions.hard_ttl_ms,
      context_retention_ms: 7_776_000_000,
      max_per_agent: config.agent_api.side_sessions.max_per_bot,
      max_global: config.agent_api.side_sessions.max_global,
      max_per_token_default:
        config.agent_api.side_sessions.max_per_token_default,
      max_concurrent_turns_per_agent: 2,
      max_concurrent_turns_global: 12,
      max_queue_depth_per_conversation: 50,
      max_queue_depth_per_agent: 500,
      overflow: "queue",
      aliases: [],
    },
    alertsTarget:
      config.alerts?.via_bot && config.alerts.chat_id !== undefined
        ? {
            endpointId: `${config.alerts.via_bot}-telegram`,
            externalConversationId: String(config.alerts.chat_id),
          }
        : undefined,
  };
}

export function upgradeV1Object(config: Config): Record<string, unknown> {
  const model = normalizedV1Model(config);
  return {
    version: 2,
    gateway: config.gateway,
    platforms: {
      telegram: {
        enabled: true,
        api_base_url: config.telegram.api_base_url,
        delivery: config.transport,
      },
      buzz: { enabled: false },
    },
    access_control: {
      default_policy: "deny",
      allowed_user_ids: config.access_control.allowed_user_ids,
    },
    sessions: model.sessions,
    ...(model.alertsTarget
      ? {
          alerts: {
            cooldown_ms: config.alerts?.cooldown_ms ?? 600_000,
            target: {
              endpoint_id: model.alertsTarget.endpointId,
              external_conversation_id:
                model.alertsTarget.externalConversationId,
            },
          },
        }
      : {}),
    worker_tuning: config.worker_tuning,
    streaming: config.streaming,
    outbox: config.outbox,
    shutdown: config.shutdown,
    dashboard: config.dashboard,
    metrics: config.metrics,
    attachments: config.attachments,
    agent_api: config.agent_api,
    agents: config.bots.map((bot) => ({
      id: bot.id,
      runner: bot.runner,
      endpoints: [
        {
          id: `${bot.id}-telegram`,
          platform: "telegram",
          enabled: true,
          token: bot.token,
          ...(bot.transport_override
            ? { transport_override: bot.transport_override }
            : {}),
          ...(bot.access_control
            ? { allowed_user_ids: bot.access_control.allowed_user_ids }
            : {}),
          commands: bot.commands,
          reactions: bot.reactions,
          chat_overrides: {},
        },
      ],
    })),
  };
}
