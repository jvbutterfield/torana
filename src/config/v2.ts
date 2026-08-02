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
import {
  BUZZ_KINDS,
  decodeSecret,
  normalizePubkey,
  ownerAuthTagAllowsEvent,
  parseOwnerAuthTag,
  publicKey,
  verifyOwnerAuthTag,
} from "../platform/buzz/protocol.js";
import {
  DANGEROUS_BUZZ_COMMANDS,
  isKnownBuzzCommand,
} from "../broker/buzz-policy.js";

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
const RelayUrl = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const parsed = new URL(value);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      ctx.addIssue({ code: "custom", message: "relay URL must use ws or wss" });
    }
    if (parsed.username || parsed.password) {
      ctx.addIssue({
        code: "custom",
        message: "relay URL must not contain credentials",
      });
    }
  });

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
        cli_path: z.string().min(1).default("buzz"),
        cli_sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .default(
            "1f650920c370d2ba042a9e17cf381be65f43fc9e909859ac248306445a7e0aee",
          ),
        reconnect: z
          .object({
            base_ms: Int.min(100).default(1000),
            cap_ms: Int.min(100).default(30_000),
          })
          .strict()
          .default({}),
        subscription: z
          .object({
            historical_limit: Int.min(1).max(5000).default(500),
            replay_overlap_secs: Int.min(0).max(86_400).default(300),
            heartbeat_secs: Int.min(5).max(300).default(30),
          })
          .strict()
          .default({}),
        message_max_bytes: Int.min(1024).max(1_048_576).default(65_536),
        max_frame_bytes: Int.min(65_536).max(16_777_216).default(524_288),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.max_frame_bytes < value.message_max_bytes + 4096) {
          ctx.addIssue({
            code: "custom",
            path: ["max_frame_bytes"],
            message:
              "must be at least message_max_bytes + 4096 for the signed event envelope",
          });
        }
      })
      .default({}),
  })
  .strict();

const LimitsV2Schema = z
  .object({
    dispatch_wait_warn_ms: Int.min(1000).default(30_000),
    max_queue_depth_per_conversation: Int.min(1).default(50),
    max_queue_depth_per_agent: Int.min(1).default(500),
    inbound_event_rate_per_endpoint: z.string().default("600/60s"),
    relay_publish_timeout_ms: Int.min(100).default(10_000),
    relay_ok_wait_ms: Int.min(100).default(5000),
    reconnect_alert_after_secs: Int.min(1).default(900),
    broker_call_timeout_ms: Int.min(100).default(30_000),
    buzz_edit_cadence_ms: Int.min(100).default(2000),
    typing_min_interval_ms: Int.min(100).default(4000),
    presence_min_interval_ms: Int.min(100).default(30_000),
    reaction_min_interval_ms: Int.min(100).default(1000),
    agent_reply_rate_per_conversation: z.string().default("6/60s"),
    agent_reply_rate_per_endpoint: z.string().default("60/60s"),
  })
  .strict()
  .default({});

const RetentionV2Schema = z
  .object({
    database_size_cap_bytes: Int.min(1).default(4_294_967_296),
    inbound_payload_days: Int.min(0).default(30),
    inbound_event_days: Int.min(1).default(90),
    terminal_turn_days: Int.min(1).default(90),
    sent_outbox_days: Int.min(1).default(14),
    dead_outbox_days: Int.min(1).default(90),
    signed_sent_payload_hours: Int.min(1).default(24),
    pending_mutation_days: Int.min(1).default(30),
  })
  .strict()
  .default({});

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
    relay_url: RelayUrl,
    private_key: z.string().min(1),
    auth_tag: z.string().optional(),
    respond_to: z
      .enum(["owner_only", "allowlist", "anyone", "nobody"])
      .default("owner_only"),
    owner_pubkey: z.string().optional(),
    allowed_pubkeys: z.array(z.string()).default([]),
    subscribe: z
      .enum(["mentions_and_dms", "all_channels"])
      .default("mentions_and_dms"),
    triggers: z
      .object({
        feed: z
          .object({
            enabled: Bool.default(false),
            modes: z.array(z.enum(["mentions", "needs_action"])).default([]),
            interval_secs: Int.min(1).optional(),
          })
          .strict()
          .default({}),
        workflows: z
          .object({
            enabled: Bool.default(false),
            event_kinds: z.array(Int).default([]),
          })
          .strict()
          .default({}),
        heartbeat: z
          .object({
            enabled: Bool.default(false),
            interval_secs: Int.min(1).optional(),
            target_channel: z.string().uuid().optional(),
            prompt: z.string().min(1).optional(),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    channel_overrides: z
      .record(
        z.string().uuid(),
        z
          .object({
            require_mention: Bool.optional(),
            session_scope: SessionScope.optional(),
            kinds: z.array(Int).optional(),
          })
          .strict(),
      )
      .default({}),
    allow_shared_identity: Bool.default(false),
    reactions: BotReactionsSchema,
    rerun_on_edit: Bool.default(false),
    include_reactions_in_context: Bool.default(false),
    custom_emoji_palette: z
      .record(
        z.string().regex(/^[a-z0-9_-]{1,64}$/),
        z
          .string()
          .url()
          .regex(/^https?:\/\//),
      )
      .default({}),
  })
  .strict();

const BuzzToolsSchema = z
  .object({
    policy: z
      .enum(["read_only", "collaborate", "maintainer", "custom"])
      .default("collaborate"),
    allowed_commands: z
      .array(z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,2}$/))
      .default([]),
    default_endpoint_id: EndpointId.optional(),
    allowed_endpoint_ids: z.array(EndpointId).default([]),
    expose_private_key_to_runner: Bool.default(false),
    acknowledge_dangerous: Bool.default(false),
  })
  .strict();

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
    tools: z.object({ buzz: BuzzToolsSchema.optional() }).strict().optional(),
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
    limits: LimitsV2Schema,
    retention: RetentionV2Schema,
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
    const buzzIdentities = new Map<
      string,
      Array<{ agentIndex: number; endpointIndex: number; shared: boolean }>
    >();
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
      let telegramEndpointCount = 0;
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
        if (endpoint.platform === "telegram") {
          telegramEndpointCount += 1;
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
        } else {
          const basePath = ["agents", agentIndex, "endpoints", endpointIndex];
          let endpointPubkey: string | null = null;
          try {
            endpointPubkey = publicKey(decodeSecret(endpoint.private_key));
            const identities = buzzIdentities.get(endpointPubkey) ?? [];
            identities.push({
              agentIndex,
              endpointIndex,
              shared: endpoint.allow_shared_identity,
            });
            buzzIdentities.set(endpointPubkey, identities);
          } catch (error) {
            ctx.addIssue({
              code: "custom",
              path: [...basePath, "private_key"],
              message: error instanceof Error ? error.message : String(error),
            });
          }

          let ownerPubkey: string | null = null;
          if (endpoint.owner_pubkey) {
            try {
              ownerPubkey = normalizePubkey(endpoint.owner_pubkey);
            } catch (error) {
              ctx.addIssue({
                code: "custom",
                path: [...basePath, "owner_pubkey"],
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
          const normalizedAllowlist: string[] = [];
          for (const [
            pubkeyIndex,
            pubkey,
          ] of endpoint.allowed_pubkeys.entries()) {
            try {
              normalizedAllowlist.push(normalizePubkey(pubkey));
            } catch (error) {
              ctx.addIssue({
                code: "custom",
                path: [...basePath, "allowed_pubkeys", pubkeyIndex],
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
          if (endpoint.respond_to === "owner_only" && !ownerPubkey) {
            ctx.addIssue({
              code: "custom",
              path: [...basePath, "owner_pubkey"],
              message: "owner_only requires owner_pubkey",
            });
          }
          if (
            endpoint.respond_to === "allowlist" &&
            normalizedAllowlist.length === 0
          ) {
            ctx.addIssue({
              code: "custom",
              path: [...basePath, "allowed_pubkeys"],
              message: "allowlist requires at least one allowed pubkey",
            });
          }
          if (
            (endpoint.respond_to === "anyone" ||
              endpoint.respond_to === "nobody") &&
            endpoint.allowed_pubkeys.length > 0
          ) {
            ctx.addIssue({
              code: "custom",
              path: [...basePath, "allowed_pubkeys"],
              message: `${endpoint.respond_to} rejects an unused allowlist`,
            });
          }

          if (endpoint.auth_tag && endpointPubkey) {
            try {
              const tag = parseOwnerAuthTag(endpoint.auth_tag)!;
              if (!verifyOwnerAuthTag(tag, endpointPubkey)) {
                throw new Error(
                  "auth tag signature does not authorize this endpoint key",
                );
              }
              if (ownerPubkey && tag[1] !== ownerPubkey) {
                throw new Error("auth tag owner does not match owner_pubkey");
              }
              if (
                !ownerAuthTagAllowsEvent(tag, {
                  kind: BUZZ_KINDS.streamMessageV1,
                  created_at: Math.floor(Date.now() / 1000),
                })
              ) {
                throw new Error(
                  "auth tag does not authorize core reply kind 9",
                );
              }
            } catch (error) {
              ctx.addIssue({
                code: "custom",
                path: [...basePath, "auth_tag"],
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }

          if (
            endpoint.triggers.feed.enabled &&
            endpoint.triggers.feed.interval_secs === undefined
          ) {
            ctx.addIssue({
              code: "custom",
              path: [...basePath, "triggers", "feed", "interval_secs"],
              message: "enabled feed trigger requires interval_secs",
            });
          }
          if (endpoint.triggers.workflows.enabled) {
            if (endpoint.triggers.workflows.event_kinds.length === 0) {
              ctx.addIssue({
                code: "custom",
                path: [...basePath, "triggers", "workflows", "event_kinds"],
                message: "enabled workflow trigger requires event_kinds",
              });
            }
            const workflowKinds = new Set<number>([
              BUZZ_KINDS.workflowTriggered,
              BUZZ_KINDS.workflowStepStarted,
              BUZZ_KINDS.workflowStepCompleted,
              BUZZ_KINDS.workflowStepFailed,
              BUZZ_KINDS.workflowCompleted,
              BUZZ_KINDS.workflowFailed,
              BUZZ_KINDS.workflowCancelled,
              BUZZ_KINDS.workflowApprovalRequested,
              BUZZ_KINDS.workflowApprovalGranted,
              BUZZ_KINDS.workflowApprovalDenied,
            ]);
            for (const [
              kindIndex,
              kind,
            ] of endpoint.triggers.workflows.event_kinds.entries()) {
              if (workflowKinds.has(kind)) continue;
              ctx.addIssue({
                code: "custom",
                path: [
                  ...basePath,
                  "triggers",
                  "workflows",
                  "event_kinds",
                  kindIndex,
                ],
                message: `event kind ${kind} is not a pinned workflow notification kind`,
              });
            }
          }
          if (endpoint.triggers.heartbeat.enabled) {
            for (const field of [
              "interval_secs",
              "target_channel",
              "prompt",
            ] as const) {
              if (endpoint.triggers.heartbeat[field] !== undefined) continue;
              ctx.addIssue({
                code: "custom",
                path: [...basePath, "triggers", "heartbeat", field],
                message: `enabled heartbeat trigger requires ${field}`,
              });
            }
          }

          for (const [channelId, override] of Object.entries(
            endpoint.channel_overrides,
          )) {
            const alias = override.session_scope?.startsWith("alias:")
              ? override.session_scope.slice(6)
              : null;
            if (alias && aliases.get(alias) !== agent.id) {
              ctx.addIssue({
                code: "custom",
                path: [
                  ...basePath,
                  "channel_overrides",
                  channelId,
                  "session_scope",
                ],
                message: `alias '${alias}' is not declared for agent '${agent.id}'`,
              });
            }
          }
        }
      }
      const buzzEndpointIds = new Set(
        agent.endpoints
          .filter((endpoint) => endpoint.platform === "buzz")
          .map((endpoint) => endpoint.id),
      );
      const buzzTools = agent.tools?.buzz;
      for (const reserved of [
        "BUZZ_PRIVATE_KEY",
        "BUZZ_AUTH_TAG",
        "BUZZ_RELAY_URL",
        "TORANA_BUZZ_CAPABILITY_DIR",
        "TORANA_SESSION_ID",
      ]) {
        if (
          reserved in agent.runner.env ||
          reserved in (agent.runner.secrets ?? {})
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["agents", agentIndex, "runner", "env", reserved],
            message: `${reserved} is reserved for Torana's Buzz broker`,
          });
        }
      }
      if (buzzTools) {
        if (
          buzzTools.policy === "custom" &&
          buzzTools.allowed_commands.length === 0
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["agents", agentIndex, "tools", "buzz", "allowed_commands"],
            message: "custom policy requires at least one allowed command",
          });
        }
        if (
          buzzTools.policy !== "custom" &&
          buzzTools.allowed_commands.length > 0
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["agents", agentIndex, "tools", "buzz", "allowed_commands"],
            message: "allowed_commands is only valid with policy: custom",
          });
        }
        for (const [
          commandIndex,
          command,
        ] of buzzTools.allowed_commands.entries()) {
          if (!isKnownBuzzCommand(command)) {
            ctx.addIssue({
              code: "custom",
              path: [
                "agents",
                agentIndex,
                "tools",
                "buzz",
                "allowed_commands",
                commandIndex,
              ],
              message: `unknown command '${command}' in pinned Buzz CLI manifest`,
            });
          } else if (
            DANGEROUS_BUZZ_COMMANDS.has(command) &&
            !buzzTools.acknowledge_dangerous
          ) {
            ctx.addIssue({
              code: "custom",
              path: [
                "agents",
                agentIndex,
                "tools",
                "buzz",
                "acknowledge_dangerous",
              ],
              message: `dangerous command '${command}' requires acknowledge_dangerous: true`,
            });
          }
        }
        for (const [
          allowedIndex,
          endpointId,
        ] of buzzTools.allowed_endpoint_ids.entries()) {
          if (buzzEndpointIds.has(endpointId)) continue;
          ctx.addIssue({
            code: "custom",
            path: [
              "agents",
              agentIndex,
              "tools",
              "buzz",
              "allowed_endpoint_ids",
              allowedIndex,
            ],
            message: `Buzz tools endpoint '${endpointId}' is not owned by agent '${agent.id}'`,
          });
        }
        if (
          buzzTools.default_endpoint_id &&
          !buzzTools.allowed_endpoint_ids.includes(
            buzzTools.default_endpoint_id,
          )
        ) {
          ctx.addIssue({
            code: "custom",
            path: [
              "agents",
              agentIndex,
              "tools",
              "buzz",
              "default_endpoint_id",
            ],
            message: "default_endpoint_id must also be allowed",
          });
        }
        if (
          buzzTools.expose_private_key_to_runner &&
          !buzzTools.acknowledge_dangerous
        ) {
          ctx.addIssue({
            code: "custom",
            path: [
              "agents",
              agentIndex,
              "tools",
              "buzz",
              "acknowledge_dangerous",
            ],
            message:
              "expose_private_key_to_runner requires acknowledge_dangerous: true",
          });
        }
        if (
          buzzTools.expose_private_key_to_runner &&
          !buzzTools.default_endpoint_id
        ) {
          ctx.addIssue({
            code: "custom",
            path: [
              "agents",
              agentIndex,
              "tools",
              "buzz",
              "default_endpoint_id",
            ],
            message:
              "expose_private_key_to_runner requires one explicit default endpoint",
          });
        }
      }
      if (telegramEndpointCount > 1) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", agentIndex, "endpoints"],
          message: "an agent may configure at most one Telegram endpoint",
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
    for (const [pubkey, identities] of buzzIdentities) {
      if (identities.length < 2 || identities.every((item) => item.shared))
        continue;
      for (const identity of identities) {
        ctx.addIssue({
          code: "custom",
          path: [
            "agents",
            identity.agentIndex,
            "endpoints",
            identity.endpointIndex,
            "allow_shared_identity",
          ],
          message: `Buzz identity ${pubkey.slice(0, 12)}… is reused; every sharing endpoint must set allow_shared_identity: true`,
        });
      }
    }
    if (
      config.platforms.buzz.reconnect.base_ms >
      config.platforms.buzz.reconnect.cap_ms
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["platforms", "buzz", "reconnect", "base_ms"],
        message: "must be <= cap_ms",
      });
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
export type BuzzEndpointConfig = Extract<
  ConfigV2["agents"][number]["endpoints"][number],
  { platform: "buzz" }
>;

export interface NormalizedBuzzRuntimeConfig {
  relayUrl: string;
  privateKey: string;
  authTag: string | null;
  pubkey: string;
  respondTo: BuzzEndpointConfig["respond_to"];
  ownerPubkey: string | null;
  allowedPubkeys: string[];
  allowSharedIdentity: boolean;
  receivedEmoji: string | null;
  rerunOnEdit: boolean;
  includeReactionsInContext: boolean;
  customEmojiPalette: Record<string, string>;
  subscribe: BuzzEndpointConfig["subscribe"];
  triggers: BuzzEndpointConfig["triggers"];
  channelOverrides: Record<
    string,
    {
      requireMention?: boolean;
      sessionScope?: string;
      kinds?: number[];
    }
  >;
}

export interface NormalizedEndpointConfig {
  id: string;
  agentId: string;
  platform: "telegram" | "buzz" | "agent_api";
  enabled: boolean;
  communityId: string | null;
  externalIdentity: string | null;
  sessionScopes?: Record<string, string>;
  buzz?: NormalizedBuzzRuntimeConfig;
}

export interface NormalizedConfigModel {
  sourceVersion: 1 | 2;
  endpoints: NormalizedEndpointConfig[];
  sessions: ConfigV2["sessions"];
  buzzPlatform?: ConfigV2["platforms"]["buzz"];
  limits?: ConfigV2["limits"];
  retention?: ConfigV2["retention"];
  buzzTools?: Array<{
    agentId: string;
    policy: "read_only" | "collaborate" | "maintainer" | "custom";
    allowedCommands: string[];
    defaultEndpointId: string | null;
    allowedEndpointIds: string[];
    exposePrivateKeyToRunner: boolean;
    acknowledgeDangerous: boolean;
  }>;
  alertsTarget?: { endpointId: string; externalConversationId: string };
}

export function normalizeV2(config: ConfigV2): {
  config: Config;
  model: NormalizedConfigModel;
} {
  const bots = config.agents.map((agent) => {
    const endpoint = agent.endpoints.find(
      (candidate) => candidate.platform === "telegram",
    );
    const buzzEndpoint = agent.endpoints.find(
      (candidate) => candidate.platform === "buzz",
    );
    return {
      id: agent.id,
      // The legacy BotConfig remains the runner-host compatibility shape.
      // Buzz-only agents never construct a TelegramClient, so this sentinel
      // cannot be used for network authentication.
      token:
        endpoint?.platform === "telegram"
          ? endpoint.token
          : `disabled-buzz-only:${agent.id}`,
      transport_override:
        endpoint?.platform === "telegram"
          ? endpoint.transport_override
          : undefined,
      access_control:
        endpoint?.platform === "telegram" && endpoint.allowed_user_ids
          ? { allowed_user_ids: endpoint.allowed_user_ids }
          : undefined,
      commands: endpoint?.platform === "telegram" ? endpoint.commands : [],
      reactions:
        endpoint?.platform === "telegram"
          ? endpoint.reactions
          : buzzEndpoint?.platform === "buzz"
            ? buzzEndpoint.reactions
            : { received_emoji: null },
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
          enabled:
            endpoint.enabled &&
            (endpoint.platform === "telegram"
              ? config.platforms.telegram.enabled
              : config.platforms.buzz.enabled),
          communityId:
            endpoint.platform === "buzz" ? endpoint.community_id : null,
          externalIdentity:
            endpoint.platform === "buzz"
              ? publicKey(decodeSecret(endpoint.private_key))
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
              : Object.fromEntries(
                  Object.entries(endpoint.channel_overrides).flatMap(
                    ([id, override]) =>
                      override.session_scope
                        ? [[id, override.session_scope]]
                        : [],
                  ),
                ),
          ...(endpoint.platform === "buzz"
            ? {
                buzz: {
                  relayUrl: endpoint.relay_url,
                  privateKey: endpoint.private_key,
                  authTag: endpoint.auth_tag ?? null,
                  pubkey: publicKey(decodeSecret(endpoint.private_key)),
                  respondTo: endpoint.respond_to,
                  ownerPubkey: endpoint.owner_pubkey
                    ? normalizePubkey(endpoint.owner_pubkey)
                    : null,
                  allowedPubkeys: endpoint.allowed_pubkeys.map(normalizePubkey),
                  allowSharedIdentity: endpoint.allow_shared_identity,
                  receivedEmoji: endpoint.reactions.received_emoji,
                  rerunOnEdit: endpoint.rerun_on_edit,
                  includeReactionsInContext:
                    endpoint.include_reactions_in_context,
                  customEmojiPalette: { ...endpoint.custom_emoji_palette },
                  subscribe: endpoint.subscribe,
                  triggers: endpoint.triggers,
                  channelOverrides: Object.fromEntries(
                    Object.entries(endpoint.channel_overrides).map(
                      ([channelId, override]) => [
                        channelId,
                        {
                          ...(override.require_mention === undefined
                            ? {}
                            : { requireMention: override.require_mention }),
                          ...(override.session_scope
                            ? { sessionScope: override.session_scope }
                            : {}),
                          ...(override.kinds
                            ? { kinds: [...override.kinds] }
                            : {}),
                        },
                      ],
                    ),
                  ),
                },
              }
            : {}),
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
      sessions: {
        ...config.sessions,
        max_queue_depth_per_conversation:
          config.limits.max_queue_depth_per_conversation,
        max_queue_depth_per_agent: config.limits.max_queue_depth_per_agent,
      },
      buzzPlatform: config.platforms.buzz,
      limits: config.limits,
      retention: config.retention,
      buzzTools: config.agents.flatMap((agent) => {
        const tools = agent.tools?.buzz;
        return tools
          ? [
              {
                agentId: agent.id,
                policy: tools.policy,
                allowedCommands: [...tools.allowed_commands],
                defaultEndpointId: tools.default_endpoint_id ?? null,
                allowedEndpointIds: [...tools.allowed_endpoint_ids],
                exposePrivateKeyToRunner: tools.expose_private_key_to_runner,
                acknowledgeDangerous: tools.acknowledge_dangerous,
              },
            ]
          : [];
      }),
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
    buzzPlatform: {
      enabled: false,
      cli_path: "buzz",
      cli_sha256:
        "1f650920c370d2ba042a9e17cf381be65f43fc9e909859ac248306445a7e0aee",
      reconnect: { base_ms: 1000, cap_ms: 30_000 },
      subscription: {
        historical_limit: 500,
        replay_overlap_secs: 300,
        heartbeat_secs: 30,
      },
      message_max_bytes: 65_536,
      max_frame_bytes: 524_288,
    },
    limits: {
      dispatch_wait_warn_ms: 30_000,
      max_queue_depth_per_conversation: 50,
      max_queue_depth_per_agent: 500,
      inbound_event_rate_per_endpoint: "600/60s",
      relay_publish_timeout_ms: 10_000,
      relay_ok_wait_ms: 5000,
      reconnect_alert_after_secs: 900,
      broker_call_timeout_ms: 30_000,
      buzz_edit_cadence_ms: 2000,
      typing_min_interval_ms: 4000,
      presence_min_interval_ms: 30_000,
      reaction_min_interval_ms: 1000,
      agent_reply_rate_per_conversation: "6/60s",
      agent_reply_rate_per_endpoint: "60/60s",
    },
    retention: {
      database_size_cap_bytes: 4_294_967_296,
      inbound_payload_days: 30,
      inbound_event_days: 90,
      terminal_turn_days: 90,
      sent_outbox_days: 14,
      dead_outbox_days: 90,
      signed_sent_payload_hours: 24,
      pending_mutation_days: 30,
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
    limits: model.limits,
    retention: model.retention,
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
