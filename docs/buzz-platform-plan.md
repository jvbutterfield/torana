# Implementation Plan: Multi-platform Torana with Native Buzz Support

**Status:** Phases 0–5 complete; Phase 6 is ready to implement

**Date:** 2026-08-01 (refined same day; see §21)

**Target release:** 2.0.0 (see §6.1)

**Primary objective:** evolve Torana from a Telegram gateway into a platform-neutral agent gateway, add Buzz as a first-class platform, and give every agent an independent durable session per conversation.
**Reference implementation:** the current Telegram path remains the compatibility baseline.

---

## 1. Executive summary

Torana should own agent runtimes and conversation sessions. Telegram and Buzz should be adapters around a normalized core, not separate harnesses that each spawn their own Codex or Claude processes.

The target flow is:

```text
Telegram webhook/polling ─┐
                          ├─> platform adapter ─> normalized inbound event
Buzz relay WebSocket ─────┘                              │
                                                        v
                                          durable conversation mailbox
                                                        │
                                                        v
                                  conversation session manager + runner
                                                        │
                                                        v
                                          normalized outbound operation
                                                        │
                          ┌─────────────────────────────┴──────────────┐
                          v                                            v
                  Telegram delivery                              Buzz delivery
```

Each configured agent has one logical identity and one or more platform endpoints. Each endpoint has its own external credential and address, but all endpoints share the agent's runner configuration, tools, persona, and long-term memory.

Conversation context is not global to an agent. The default session key is:

```text
(agent_id, platform, community_or_account, conversation_id)
```

For Buzz forum channels, the forum root event is the conversation. For stream channels, the channel is the conversation by default, with an optional thread-isolation policy. For Telegram, the chat is the conversation. Agent API callers continue to choose a stable `session_id` or request an ephemeral session.

The existing Agent API side-session implementation is promoted into a general conversation-session manager. It must preserve the current resource controls while adding durable provider-native session identifiers, per-conversation queues, restart recovery, and lazy rehydration.

This is a versioned platform expansion, not a one-file transport addition. The recommended public configuration is `version: 2`; `version: 1` remains accepted and is normalized internally to the new model.

---

## 2. Goals

1. Keep one Torana process as the owner of every configured agent runner.
2. Support Telegram and Buzz simultaneously for the same logical agent.
3. Preserve existing Telegram behavior and v1 configuration compatibility for traffic within the documented resource limits; overload becomes explicitly bounded rather than silently unbounded.
4. Give each conversation an isolated, reusable, durable Codex/Claude session.
5. Allow conversations to run concurrently while serializing turns within one conversation.
6. Provide crash-safe ingress, deduplication, bounded queues, and idempotent outbox delivery retry for both platforms; never automatically repeat a dispatched runner turn.
7. Support all stable Buzz conversation capabilities natively where they affect delivery or routing.
8. Expose all other stable Buzz capabilities to the agent through the installed Buzz CLI and skill rather than duplicating the entire Buzz application inside Torana.
9. Give each Buzz endpoint a distinct cryptographic identity and keep raw keys out of runners, while treating one Torana installation/container as one explicit trust domain (§10.3).
10. Make mixed Telegram/Buzz deployments observable, testable, and safe to roll back.

---

## 3. Non-goals

1. Reimplementing the Buzz relay, search index, workflow engine, git server, Blossom media store, or moderation backend in Torana.
2. Replacing `buzz-cli` as the agent-facing workspace tool.
3. Making Telegram and Buzz conversations share context by default. Cross-platform continuity requires an explicit session alias.
4. Treating every Nostr event kind as an agent prompt. Only configured trigger kinds enter a conversation mailbox.
5. Supporting Buzz features that are described only as future/experimental and have no stable event or CLI contract. The adapter must ignore unknown kinds safely and make them easy to add later.
6. Hand-rolling secp256k1 or Schnorr cryptography. Use an audited Nostr implementation and verify it against Buzz golden vectors.
7. Automatically granting channel membership or broadening a Buzz agent's access. Membership remains an operator/owner action.
8. Running a second `buzz-acp` agent process beside Torana for the same identity and workspace.

---

## 4. Current-state findings

The runner layer is already mostly reusable:

- Claude Code, Codex, and compatible command runners implement isolated side sessions (`src/runner/*.ts`, `runnerSupportsSideSessions()`).
- `SideSessionPool` (`src/agent-api/pool.ts`) already enforces per-session concurrency, idle/hard TTLs, LRU eviction, per-bot capacity, global capacity, **and a third per-token concurrency dimension** (`agent_api.side_sessions.max_per_token_default` plus per-token `max_concurrent_side_sessions`), and shutdown cleanup.
- Codex already carries continuity with a native thread ID, persisted per bot in `worker_state.codex_thread_id` by migration `0003_runner_session_resume.sql`.
- Agent API `ask` already returns a result from an isolated session.

The rest of the primary path remains Telegram-coupled:

- `src/transport/types.ts` transports raw `TelegramUpdate` values. `webhook` and `polling` are Telegram delivery modes, not communication platforms.
- `Bot` (`src/core/bot.ts`) owns a `TelegramClient`.
- `processUpdate` (`src/core/process-update.ts`) performs Telegram shape parsing, ACL checks, reactions, attachment download, and command dispatch in one function.
- `chat_id`, `message_id`, `telegram_update_id`, and `telegram_message_id` are numeric schema columns — as are `stream_state.active_telegram_message_id` and `user_chats.chat_id`.
- `inbound_updates` reuses `telegram_update_id` for Agent-API-origin rows by synthesizing **negative** values (`idx_inbound_bot_negid`). Any replacement identifier scheme must preserve that separation.
- streaming and outbox code call Telegram methods directly and render Telegram HTML.
- alert delivery is Telegram-only.
- one primary runner and one `activeTurnId` exist per bot, so different conversations cannot run concurrently.
- side-session native IDs are not durable across gateway restarts: `0003` persists a thread ID for the **primary** runner only; the `side_sessions` table carries no provider resume state.
- runner session IDs are constrained to `SIDE_SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/` (`src/runner/types.ts`), and Claude CLI 2.1+ additionally requires the value it receives via `--session-id` to be a UUID — the claude-code runner therefore mints a private `claudeUuid` per side session rather than passing Torana's session ID through.

The implementation must separate five concerns that are currently interleaved:

1. platform connectivity;
2. inbound normalization and authorization;
3. durable conversation routing;
4. runner session ownership;
5. platform-specific outbound delivery.

---

## 5. Terminology and target domain model

### 5.1 Public terminology

- **Agent**: a logical Torana runtime such as `cato` or `harper`.
- **Endpoint**: one external identity through which an agent communicates, such as a Telegram bot token or Buzz Nostr keypair.
- **Platform/ingress kind**: external messaging platforms are `telegram` and `buzz`; `agent_api` is an internal virtual ingress used so API sessions and events share the normalized persistence/session machinery without pretending to be an external endpoint.
- **Community**: a stable operator-chosen Buzz community ID. It normally maps to one relay deployment but is not derived from a mutable URL.
- **Conversation**: a durable message context such as a Telegram chat, Buzz DM, Buzz stream channel, or Buzz forum thread.
- **Session**: provider-native conversation state owned by a runner for one Torana conversation.
- **Turn**: one queued inbound prompt and its resulting output.

Keep `bot_id` compatibility aliases in v1 APIs and metrics, but use `agent_id` in new internal types and v2 surfaces.

### 5.2 Normalized inbound event

```ts
interface InboundEvent {
  platform: "telegram" | "buzz" | "agent_api";
  endpointId: string;
  agentId: string;
  communityId: string | null;
  // Null only for endpoint/community-scoped control-plane events such as
  // presence or membership lifecycle notifications with no channel scope.
  conversation: ConversationRef | null;
  externalEventId: string;
  externalMessageId: string | null;
  // Required for edits, deletes, reactions, and votes. Never overload replyTo
  // with mutation targeting.
  targetExternalEventId: string | null;
  // Required for workflow_event. It is not a thread root.
  workflowRunId: string | null;
  sender: ExternalPrincipal;
  kind: // conversation-plane: may create a turn
    | "message"
    | "message_edit"
    | "message_delete"
    | "reaction"
    | "forum_post"
    | "forum_comment"
    | "forum_vote"
    | "workflow_event"
    | "control"
    // control-plane: never creates a turn (see below)
    | "membership_change"
    | "channel_lifecycle"
    | "presence"
    | "typing";
  text: string;
  markdown: boolean;
  replyTo: string | null;
  rootEventId: string | null;
  mentions: string[];
  attachments: RemoteAttachment[];
  occurredAt: number;
  receivedSeq: number;
  raw: unknown;
}
```

Rules:

- External IDs are always strings internally. Telegram integers are converted to canonical decimal strings at the adapter boundary.
- `externalMessageId` is null for events that reference no message (`presence`, `typing`, `membership_change`, `channel_lifecycle`, and some `control` events).
- `targetExternalEventId` is required for `message_edit`, `message_delete`, `reaction`, and `forum_vote`; it identifies the affected event and is distinct from the mutation's own `externalEventId` and from conversational `replyTo`.
- `workflowRunId` is required for `workflow_event` and null otherwise. Core routing never extracts it from `raw`.
- **Conversation-plane vs control-plane.** Only conversation-plane kinds may enter a conversation mailbox and produce a turn. Control-plane kinds are handled synchronously by the adapter (subscription changes, endpoint presence state, session close) and are persisted to `inbound_events` for audit only, with status `control`. This split is what keeps §10.1's "membership discovery", "archive/leave/remove", "presence", and "typing" rows representable — previously they had no legal `kind`.
- `occurredAt` is author-supplied and untrusted (see §9.4). `receivedSeq` is the gateway-assigned monotonic receive sequence and is the **only** ordering authority.
- **Telegram scope note.** `transport.allowed_updates` defaults to `["message"]`, so Telegram never delivers edits or reactions today. `message_edit`, `message_delete`, and `reaction` are Buzz-only inbound kinds in this plan; enabling them for Telegram is deliberately out of scope and would be a follow-on change to `allowed_updates` plus `TelegramAdapter.normalizeInbound`.

### 5.3 Conversation reference

```ts
interface ConversationRef {
  platform: "telegram" | "buzz" | "agent_api";
  communityId: string | null;
  endpointId: string;
  channelId: string;
  threadRootId: string | null;
  workflowRunId: string | null;
  type: "direct" | "stream" | "forum" | "workflow" | "group" | "api";
}
```

`type: "direct"` is the internal enum value; `dm` is its token in the canonical key below. Canonical key rules:

- Telegram: `telegram:<endpoint>:chat:<chat_id>`.
- Buzz DM: `buzz:<community>:<endpoint>:dm:<channel_uuid>`.
- Buzz stream default: `buzz:<community>:<endpoint>:stream:<channel_uuid>`.
- Buzz stream with thread isolation: append `:thread:<root_event_id>`.
- Buzz forum: `buzz:<community>:<endpoint>:forum:<channel_uuid>:thread:<root_event_id>`.
- Workflow-triggered conversation: `buzz:<community>:<endpoint>:workflow:<channel_uuid>:run:<run_id>` when enabled. `run_id` comes from `ConversationRef.workflowRunId`; adapters must not overload `threadRootId`.
- Agent API keyed session: `agent-api:<agent_id>:session:<session_id>`. This intentionally omits token name and preserves the current `(bot_id, session_id)` sharing behavior; token identity controls authorization and concurrency, not context identity.
- Agent API ephemeral request: no durable conversation key; the internal session key is `ephemeral:<turn_uuid>`. The existing HTTP response continues to expose `session_id: eph-<turn_uuid>` for compatibility, while the runner receives only the derived 46-character runner ID below.

**Telegram forum topics.** Telegram supergroups can carry topics (`message_thread_id`). This plan deliberately keys Telegram conversations on `chat_id` alone, so all topics in one supergroup share a session — matching today's behavior exactly. The escape hatch is an endpoint-level `telegram_topic_isolation: true` that appends `:thread:<message_thread_id>`; it is defined here but ships disabled and untested until an operator needs it.

**Conversation key versus session key.** The canonical key above identifies one durable conversation and is stored as `conversations.conversation_key`. A session policy resolves that conversation to a separate `session_key`:

- `conversation`/`thread`: the canonical conversation key;
- `legacy_agent`: `legacy-agent:<agent_id>`;
- `alias:<name>`: `alias:<agent_id>:<name>`;
- `ephemeral`: `ephemeral:<turn_uuid>` and is not retained after the turn.

Several conversations may therefore reference one session key. This is required for `legacy_agent` and explicit aliases; uniqueness belongs to `conversation_sessions.session_key`, not `conversations.session_key`. An `ephemeral` conversation has no durable session binding: its `conversations.session_key` is NULL and each turn creates a temporary session record that is removed at terminal completion.

**Runner-facing session ID.** The resolved session key is _not_ passed directly to runners: `:` is illegal under `SIDE_SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/`. The runner-facing ID is derived as:

```text
session-<first 38 chars of base32(sha256(session_key))> # exactly 46 chars
```

- separator is `-`, alphabet is lowercase RFC 4648 base32 without padding (`[a-z2-7]`), and output length is exactly 46 characters (`session-` plus 38 digest characters), below the 64-character runner limit. Ephemeral sessions use the same derivation from `ephemeral:<turn_uuid>`; the legacy public `eph-<uuid>` value may still be returned by Agent API but is never passed directly to a runner.
- The digest is _not_ the provider's session identifier. Providers keep their own: Codex a `thread_id`, Claude a UUID minted by the runner and passed via `--session-id`. Those live in `conversation_sessions.provider_state_json`, never in the Torana session ID.
- The unhashed conversation key remains in `conversations.conversation_key`; the resolved session key and runner ID live in `conversation_sessions` and are referenced by every bound conversation.

### 5.4 Normalized outbound operation

```ts
type OutboundOperation =
  | { kind: "send"; text: string; files: LocalAttachment[]; replyTo?: string }
  | { kind: "edit"; externalMessageId: string; text: string }
  | { kind: "delete"; externalMessageId: string; reason?: string }
  | { kind: "reaction_add"; externalMessageId: string; emoji: string }
  | { kind: "reaction_remove"; externalMessageId: string; emoji: string }
  | { kind: "forum_post"; channelId: string; title: string; text: string }
  | {
      kind: "forum_comment";
      rootEventId: string;
      text: string;
      replyTo?: string;
    }
  | {
      kind: "vote";
      externalMessageId: string;
      direction: "up" | "down";
    };

type EphemeralSignal =
  | { kind: "typing"; active: boolean }
  | { kind: "presence"; state: "online" | "away" | "offline" };
```

Each platform adapter advertises capabilities. Core code must use capability checks and graceful fallback rather than platform conditionals.

**Union boundary.** `OutboundOperation` is the complete set of **durable** operations Torana performs on the operator's behalf, and the complete set of `outbox.operation_kind` values. `EphemeralSignal` bypasses the outbox: it is rate-limited, best effort, and never replayed after a crash. Every other Buzz mutation — channel administration, workflows, repos, moderation, memory, canvas — is an _agent_ action and goes through the credential broker and `buzz-cli` (§10.2), never through the outbox. Adding a capability to the durable union is a deliberate decision to make Torana responsible for its delivery, retry, and idempotency.

Only `send`, `edit`, `forum_post`, and `forum_comment` are turn-bearing. `reaction_add`, `reaction_remove`, `delete`, and `vote` may be emitted with no owning turn — see the `outbox.turn_id` nullability requirement in §8.1. Typing and presence never create outbox rows.

---

## 6. Public configuration v2

### 6.1 Three independent version counters

The repository already uses "v2" for something else. Do not conflate:

| Counter                                        | Current value                                  | Meaning                                   | Changed by this plan                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Config `version:`                              | `1` (`z.literal(1)` in `src/config/schema.ts`) | Public YAML contract                      | `1` stays valid; `2` added                                                                                                           |
| SQLite `PRAGMA user_version`                   | `3` (set by `0003_runner_session_resume.sql`)  | Applied migration count                   | advances to `5`                                                                                                                      |
| `schema.sql` header comment "torana v2 schema" | prose only                                     | Historical, refers to the _config_ v1 era | corrected to remove the ambiguity                                                                                                    |
| Package semver                                 | `1.0.0-rc.9`                                   | Release                                   | compatibility bridge `1.0.0-rc.10` first, then **`2.0.0`** — config v2, DB schema change, and README repositioning justify the major |

Config v1 files continue to load on 2.x. The major reflects the new default surface, not a break for existing operators.

### 6.2 Recommended shape

```yaml
version: 2

gateway:
  port: 3001
  bind_host: 127.0.0.1
  data_dir: /data/gateway
  # db_path, log_level, log_format carry over from v1 unchanged

platforms:
  telegram:
    enabled: true
    api_base_url: https://api.telegram.org
    delivery:
      default_mode: webhook
      allowed_updates: [message]
      webhook:
        base_url: ${TELEGRAM_WEBHOOK_BASE_URL}
        secret: ${TELEGRAM_WEBHOOK_SECRET}
      polling:
        timeout_secs: 25
        backoff_base_ms: 1000
        backoff_cap_ms: 30000
        max_updates_per_batch: 100

  buzz:
    enabled: false            # master kill switch; §11 Phase 11 rollout flag
    reconnect:
      base_ms: 1000
      cap_ms: 30000
    subscription:
      historical_limit: 500
      replay_overlap_secs: 300
      heartbeat_secs: 30
    message_max_bytes: 65536
    max_frame_bytes: 524288

access_control:
  default_policy: deny
  allowed_user_ids: [${TELEGRAM_ALLOWED_USER_ID}]   # global Telegram fallback (v1 parity)

sessions:
  scope: conversation
  idle_process_ttl_ms: 3600000
  hard_process_ttl_ms: 86400000
  context_retention_ms: 7776000000
  max_per_agent: 8                    # approved by Phase 0 capacity evidence
  max_global: 32                      # approved with 43.1% projected memory headroom
  max_per_token_default: 8            # Agent API per-token cap; see §7.1
  max_concurrent_turns_per_agent: 2
  max_concurrent_turns_global: 12
  overflow: queue                     # queue | reject — see §7.7
  aliases: []                         # explicit same-agent aliases; see §7.4

limits:
  dispatch_wait_warn_ms: 30000        # queued-turn age that raises a warning
  max_queue_depth_per_conversation: 50
  max_queue_depth_per_agent: 500
  inbound_event_rate_per_endpoint: "600/60s"
  relay_publish_timeout_ms: 10000
  relay_ok_wait_ms: 5000
  reconnect_alert_after_secs: 900     # alert, mark unhealthy, and keep probing
  broker_call_timeout_ms: 30000
  buzz_edit_cadence_ms: 2000          # streaming edit rate for Buzz (Telegram stays 1500)
  typing_min_interval_ms: 4000
  presence_min_interval_ms: 30000
  reaction_min_interval_ms: 1000
  agent_reply_rate_per_conversation: "6/60s"   # tag-independent loop backstop, §9.5
  agent_reply_rate_per_endpoint: "60/60s"      # fan-out backstop across conversations

retention:
  database_size_cap_bytes: 4294967296
  inbound_payload_days: 30
  inbound_event_days: 90
  terminal_turn_days: 90
  sent_outbox_days: 14
  dead_outbox_days: 90
  signed_sent_payload_hours: 24
  pending_mutation_days: 30

# worker_tuning, streaming, outbox, shutdown, dashboard, metrics,
# attachments, and agent_api carry over from v1 unchanged (§6.3).
# alerts gains an additive normalized target; legacy fields remain accepted.

agents:
  - id: cato
    runner:
      type: codex
      cwd: /data/content
      pass_resume_flag: true
      env:
        CODEX_HOME: /data/state/codex-config/cato

    endpoints:
      - id: cato-telegram
        platform: telegram
        enabled: true
        token: ${TELEGRAM_BOT_TOKEN_CATO}
        allowed_user_ids: [${TELEGRAM_ALLOWED_USER_ID}]
        reactions:
          received_emoji: "👀"
        commands:
          - { trigger: /reset,  action: builtin:reset }
          - { trigger: /cancel, action: builtin:cancel }
          - { trigger: /status, action: builtin:status }
        chat_overrides: {}
        # Example cross-platform alias binding after declaring
        # sessions.aliases: [{ name: owner, agent_id: cato }]
        # chat_overrides:
        #   "123456789": { session_scope: "alias:owner" }

      - id: cato-buzz
        platform: buzz
        enabled: false
        community_id: primary
        relay_url: ${BUZZ_RELAY_URL}
        private_key: '${BUZZ_PRIVATE_KEY_CATO}'
        auth_tag: '${BUZZ_AUTH_TAG_CATO}'
        respond_to: owner_only
        owner_pubkey: '${BUZZ_OWNER_PUBKEY}'
        allowed_pubkeys: []       # required and non-empty when respond_to: allowlist
        subscribe: mentions_and_dms
        reactions:
          received_emoji: "👀"       # null disables acknowledgement reactions
        rerun_on_edit: false
        include_reactions_in_context: false
        custom_emoji_palette: {}      # shortcode -> HTTPS URL
        triggers:
          feed:
            enabled: false
            modes: [mentions, needs_action]
            interval_secs: 300
          workflows:
            enabled: false
            event_kinds: []           # populated from Phase 0's pinned kind manifest
          heartbeat:
            enabled: false
            interval_secs: 900
            target_channel: 0d209c9d-44b5-49f7-9aa9-9837c734fc20
            prompt: "Review Buzz for work that needs attention."
        # allow_shared_identity: false   # see rule 3
        channel_overrides:
          0d209c9d-44b5-49f7-9aa9-9837c734fc20:
            require_mention: true
            session_scope: channel
          8c449dc9-0000-0000-0000-000000000000:
            require_mention: false
            session_scope: thread
            kinds: [45001, 45003]

    tools:
      buzz:
        policy: collaborate          # see §10.4 for profile contents
        # Required for Buzz tool access from Telegram and Agent API turns.
        # Buzz-origin turns use their own endpoint unless policy narrows them.
        default_endpoint_id: cato-buzz
        allowed_endpoint_ids: [cato-buzz]
        expose_private_key_to_runner: false
        acknowledge_dangerous: false
```

The session-cap values above are the approved v2 defaults for the measured production deployment. Phase 0 combined authenticated 1/2/8/32-way provider peaks with the Railway service's 32,768 MB ceiling and 808.52 MB maximum gateway baseline. `max_global: 32` projects 18,629.77 MB after a 25% platform margin, leaving 43.1% memory headroom; `max_concurrent_turns_global: 12` projects 77.1% headroom under the same conservative calculation. `max_global: 64` remains rejected. A material deployment limit or runner-version change requires recalibration using `spike/buzz-transport/measure-authenticated-capacity.ts`.

Rules:

1. Each agent requires at least one endpoint.
2. Agent IDs reuse the existing `BotIdSchema` (`^[a-z][a-z0-9_-]{0,31}$`, reserved words `health|metrics|dashboard|webhook`). Endpoint IDs use the same charset with a 48-character limit, must be unique globally, and must not collide with any agent ID — endpoint IDs appear in URL path segments and in the session-ID digest input. Note the webhook route moves from `/webhook/:botId` to `/webhook/:endpointId`; because Torana re-issues `setWebhook` for every endpoint at startup, existing installs self-heal on first boot, but the change must be called out in the upgrade notes for operators who pin the path in a reverse proxy.
3. A Buzz private key may not be reused by two endpoints in one process unless `allow_shared_identity: true` is explicitly set and doctor warns about shared outbox ordering. Sharing an identity means both endpoints publish under one pubkey, so relay-side ordering and the §9.5 self-event rejection become process-wide rather than per-endpoint.
4. Private keys and auth tags are secret-bearing fields, redacted during validation and logs. Add `agents[].endpoints[].private_key` and `.auth_tag` to `SECRET_PATHS` in `src/config/schema.ts`.
5. If `auth_tag` is configured, load-time validation parses its canonical NIP-OA condition grammar, verifies its BIP-340 signature against the endpoint pubkey derived from `private_key`, rejects self-attestation, and requires its owner pubkey to equal `owner_pubkey`. The core reply kind `9` must be authorized by the tag conditions or the endpoint is invalid. Other outbound capabilities are advertised only when their event kind satisfies the conditions; a disallowed operation fails before signing. The same verified tag is attached to NIP-42 AUTH for membership delegation, matching the pinned Buzz client contract.
6. `owner_only` requires a resolvable owner pubkey. Failure is fail-closed.
7. Existing `version: 1` files remain valid. The loader converts each v1 `bots[]` entry into one agent with one Telegram endpoint and `sessions.scope: legacy_agent`.
8. Provide `torana config upgrade --from v1 --to v2` to print a reviewable v2 file. Never overwrite the operator's file automatically.
9. `platforms.buzz.enabled: false` (the default) forces every Buzz endpoint to the operational `disabled` state: no connection, subscription, dispatch, or publish. Per-endpoint `enabled: false` does the same for one endpoint while leaving its cursor, queued work, outbox rows, and sessions intact (§14.3). Disabling is reversible and therefore does **not** itself dead-letter pending work. Runtime lifecycle has three persisted states: `active` accepts and delivers work; `draining` stops intake/cursor advancement and proactive triggers while already accepted turns and outbox rows continue; `disabled` stops both intake and delivery. Transitioning from `draining` to `disabled` requires an empty accepted-work/outbox backlog or an explicit `--dead-letter-pending` acknowledgement.
10. `tools.buzz` is enforced by the Phase 9 endpoint-scoped broker. Runners receive only a short-lived session capability by default; the broker retains credentials, selects the endpoint, constructs the pinned CLI arguments, and applies the configured command/resource policy before execution. The raw-key escape hatch requires the explicit acknowledgements in §10.3.
11. `sessions.aliases[]` entries have `{name, agent_id}` and are declarations, not inferred bindings. An endpoint or channel may select `session_scope: alias:<name>` only when the declaration belongs to the same agent. The effective session key is `alias:<agent_id>:<name>`; cross-agent aliases are rejected.
12. Feed, workflow, and heartbeat triggers are disabled unless their endpoint-level `triggers.*.enabled` flag is true. Feed polling and heartbeats require an interval; heartbeats also require an explicit target channel and prompt. Workflow event kinds come from the pinned Phase 0 manifest rather than free-form defaults.
13. `reconnect_alert_after_secs` never stops reconnect attempts. It marks the endpoint unhealthy and alerts while probes continue at the configured capped backoff; recovery is automatic when a probe succeeds.
14. The loader creates one non-connectable virtual endpoint row per agent for Agent API persistence, with ID `<agent_id>-agent-api` and platform `agent_api`. User-defined endpoint IDs may not collide with these reserved derived IDs. The virtual endpoint owns no external credential or connection and is omitted from external endpoint counts/status unless explicitly requested by an admin view.
15. Telegram `chat_overrides` keys are canonical decimal chat IDs. Buzz `channel_overrides` keys are channel UUIDs. Both may set `session_scope`, including a declared same-agent alias; this is the explicit mechanism for binding one Telegram chat and one Buzz conversation to shared context.
16. Every Buzz endpoint requires `community_id`, matching `^[a-z][a-z0-9_-]{0,47}$`. It is a stable routing identifier, not a relay URL hash: changing a hostname, scheme, proxy, or failover URL must not fork conversation keys. Reusing one `community_id` across endpoints means those endpoints intentionally address the same logical community.
17. `respond_to` is exactly `owner_only | allowlist | anyone | nobody`. `owner_only` requires `owner_pubkey`; `allowlist` requires a non-empty `allowed_pubkeys`; the other modes reject a supplied allowlist to prevent misleading configuration. Pubkeys normalize to lowercase 64-character hex at load; `npub` input is accepted only if the Phase 0 library supplies strict NIP-19 decoding. Channel overrides may narrow the endpoint policy but may not broaden it. Agent-authored stream events still require an explicit mention under §9.5 regardless of author policy.
18. `tools.buzz.allowed_endpoint_ids` may contain only Buzz endpoints owned by the same agent. A Buzz-origin turn is broker-bound to its ingress endpoint, provided that endpoint is allowed. Telegram and Agent API turns receive no Buzz broker credential unless `default_endpoint_id` is explicitly configured and allowed. Scheduled endpoint triggers are bound to the endpoint that owns the trigger. A typed call cannot select or override another endpoint after the credential is minted; ambiguous selection fails closed.
19. V2 alert delivery uses `alerts.target: {endpoint_id, external_conversation_id}`. The endpoint must be publishable and the conversation must already be observed or explicitly provisioned. Legacy `alerts.via_bot` plus numeric `chat_id` remains accepted for v1 and during the bridge; in explicit v2 it resolves only when `via_bot` names an agent with exactly one Telegram endpoint. Multiple candidates are a validation error, never a first-endpoint fallback. Supplying both target forms is invalid.

### 6.3 Complete v1 → v2 key mapping

`torana config upgrade` must handle every v1 key. Anything not listed here is a bug in the upgrade tool, not an operator error.

| v1 key                                                                | v2 key                                                                                                                                                                       | Conversion                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version: 1`                                                          | `version: 2`                                                                                                                                                                 | literal                                                                                                                                                                                                                                                                                                                                                        |
| `gateway.*`                                                           | `gateway.*`                                                                                                                                                                  | unchanged                                                                                                                                                                                                                                                                                                                                                      |
| `telegram.api_base_url`                                               | `platforms.telegram.api_base_url`                                                                                                                                            | move                                                                                                                                                                                                                                                                                                                                                           |
| `transport.default_mode`                                              | `platforms.telegram.delivery.default_mode`                                                                                                                                   | move                                                                                                                                                                                                                                                                                                                                                           |
| `transport.allowed_updates`                                           | `platforms.telegram.delivery.allowed_updates`                                                                                                                                | move                                                                                                                                                                                                                                                                                                                                                           |
| `transport.webhook.*`                                                 | `platforms.telegram.delivery.webhook.*`                                                                                                                                      | move                                                                                                                                                                                                                                                                                                                                                           |
| `transport.polling.*`                                                 | `platforms.telegram.delivery.polling.*`                                                                                                                                      | move                                                                                                                                                                                                                                                                                                                                                           |
| `access_control.allowed_user_ids`                                     | `access_control.allowed_user_ids`                                                                                                                                            | unchanged; becomes the fallback when an endpoint omits its own list. `default_policy: deny` is added and describes existing behavior                                                                                                                                                                                                                           |
| `bots[].access_control.allowed_user_ids`                              | `agents[].endpoints[0].allowed_user_ids`                                                                                                                                     | move to the Telegram endpoint                                                                                                                                                                                                                                                                                                                                  |
| `bots[].id`                                                           | `agents[].id` **and** `agents[].endpoints[0].id` = `<id>-telegram`                                                                                                           | derive                                                                                                                                                                                                                                                                                                                                                         |
| `bots[].token`                                                        | `agents[].endpoints[0].token`                                                                                                                                                | move                                                                                                                                                                                                                                                                                                                                                           |
| `bots[].transport_override.mode`                                      | `agents[].endpoints[0].delivery_mode`                                                                                                                                        | rename                                                                                                                                                                                                                                                                                                                                                         |
| `bots[].reactions`                                                    | `agents[].endpoints[0].reactions`                                                                                                                                            | move                                                                                                                                                                                                                                                                                                                                                           |
| `bots[].commands[]`                                                   | `agents[].endpoints[0].commands[]`                                                                                                                                           | move **verbatim** — the `{trigger, action}` object shape is retained. `builtin:cancel` is the one new action                                                                                                                                                                                                                                                   |
| `bots[].runner.*`                                                     | `agents[].runner.*`                                                                                                                                                          | move. `claude-code.pass_continue_flag` is deprecated: under `sessions.scope: conversation` continuity comes from managed per-conversation state (§7.3), not `--continue`. Retained and honored only under `sessions.scope: legacy_agent`; doctor warns otherwise. Command runners receive compatibility defaults for `process_model` and `resume_model` (§7.2) |
| `alerts.cooldown_ms`                                                  | `alerts.cooldown_ms`                                                                                                                                                         | unchanged                                                                                                                                                                                                                                                                                                                                                      |
| `alerts.via_bot` / numeric `chat_id`                                  | legacy form retained; optional v2 `alerts.target` added                                                                                                                      | upgrade emits `target.endpoint_id = '<via_bot>-telegram'` and decimal-string `external_conversation_id`; explicit v2 rejects ambiguous legacy resolution (§6 rule 18)                                                                                                                                                                                          |
| `worker_tuning.*`                                                     | `worker_tuning.*`                                                                                                                                                            | unchanged; scope clarified in §7.7                                                                                                                                                                                                                                                                                                                             |
| `streaming.*`                                                         | `streaming.*`                                                                                                                                                                | unchanged (Telegram); Buzz uses `limits.buzz_edit_cadence_ms` and `platforms.buzz.message_max_bytes`                                                                                                                                                                                                                                                           |
| `outbox.*`, `shutdown.*`, `dashboard.*`, `metrics.*`, `attachments.*` | same                                                                                                                                                                         | unchanged                                                                                                                                                                                                                                                                                                                                                      |
| `agent_api.enabled/tokens/send/ask/expose_runner_type`                | same                                                                                                                                                                         | unchanged. `agent_api.tokens[].bot_ids` accepts agent IDs; the key name is kept for compatibility (§5.1)                                                                                                                                                                                                                                                       |
| `agent_api.side_sessions.idle_ttl_ms`                                 | `sessions.idle_process_ttl_ms`                                                                                                                                               | move                                                                                                                                                                                                                                                                                                                                                           |
| `agent_api.side_sessions.hard_ttl_ms`                                 | `sessions.hard_process_ttl_ms`                                                                                                                                               | move                                                                                                                                                                                                                                                                                                                                                           |
| `agent_api.side_sessions.max_per_bot`                                 | `sessions.max_per_agent`                                                                                                                                                     | move                                                                                                                                                                                                                                                                                                                                                           |
| `agent_api.side_sessions.max_global`                                  | `sessions.max_global`                                                                                                                                                        | move                                                                                                                                                                                                                                                                                                                                                           |
| `agent_api.side_sessions.max_per_token_default`                       | `sessions.max_per_token_default`                                                                                                                                             | move                                                                                                                                                                                                                                                                                                                                                           |
| `agent_api.tokens[].max_concurrent_side_sessions`                     | unchanged, in place                                                                                                                                                          | still a per-token override of `sessions.max_per_token_default`                                                                                                                                                                                                                                                                                                 |
| —                                                                     | `sessions.context_retention_ms`, `sessions.scope`, `sessions.max_concurrent_turns_*`, `sessions.overflow`, `sessions.aliases`, `limits.*`, `retention.*`, `platforms.buzz.*` | new, defaulted                                                                                                                                                                                                                                                                                                                                                 |

`agent_api.side_sessions` remains **accepted** in v2 and is normalized into `sessions.*` at load with a deprecation warning; setting both forms for the same concept is a validation error. This is what makes "one session manager" (§7) true rather than two config blocks racing to configure one pool. All existing `superRefine` invariants carry over against the merged values: `idle <= hard`, `max_per_agent <= max_global`, `max_per_token_default <= max_global`, and per-token overrides `<= max_global`. Alias names are unique within an agent, alias declarations reference an existing agent, and every `session_scope: alias:<name>` resolves to a declaration owned by that endpoint's agent.

---

## 7. Independent conversation sessions

### 7.1 Session manager

Replace the split between one primary runner and Agent API side sessions with `ConversationSessionManager`.

Responsibilities:

- derive and persist the canonical conversation key;
- acquire or lazily create a runner session;
- serialize turns within one session;
- permit bounded concurrency across sessions;
- maintain per-agent, global, **and per-Agent-API-token** acquired-session caps — the per-token dimension already exists in `SideSessionPool` (`sessions.max_per_token_default` plus per-token `max_concurrent_side_sessions`) and defends tokens whose `bot_ids` span many agents from exhausting shared capacity. A resident session holds its slot while its process lives; a per-turn session holds one only while acquired for execution. Losing the per-token dimension during the promotion would be a silent security regression;
- maintain the global concurrent-turn ceiling (`sessions.max_concurrent_turns_global`) independently of the live-session caps, so host CPU/FD load is bounded even when every session is legally resident;
- evict only idle processes, never durable context records;
- persist provider-native session state after every change;
- resume context after a Torana restart;
- cancel one conversation turn independently; rotate/reset its resolved session, affecting every conversation deliberately bound to that session by `legacy_agent` or an alias;
- expose status, list, and reset APIs;
- support ephemeral Agent API sessions;
- enforce fair dispatch so one noisy channel cannot starve others.

### 7.2 Durable versus live state

Separate these concepts:

- **Conversation record:** durable routing and history metadata; survives process eviction and restart.
- **Provider session state:** Codex thread ID, Claude session UUID/resume metadata, command-runner state token; survives restart when supported.
- **Live process:** expendable runtime resource; bounded by TTL and capacity.
- **Mailbox:** durable queued turns up to the configured hard caps; pool exhaustion queues below the caps and produces an explicit terminal rejection at a cap, never a silent drop.

`hard_process_ttl_ms` kills/recycles a process but does not erase conversation context. `context_retention_ms` controls when inactive provider-native resume metadata is cleared. The `conversation_sessions` routing row remains while any conversation references it; expiration resets `provider_state_json`, advances its generation, and makes the next turn start fresh rather than deleting a referenced row.

**Resident vs. per-turn runners.** The two supported runners have fundamentally different process models, and the caps mean different things for each. This must be explicit in the manager, not papered over:

|                                | claude-code (resident)                                | codex (per-turn)                                            |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------- |
| Process lifetime               | long-lived subprocess fed stdin envelopes             | fresh `codex exec [resume <id>]` per turn, exits after      |
| Between turns                  | process idles, holding memory/FDs                     | **no process exists**                                       |
| `idle_process_ttl_ms`          | meaningful — reclaims idle memory                     | no-op; nothing to reclaim                                   |
| LRU eviction                   | meaningful                                            | no-op                                                       |
| `max_per_agent` / `max_global` | bounds acquired sessions and therefore live processes | bounds acquired per-turn session slots; no idle slot exists |
| Context continuity             | on-disk session file keyed by `--session-id <uuid>`   | `thread_id` passed to `exec resume`                         |
| Restart survival               | survives if the session file and UUID persist         | survives via persisted `thread_id`                          |

Command-runner protocol names describe wire parsing, not process lifetime. The existing command runner keeps both `claude-ndjson` and `codex-jsonl` side-session subprocesses resident, so changing `codex-jsonl` to per-turn would break v1 behavior. Every runner factory therefore advertises two independent capabilities:

```ts
interface RunnerSessionCapabilities {
  processModel: "resident" | "per_turn" | "stateless";
  resumeModel: "provider_state" | "stable_session_id" | "none";
}
```

- built-in `claude-code`: `resident` + `provider_state`;
- built-in `codex`: `per_turn` + `provider_state`;
- command runner: `process_model` defaults to `resident` for `claude-ndjson` and `codex-jsonl`, preserving current behavior, and to `stateless` for `jsonl-text`; an operator may select `per_turn` only when the wrapped command supports one invocation per turn;
- command runner durable continuity is opt-in with `resume_model: stable_session_id`, which promises that the wrapper persists and restores context keyed by `TORANA_SESSION_ID`. `resume_model: none` is the default and supports only `ephemeral` session policy in explicit v2 configuration. V1 `legacy_agent` configuration retains the current primary-runner behavior without claiming restart durability.

`max_concurrent_turns_per_agent/global` is an independent, normally lower scheduler ceiling across both models; it is not an alias for the acquired-session caps. This preserves the Agent API's capacity/busy 429 distinctions while separately bounding actual execution.

Consequence: for per-turn runners, "rehydration" is not a process operation — it is simply passing the persisted resume token on the next turn. Gates and metrics that assume an evictable process must be written per model (see §11 Phase 3).

### 7.3 Runner interface changes

Replace bespoke side-session methods with a generic session contract:

```ts
interface AgentRunnerFactory {
  sessionCapabilities(): RunnerSessionCapabilities;
  createSession(options: {
    sessionKey: string;
    resumeState?: RunnerResumeState;
    onResumeStateChanged(state: RunnerResumeState): void;
  }): Promise<RunnerSession>;
}

interface RunnerSession {
  sendTurn(turnId: string, text: string, attachments: Attachment[]): SendTurnResult;
  cancel(): Promise<void>;
  reset(): Promise<void>;
  stop(graceMs?: number): Promise<void>;
  on(...): Unsubscribe;
}
```

Adapters for the old `AgentRunner` interface may exist during migration. Do not maintain two independent pool implementations after the cutover.

Provider requirements:

- Codex: persist one validated `thread_id` per conversation and use `codex exec resume` on later turns. Note the existing flag divergence — `exec resume` does not accept `--sandbox`; the runner already handles this and the session manager must not reintroduce it.
- Claude Code: persist one UUID per conversation. The UUID is minted by Torana, stored in `provider_state_json`, and passed via `--session-id` for the first turn; after eviction, a new process uses `--resume <persisted-uuid>`. It is distinct from the Torana session ID (§5.3), which is not a UUID. `pass_continue_flag`/`--continue` is superseded by this managed state under `sessions.scope: conversation` and honored only under `legacy_agent`. This sequence passed the authenticated Claude Code `2.1.220` cross-process E2E recorded in the Phase 0 findings.
- Command runner: side-session multiplexing (`runnerSupportsSideSessions()`) and durable restart continuity are separate capabilities. Validate explicit v2 durable scopes against `resume_model`; reject them when it is `none` and require `session_scope: ephemeral`. Never infer process or resume behavior from the parser protocol alone.

### 7.4 Session policies

Per-endpoint/channel overrides may select:

- `legacy_agent`: one shared session for all endpoint traffic; compatibility only, and the value the v1 loader assigns (§6 rule 6). This is the single spelling — earlier drafts also used `agent`; that name is retired.
- `conversation`: one session per chat/channel/DM; default. `channel` is an accepted Buzz-facing alias for this value and normalizes to `conversation` at load, because "channel" is the term the Buzz `channel_overrides` block reads naturally in.
- `thread`: one session per thread root; default for Buzz forums.
- `ephemeral`: fresh session per turn.
- `alias:<name>`: explicit cross-platform shared session, opt-in and same-agent only.

Aliases must be declared in `sessions.aliases[]` with an owning `agent_id`. Never infer that a Telegram chat and a Buzz DM belong to the same human, and never permit one alias to cross agent IDs.

### 7.5 Commands

Platform adapters normalize owner control commands. The action names are the three v1 `builtin:*` values plus one addition:

| Action                     | Telegram trigger | Buzz trigger | Behavior                                                                          |
| -------------------------- | ---------------- | ------------ | --------------------------------------------------------------------------------- |
| `builtin:reset`            | `/reset`, `/new` | `!rotate`    | discard provider context for the resolved session after canceling its active turn |
| `builtin:cancel` (**new**) | `/cancel`        | `!cancel`    | cancel only the active turn; preserve context                                     |
| `builtin:status`           | `/status`        | `!status`    | report current conversation session status, queue depth, age, and runner health   |
| `builtin:health`           | `/health`        | `!health`    | existing v1 builtin — gateway-level health; retained unchanged                    |

`/new` is a trigger alias for `builtin:reset`, not a separate action. A configuration loaded from v1 with its compatibility `legacy_agent` scope retains today's agent-wide remote reset behavior. In explicit v2 configuration, when the resolved session is shared by `legacy_agent` or an alias, remote reset refuses and reports every affected conversation; the operator must use `torana sessions reset <session-key> --confirm-shared` locally, or remove the binding first. A single-conversation reset is impossible while its session is shared. `builtin:cancel` is the only new action. Gateway shutdown remains a local process/CLI operation and is deliberately not representable as a remote message command.

### 7.6 Dispatcher and invocation path

The component that moves work is `conversation/scheduler.ts`. Nothing else may dispatch a turn.

- **Ownership.** One scheduler instance per gateway process, constructed at startup after the DB is migrated and before any adapter starts intake.
- **Wake conditions.** (a) an adapter commits an inbound enqueue transaction; (b) a turn reaches a terminal state, freeing a slot; (c) a session finishes rehydrating; (d) a 1 s safety tick that also covers rows committed by a crashed predecessor process.
- **Selection.** Fair round-robin across conversations with a pending head-of-queue turn, filtered by: no in-flight turn for that conversation's **resolved session key**, agent turn concurrency below `max_concurrent_turns_per_agent`, global below `max_concurrent_turns_global`, and per-token below the token cap when the turn came from the Agent API. Round-robin cursor is over `conversation_id`, so one hot channel cannot starve others; conversations deliberately sharing a legacy/alias session are serialized against one another.
- **Delivery contract.** Durable intake is at-least-once through creation of the turn row: `inbound_events.status` moves `received → enqueued → dispatched → processed|interrupted|rejected|dead`, and the turn row is created in the same transaction as the `enqueued` transition. Runner execution is **at-most-once after dispatch**. A crash with a turn in `running` and no live process atomically marks the turn and its source event `interrupted`; it is terminal and is never automatically re-dispatched because the runner may already have changed files, invoked tools, committed code, or published external actions. An operator may explicitly retry it, creating a new turn with `retry_of_turn_id` and a new execution identity while preserving the interrupted row for audit. The UI/CLI must warn that retry may repeat side effects.
- **Startup.** Sessions are _not_ eagerly rehydrated. The scheduler rehydrates on first dispatch to that conversation (§7.1 lazy restore).

### 7.7 Backpressure, breakers, and failure bounds

Neither the current code nor the first draft of this plan bounded the mailbox. These are the bounds:

- **Queue depth.** `limits.max_queue_depth_per_conversation` (default 50) and `limits.max_queue_depth_per_agent` (default 500) are hard bounds:
  - `queue` (default): enqueue while both depths are below their caps. At either cap, create a rejected audit row without a turn; Buzz stays silent and Telegram replies once with a rate-limit notice. No second unbounded spool exists.
  - `reject`: when a turn cannot dispatch immediately because its conversation or a concurrency slot is busy, reject it at gate 10 instead of queueing. The same platform response rules apply.
  - Received-reactions are emitted only after the durable enqueue transaction commits. A rejected event is never acknowledged as accepted.
- **Ingress/database bound.** `limits.inbound_event_rate_per_endpoint` is enforced before payload persistence. Excess irrelevant/rejected events are coalesced into bounded counters rather than one audit row per event. `retention.database_size_cap_bytes` applies to the aggregate SQLite main, WAL, and SHM files and is a gateway-wide hard high-water limit: at 90% Torana checkpoints the WAL, performs an urgent retention sweep, and suppresses optional rejected-event payloads; at 100% it stops intake/cursor advancement for every endpoint, returns Agent API storage backpressure, marks storage/gateway health unhealthy, and alerts through any channel that does not require another database write until space is reclaimed. It never claims acceptance for an event it could not persist.
- **Inbound dead-letter.** An accepted event whose turn cannot be dispatched within `context_retention_ms`, or whose conversation is deleted/archived/membership-revoked, transitions to `dead` with a reason. This is what makes the §12.5 invariant "no accepted inbound event lacks a terminal turn state" actually satisfiable — `dead` is a terminal state.
- **Undeliverable outbound.** An outbox row whose conversation is permanently no longer publishable (membership removed, channel archived/deleted, or identity authorization revoked) moves to `dead` immediately rather than exhausting `outbox.max_attempts`. A reversible endpoint/platform `disabled` state pauses delivery and preserves the row; `draining` continues delivery. Permanent vs. retriable vs. administratively paused is decided by the adapter and endpoint lifecycle manager, not the outbox processor.
- **Crash-loop breakers, two levels.** `worker_tuning.max_consecutive_failures` and `crash_loop_backoff_*` are per-bot today; under per-conversation sessions they split:
  - _Per-conversation:_ N consecutive failed spawns/turns quarantines that conversation, dead-letters its queue head, and alerts. One poisoned conversation must not trip the agent.
  - _Per-agent:_ the existing counters, now incremented only by failures that are not attributable to a single conversation (spawn-path, auth, CLI-missing). This preserves v1 behavior for `legacy_agent` scope.
- **Turn timeout.** `worker_tuning.turn_timeout_secs` applies per conversation turn, not per agent.

### 7.8 Agent API compatibility and normalized targets

- `ask` without `session_id` remains ephemeral. With `session_id`, its durable key is `agent-api:<agent_id>:session:<session_id>`; authorized token name is deliberately not part of the key, preserving current behavior. Per-token acquisition counters still use token name.
- Existing `send` requests using `user_id` and/or numeric `chat_id` remain Telegram-compatible and resolve through the dual-written `user_chats`/`user_conversations` mapping.
- V2 adds an optional normalized target object `{endpoint_id, external_conversation_id, thread_root_id?, workflow_run_id?}` for Telegram or Buzz. `workflow_run_id` is required only for workflow conversations and may not be combined with `thread_root_id`. The form is additive: providing both legacy and normalized target forms is a validation error, and v1 response/error shapes remain unchanged.
- Target resolution verifies that the API token authorizes the owning agent, the endpoint belongs to that agent, the conversation has previously been observed or explicitly provisioned, and the endpoint remains publishable. Caller-supplied platform or agent IDs never override the resolved rows.
- If the database hard cap or another persistence failure prevents durable acceptance, Agent API calls return `503 storage_unavailable` with `X-Torana-Retriable: true`; they never return a turn ID for work that was not committed.

---

## 8. Storage and migration design

Ship a new SQLite migration with a pre-migration snapshot and lock, following Torana's existing migration safety rules.

### 8.1 New/normalized tables

```sql
endpoints(
  endpoint_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_identity TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active', -- active|draining|disabled
  state_reason TEXT,
  cursor_json TEXT,
  next_received_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
)

conversations(
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  community_id TEXT,
  external_conversation_id TEXT NOT NULL,
  -- NOT NULL + '' sentinel, NOT nullable: SQLite treats NULLs as distinct in
  -- UNIQUE constraints, so a nullable thread_root_id would silently disable
  -- the constraint below for every non-threaded conversation — i.e. the
  -- common case. Adapters emit `threadRootId: string | null`; the DB layer is
  -- the single boundary that normalizes null -> '' (see note after §8.1.1).
  thread_root_id TEXT NOT NULL DEFAULT '',
  workflow_run_id TEXT NOT NULL DEFAULT '',
  conversation_type TEXT NOT NULL,
  conversation_key TEXT NOT NULL UNIQUE,
  session_policy TEXT NOT NULL,
  session_key TEXT REFERENCES conversation_sessions(session_key), -- NULL iff ephemeral
  archived INTEGER NOT NULL DEFAULT 0,
  last_sender_id TEXT,
  last_inbound_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((session_policy = 'ephemeral' AND session_key IS NULL) OR
         (session_policy <> 'ephemeral' AND session_key IS NOT NULL)),
  UNIQUE(endpoint_id, external_conversation_id, thread_root_id, workflow_run_id)
)

conversation_sessions(
  session_key TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  runner_session_id TEXT NOT NULL UNIQUE, -- digest of session_key (§5.3)
  runner_type TEXT NOT NULL,
  provider_state_json TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  started_at TEXT,
  last_used_at TEXT,
  hard_expires_at TEXT,
  context_expires_at TEXT,
  last_error TEXT
)

inbound_events(
  id INTEGER PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  external_message_id TEXT,
  target_external_event_id TEXT,
  workflow_run_id TEXT,
  conversation_id INTEGER REFERENCES conversations(id),
  sender_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  reply_to_external_id TEXT,
  payload_json TEXT,                 -- nulled by retention; hash/IDs remain
  payload_sha256 TEXT NOT NULL,
  received_seq INTEGER NOT NULL,    -- gateway receive order; the ordering authority (§9.4)
  status TEXT NOT NULL,             -- received|enqueued|dispatched|processed|interrupted|rejected|dead|control
  status_reason TEXT,
  received_at TEXT NOT NULL,
  UNIQUE(endpoint_id, external_event_id)
)

pending_event_mutations(
  id INTEGER PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  target_external_event_id TEXT NOT NULL,
  mutation_event_id INTEGER NOT NULL REFERENCES inbound_events(id),
  mutation_kind TEXT NOT NULL,       -- message_edit|message_delete
  received_seq INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(endpoint_id, mutation_event_id)
)

-- Existing table, columns ADDED (see §8.2 for the bot_id/agent_id rule).
turns(
  ...,                              -- v1 columns retained during bridge window
  -- Rebuilt for compatibility: chat_id and source_update_id become nullable.
  -- Bridge binaries process only Telegram/Agent-API rows; Buzz rows leave the
  -- legacy fields NULL and remain preserved while Buzz intake is disabled.
  agent_id TEXT NOT NULL,
  conversation_id INTEGER REFERENCES conversations(id),
  session_key TEXT,
  source_platform TEXT NOT NULL,
  source_event_id INTEGER REFERENCES inbound_events(id),
  retry_of_turn_id INTEGER REFERENCES turns(id),
  prompt_text TEXT,                   -- immutable enqueue snapshot except queued edit application
  prompt_markdown INTEGER NOT NULL DEFAULT 0,
  prompt_revision_seq INTEGER NOT NULL DEFAULT 0,
  final_text TEXT,                  -- already exists in v1
  usage_json TEXT                   -- already exists in v1
)

-- Existing table, columns ADDED + legacy turn_id/chat_id constraints RELAXED.
outbox(
  ...,                              -- v1 columns retained during bridge window
  -- turn_id becomes NULLABLE: reaction_add/remove, delete, and vote operations
  -- may have no owning turn. v1 declares
  -- `turn_id INTEGER NOT NULL REFERENCES turns(id)`; the migration must
  -- rebuild the table to drop NOT NULL (SQLite cannot ALTER it away).
  -- The legacy chat_id also becomes nullable for Buzz rows.
  turn_id INTEGER REFERENCES turns(id),
  endpoint_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  operation_kind TEXT NOT NULL,     -- one durable §5.4 operation; never typing/presence
  external_message_id TEXT,
  signed_payload_json TEXT,         -- Buzz: the exact signed bytes (§8.3)
  signed_event_id TEXT,             -- Buzz: the derived Nostr event id
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  next_attempt_at TEXT,
  last_error TEXT
)

-- Existing table, add alongside for the compatibility window.
stream_state(
  turn_id INTEGER PRIMARY KEY REFERENCES turns(id),
  active_telegram_message_id INTEGER, -- retained and dual-written for Telegram
  active_external_message_id TEXT,
  buffer_text TEXT NOT NULL DEFAULT '',
  last_flushed_at TEXT,
  segment_index INTEGER NOT NULL DEFAULT 0
)

-- New normalized replacement; legacy user_chats remains and is dual-written
-- for Telegram until the bridge rollback window closes.
user_conversations(
  agent_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'telegram',
  external_user_id TEXT NOT NULL,   -- was telegram_user_id
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  last_inbound_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, platform, external_user_id)
)
```

### 8.1.1 Required indexes

The current schema carries six indexes that the hot paths depend on. Dropping or failing to recreate them is a silent performance regression, so they are part of the migration contract:

```sql
CREATE INDEX idx_turns_agent_status      ON turns(agent_id, status);
CREATE INDEX idx_turns_conv_status       ON turns(conversation_id, status);
CREATE INDEX idx_outbox_status_next      ON outbox(status, next_attempt_at);
CREATE INDEX idx_outbox_conversation     ON outbox(conversation_id, status);
CREATE INDEX idx_inbound_endpoint_status ON inbound_events(endpoint_id, status);
CREATE INDEX idx_inbound_conv_seq        ON inbound_events(conversation_id, received_seq);
CREATE UNIQUE INDEX idx_inbound_endpoint_seq ON inbound_events(endpoint_id, received_seq);
CREATE INDEX idx_pending_mutation_target ON pending_event_mutations(endpoint_id, target_external_event_id, received_seq);
CREATE INDEX idx_conversations_agent     ON conversations(agent_id, last_inbound_at);
CREATE INDEX idx_sessions_state_used     ON conversation_sessions(state, last_used_at);
CREATE INDEX idx_sessions_context_exp    ON conversation_sessions(context_expires_at);
-- retained from v1
CREATE INDEX idx_idempotency_created     ON agent_api_idempotency(created_at);
CREATE INDEX idx_turns_idempotency       ON turns(agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
```

`idx_inbound_bot_negid` (the v1 partial index for synthesized negative Agent-API update IDs) is dropped — §8.2 replaces the negative-integer scheme with a prefixed string.

**Null-normalization boundary.** `ConversationRef.threadRootId`, `ConversationRef.workflowRunId`, and `InboundEvent.rootEventId` stay `string | null` in TypeScript. The conversion of the two conversation discriminator fields to the `''` sentinel happens in exactly one place — the DB helper that resolves or inserts a conversation row. Adapters must never write `''` and the DB layer must never surface it; otherwise the UNIQUE fix above degrades back into the bug it exists to prevent.

**Durable prompt boundary.** `inbound_events.payload_json` is the immutable raw event body and its `payload_sha256` always hashes that original body. The enqueue transaction writes the normalized text/markdown snapshot into `turns.prompt_text` and `prompt_markdown`; the scheduler dispatches only from the turn row, never by reparsing `raw`. A later edit with a greater `received_seq` may atomically replace `prompt_text` and advance `prompt_revision_seq` only while the turn is still queued. Once dispatch claims the turn, edits are recorded as separate immutable events and surfaced as notices under Phase 6; they never rewrite the executed prompt. Attachment references follow the same queued-only revision rule through the turn attachment manifest.

### 8.2 Migration behavior

1. Copy positive-ID Telegram rows into normalized tables with `platform='telegram'` and decimal-string external IDs. Copy synthesized negative-ID Agent API rows under the owning agent's virtual `agent_api` endpoint with the prefixed ID rule below.
2. Preserve old numeric primary keys and turn relationships where practical.
3. Create one endpoint per v1 bot, with `endpoint_id = '<bot_id>-telegram'` to match the §6.3 config upgrade.
4. Create the reserved `<bot_id>-agent-api` virtual endpoint for each agent before backfilling negative-ID Agent API events.
5. Keep the existing `worker_state.codex_thread_id` available for legacy-agent session mode.
6. Do not guess which historical Telegram chat owns the primary thread. The v2 upgrade tool must offer:
   - keep it under the legacy agent-wide session;
   - bind it to an explicitly selected conversation;
   - start fresh per conversation.
7. Store a schema-versioned `provider_state_json`; reject unknown future versions without deleting them.
8. Migration dry-run prints row counts and planned backfills without secret values.
9. Rollback targets the tested compatibility bridge binary described below. The pre-migration snapshot remains an emergency fallback, not the normal rollback path (§14.3).

**`bot_id` → `agent_id`.** Do not rename in place. Every table that carries `bot_id` today (`turns`, `outbox`, `worker_state`, `bot_state`, `user_chats`, `agent_api_idempotency`, `side_sessions`, `inbound_updates`) gets `agent_id` **added and backfilled** with the identical value; `bot_id` is retained and dual-written through the bridge rollback window, then dropped in a later migration. New tables use `agent_id` only. v1 APIs, metrics series, and `agent_api.tokens[].bot_ids` keep the `bot_id` name per §5.1.

**Compatibility bridge release.** The immediate pre-2.0 release is a deliberately narrow bridge, planned as `1.0.0-rc.10` from the current `1.0.0-rc.9` baseline (re-number only if that version is occupied before implementation). It:

1. understands both schema v3 and v5 and ships the expand-only 0004/0005 migration, but does not apply it merely because the bridge binary starts;
2. continues to accept v1 configuration and run Telegram/Agent API behavior only;
3. dual-writes every Telegram/Agent-API mutation required by both the legacy and normalized schemas;
4. reads only legacy-compatible Telegram/Agent-API work and ignores preserved Buzz rows when used as a rollback target;
5. is deployed and soaked before 2.0, then retained as the only supported binary-only rollback target.

Bridge activation is two-stage to avoid making unsoaked code and an irreversible schema-version jump one event:

1. Deploy `1.0.0-rc.10` on schema v3 with normal v1 behavior and soak it.
2. Enter the maintenance window, stop intake, take the snapshot, and run the explicit bridge-owned `torana migrate --to 5` command.
3. The command applies 0004/0005 transactionally, then completes the separately locked incremental-auto-vacuum step (§8.4), verifies all dual-write parity checks, and only then permits intake.
4. Continue running the same already-soaked bridge binary on schema v5 before introducing 2.0. From this point the bridge itself is the lossless rollback target; rc.9 is snapshot-only.

The current `1.0.0-rc.9` binary is **not** a valid rollback target: its migration dispatcher rejects schema versions above 3. The bridge release, not arbitrary older binaries, is what makes lossless rollback possible. Schema contraction and removal of legacy columns/tables occur only in a later major release after the rollback window is explicitly closed.

**Explicit table-by-table backfill list.** The first draft covered only the new tables; the following existing Telegram-shaped state is equally load-bearing:

| v1 table/column                                                                  | v2 destination                                            | Rule                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bot_state.last_update_id`                                                       | `endpoints.cursor_json`                                   | `{"kind":"telegram_offset","last_update_id":N}`                                                                                                                                                                    |
| `bot_state.disabled` / `disabled_reason`                                         | `endpoints.lifecycle_state` / `state_reason`              | map `0 → active`, `1 → disabled`; copy reason                                                                                                                                                                      |
| `inbound_updates.*`                                                              | `inbound_events.*`                                        | `external_event_id = String(telegram_update_id)`, `external_message_id = String(message_id)`, `received_seq` assigned per endpoint by ascending `id`; set `endpoints.next_received_seq` to that endpoint's maximum |
| `inbound_updates` rows with **negative** `telegram_update_id` (Agent API origin) | `inbound_events`                                          | `external_event_id = printf('agentapi:%d', abs(telegram_update_id))`. Going forward Agent API origin uses `agentapi:<uuid>`; the legacy negative-integer row remains dual-written during the bridge window         |
| `stream_state.active_telegram_message_id`                                        | `stream_state.active_external_message_id`                 | add alongside and dual-write; integer → decimal string                                                                                                                                                             |
| `user_chats.telegram_user_id` / `chat_id`                                        | `user_conversations.external_user_id` / `conversation_id` | resolve or create the matching `conversations` row; retain and dual-write legacy `user_chats` for Telegram during the bridge window                                                                                |
| `agent_api_idempotency.bot_id`                                                   | `+ agent_id`                                              | add-alongside per the rule above; retention still governed by `agent_api.send.idempotency_retention_ms`                                                                                                            |
| `side_sessions`                                                                  | `conversation_sessions`                                   | live rows are transient; the migration truncates rather than converts (the pool already clears stale rows at startup via `markAllSideSessionsStopped`)                                                             |

### 8.3 Buzz outbox idempotency

A Nostr event ID depends on its complete signed body. For crash-safe retries:

1. Build and sign the event exactly once.
2. Persist the signed event JSON and its event ID (`signed_payload_json`, `signed_event_id`) before network publication.
3. Retry the same signed event bytes after timeouts or reconnects.
4. Treat relay `OK accepted`, `OK duplicate`, or a query showing the exact event ID as success.
5. Never rebuild a retry with a new timestamp, which would create a duplicate visible message.
6. If publication is still unresolved after `outbox.max_attempts` and `limits.relay_publish_timeout_ms`, dead-letter the row **without** re-signing. Operator replay (§11 Phase 10) republishes the stored bytes, never a fresh event.

### 8.4 Retention and redaction

Without this, the normalized tables grow without bound — `inbound_events.payload_json` in particular stores every raw event body. `context_retention_ms` covers only provider context, so these are separate knobs under `retention:`:

| Data                              | Default                                     | Rule                                                                                                                                      |
| --------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite file                       | `retention.database_size_cap_bytes` (4 GiB) | urgent sweep at 90%; stop intake/cursor advancement at the hard cap until space is reclaimed                                              |
| `inbound_events.payload_json`     | `retention.inbound_payload_days` (30)       | nullable body is cleared; hash, IDs, status and audit metadata remain                                                                     |
| `inbound_events` rows             | `retention.inbound_event_days` (90)         | deleted once no turn references them                                                                                                      |
| `turns` (terminal)                | `retention.terminal_turn_days` (90)         | independent from provider-context retention                                                                                               |
| `outbox` (`sent`)                 | `retention.sent_outbox_days` (14)           | `dead` rows use `retention.dead_outbox_days` (90)                                                                                         |
| sent `outbox.signed_payload_json` | `signed_sent_payload_hours` (24)            | clear only after confirmed delivery and the replay window                                                                                 |
| dead `outbox.signed_payload_json` | lifetime of the dead row                    | retained so explicit operator replay can publish identical bytes                                                                          |
| `pending_event_mutations`         | `retention.pending_mutation_days` (30)      | expire unresolved edit/tombstone buffers with a metric                                                                                    |
| `conversations`                   | never auto-deleted                          | archived, not deleted; explicit deletion removes its binding and deletes an unreferenced session row only after dependent data is handled |
| attachments                       | existing `attachments.retention_secs`       | unchanged                                                                                                                                 |

Redaction rules: private keys and auth tags never enter any column (§13.2). `payload_json` stores the event as received — it is untrusted user content, not secret material, but it may contain personal data, so the purge job and an operator-invocable `torana conversations purge <id>` are both required. Clearing it writes NULL while retaining `payload_sha256` for audit integrity. Sweeps run on the same 60 s timer as the session TTL sweep. Fresh databases enable SQLite incremental auto-vacuum before creating tables. Existing databases require a one-time `VACUUM` after setting `auto_vacuum=INCREMENTAL`; because SQLite forbids `VACUUM` inside the migration transaction, the bridge performs it as a separate locked, disk-space-preflighted maintenance step after 0005 and verifies durable completion by querying `PRAGMA auto_vacuum` and requiring result `2` before starting intake. Later sweeps call incremental vacuum so logical deletion returns pages and the file-size cap remains meaningful.

---

## 9. Buzz endpoint architecture

### 9.1 Connectivity

Implement `BuzzEndpoint` as a platform adapter with:

- one authenticated WebSocket connection per `(relay/community, pubkey)` endpoint;
- NIP-42 challenge authentication;
- owner-attestation/NIP-OA tag injection when configured;
- signed Nostr event verification on inbound data;
- channel discovery for the authenticated member;
- channel-scoped subscriptions using `h` tags;
- membership-notification handling and dynamic subscribe/unsubscribe;
- reconnect with bounded exponential backoff and jitter;
- a persisted replay cursor that overlaps slightly on reconnect, relying on event-ID dedup;
- heartbeat and connection-health state;
- clean subscription closure and process shutdown.

Do not use a global subscription for private channel data. Buzz deliberately requires channel-scoped subscriptions for access control and fan-out.

**Cursor contract.** `endpoints.cursor_json` is versioned and stores one composite cursor per subscription scope, not one scalar timestamp for the whole endpoint:

```json
{
  "version": 1,
  "subscriptions": {
    "channel:<uuid>:messages": {
      "created_at": 1730000000,
      "event_id": "<64-hex>"
    }
  }
}
```

Advance a durable scope cursor only in the same transaction that commits the accepted/control/rejected event row or, for audit-suppressed irrelevant events, a cursor-only discard checkpoint. A crash may therefore re-evaluate an irrelevant event but can never skip an accepted one. Ephemeral presence/typing subscriptions have no replay cursor and can never advance a message or membership cursor. Reconnect starts from a configurable overlap before `created_at`; event-ID dedup removes the overlap, including events sharing the same second. `historical_limit` is a page size, never a statement that only that many missed events matter. Phase 0 must verify the hosted relay's pagination/EOSE contract. If a durable scope cannot be drained without a gap, Torana leaves its cursor unchanged, marks the endpoint unhealthy with `replay_gap`, and alerts rather than silently skipping history.

### 9.2 Cryptography/library spike

Phase 0 selected a narrow wrapper around exactly pinned `nostr-tools@2.24.1`, with its Noble curve/hash dependencies pinned in the spike lockfile. It supports:

- event canonicalization and IDs;
- Schnorr sign/verify;
- NIP-42 auth events;
- NIP-19 key parsing if operator input permits `nsec`;
- WebSocket filters and reconnection hooks.

The tracked spike verifies signed events from the installed Rust `buzz` CLI, independently reproduces their event IDs, and verifies the pinned `buzz-sdk` NIP-OA vector. Buzz-specific code constructs and validates the NIP-OA preimage/tag grammar but delegates SHA-256 and BIP-340 to Noble; it does not implement cryptographic primitives. See `docs/buzz-phase0-findings.md`.

### 9.3 Inbound gates

Apply gates in this order:

1. frame and JSON size limits;
2. valid Nostr shape, event ID, and signature;
3. endpoint/community match;
4. channel membership/access confirmation;
5. self-event rejection;
6. event-ID dedup;
7. supported/allowed event kind;
8. author gate (`owner_only`, `allowlist`, `anyone`, `nobody`);
9. mention/thread trigger rule;
10. budget check — loop/hop budget, the §9.5 reply rate backstop, and the §7.7 queue-depth caps;
11. attachment metadata validation;
12. durable enqueue transaction;

Unauthorized or irrelevant events are silently ignored or recorded as rejected according to configured audit verbosity. They must not reveal agent existence through a response.

### 9.4 Ordering authority

A Nostr event's `created_at` is chosen by its author and has second granularity. It is therefore **not** an ordering source: a peer can backdate, two events can share a timestamp, and relay replay delivers old events after new ones.

Rules:

1. `inbound_events.received_seq` — a per-endpoint monotonic counter assigned inside the enqueue transaction — is the only ordering authority for turn dispatch, edit application, and delete application. Allocation atomically increments `endpoints.next_received_seq` and inserts the event under the unique `(endpoint_id, received_seq)` index in that same transaction.
2. An edit or tombstone is applied only if its `received_seq` is greater than that of the event it targets. An out-of-order arrival (tombstone before the message it deletes) is stored in `pending_event_mutations` against the target's `external_event_id`, applied in `received_seq` order when the target arrives, or expired by `retention.pending_mutation_days` with an observable metric.
   The target comes from normalized `targetExternalEventId`, never from `replyTo` or platform-specific `raw`. Applying an edit to queued work uses the durable-prompt transaction in §8.1.1; applying a delete gives the queued turn an explicit terminal `dead` status and matching source-event reason.
3. `occurredAt` is carried through to prompts as display metadata only, explicitly labeled as author-supplied.
4. During cursor replay (§9.1) the overlap window can redeliver already-processed events; dedup on `external_event_id` runs before sequence assignment, so replay never advances `received_seq` for a known event.

This is what makes the Phase 6 gate "deletion and edit races are deterministic" a testable claim rather than an aspiration.

### 9.5 Agent-to-agent loop protection

Default rules:

- never process an event signed by the endpoint itself;
- owner-authored DMs are eligible without a mention;
- stream messages require an explicit `p`-tag mention by default;
- agent-authored messages require an explicit pubkey mention even in mention-optional channels;
- attach Torana trace and hop tags to agent-generated messages;
- default maximum hop depth: 4;
- default maximum generated events per trace: 16;
- deduplicate trace/event combinations;
- workflows and relay-signed automation events do not recursively trigger unless explicitly enabled.

**Trace tags are not a security control.** Hop depth and trace budgets depend on tags that peer agents attach to their own events. A peer that omits, resets, or forges the tag — whether hostile, buggy, or simply running an older build — defeats the budget entirely. Torana controls tags only on events it signs itself.

The backstop must therefore be tag-independent and enforced locally:

- `limits.agent_reply_rate_per_conversation` (default `6/60s`): a hard cap on outbound conversational messages Torana will publish into one conversation, counted from its own outbox regardless of what any inbound event claims. Breaching it suppresses further replies in that conversation, emits a `loop_budget_rejected` metric, and alerts.
- `limits.agent_reply_rate_per_endpoint` (default `60/60s`) applies the same way, so a fan-out across many conversations cannot bypass the per-conversation limit.
- Trace/hop tags remain valuable for _diagnosis_ and for cooperating peers, and stay in place — but no gate may depend on them alone.

### 9.6 Context framing

Runner prompts receive a platform-neutral header with:

- platform and community;
- channel/DM name and UUID;
- thread root and reply event IDs;
- author display name and pubkey;
- mention targets;
- attachment paths and metadata;
- deep link when available;
- a clear instruction that Torana, not the model, owns delivery.

Unlike `buzz-acp`, the model's final response is always captured from runner output and placed into Torana's outbox. The model must not need to call `buzz messages send` merely to deliver its answer. Buzz CLI remains available for additional workspace actions.

---

## 10. Buzz capability coverage

“Support all Buzz capabilities” is split into two ownership levels.

### 10.1 Gateway-native capabilities

These affect reliable conversation delivery and must be first-class Torana adapter features:

| Capability                                         | Inbound          | Outbound       | Session/routing rule                                   |
| -------------------------------------------------- | ---------------- | -------------- | ------------------------------------------------------ |
| Stream channel messages                            | yes              | yes            | channel session by default                             |
| Direct messages, including group DMs               | yes              | yes            | DM UUID session                                        |
| Pubkey mentions and readable `@Name` text          | yes              | yes            | trigger/filter + `p` tags                              |
| Thread replies                                     | yes              | yes            | channel or thread policy                               |
| Message edits                                      | yes              | yes            | update queued input; edit delivered output             |
| Message deletion/tombstones                        | yes              | yes            | cancel queued input when safe; preserve audit metadata |
| Markdown                                           | yes              | yes            | native GFM renderer; no Telegram HTML conversion       |
| Reactions                                          | optional trigger | yes            | same conversation; configurable prompt behavior        |
| Custom emoji references                            | preserve         | yes            | validate name against palette when available           |
| Forum posts                                        | yes              | yes            | root event creates session                             |
| Forum comments                                     | yes              | yes            | forum-root session                                     |
| Forum votes                                        | optional trigger | yes            | forum-root session                                     |
| File attachments                                   | yes              | yes            | Blossom download/upload + `imeta`                      |
| Image/media comments represented as message events | yes              | yes            | thread/root mapping                                    |
| Presence/away/offline                              | observe          | publish        | endpoint lifecycle, never durable prompt by default    |
| Typing/activity                                    | observe          | publish        | ephemeral, best effort                                 |
| Channel membership discovery                       | yes              | n/a            | dynamic subscriptions                                  |
| Channel archive/leave/remove notifications         | yes              | n/a            | stop intake and idle/close sessions                    |
| Search/deep-link context lookup                    | on demand        | n/a            | adapter helper/tool, not automatic global ingestion    |
| Feed mentions/needs-action                         | configurable     | n/a            | optional scheduled trigger source                      |
| Owner control commands                             | yes              | status replies | current-conversation control                           |
| Heartbeat prompts                                  | scheduled        | optional posts | lower priority than user turns                         |

Stable stream/forum event kinds and tags are centralized in a Buzz protocol module. Unknown kinds are logged at debug, counted, and ignored unless enabled through a documented extension mapping.

### 10.2 Agent-tool capabilities

These should be available to runners through the pinned `buzz` binary and a bundled Torana Buzz skill. Torana should provision credentials and policy, but should not duplicate the feature implementation:

| Buzz CLI group       | Required Torana integration                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `messages`           | `send`, `send-diff`, `edit`, `delete`, `get`, `thread`, `search`, `vote`; transport-owned final reply rule documented                                                          |
| `channels`           | `list`, `get`, `search`, `create`, `update`, `topic`, `purpose`, `join`, `leave`, `archive`, `unarchive`, `delete`, `members`, `add-member`, `remove-member`, `set-add-policy` |
| `dms`                | `list`, `open`, `add-member`, `hide`                                                                                                                                           |
| `reactions`          | `add`, `remove`, `get`                                                                                                                                                         |
| `emoji`              | `list`, `set`, `rm`, `export`, `import`                                                                                                                                        |
| `canvas`             | `get`, `set` with conflict-aware operator guidance                                                                                                                             |
| `users`              | `get`, `set-profile`, `presence`, `set-presence`, `set-status`                                                                                                                 |
| `workflows`          | `list`, `get`, `create`, `update`, `delete`, `trigger`, `runs`, `approve`; approvals remain explicit high-risk actions                                                         |
| `feed`               | `get`                                                                                                                                                                          |
| `social`             | `publish`, `set-contacts`, `event`, `notes`, `contacts`, `set-list`, `list`                                                                                                    |
| `notes`              | `set`, `get`, `ls`, `rm`                                                                                                                                                       |
| `repos`              | `create`, `get`, `list`, `bind`, plus `protect list`, `protect set`, and `protect remove`                                                                                      |
| `patches`            | `send`, `get`, `list`, `status`                                                                                                                                                |
| `issues`             | `create`, `get`, `list`, `status`                                                                                                                                              |
| `pr`                 | `open`, `update`, `get`, `list`, `status`                                                                                                                                      |
| `media` and `upload` | `media get`, `upload file`                                                                                                                                                     |
| `mem`                | `ls`, `get`, `hash`, `set`, `patch`, `rm` with hash-based conflict safety                                                                                                      |
| `agents`             | `draft-create`, `draft-update`, `archive`, `unarchive`, `archived`; drafts remain owner-reviewed                                                                               |
| `moderation`         | `reports`, `resolve`, `ban`, `unban`, `timeout`, `untimeout`, `restricted`, `audit`                                                                                            |
| `pack`               | `validate`, `inspect`; local, with no relay credentials required                                                                                                               |

Implementation requirements:

1. Pin and verify a compatible `buzz` CLI version in the Torana deployment docs/example image.
2. Keep `BUZZ_PRIVATE_KEY` and `BUZZ_AUTH_TAG` out of runner environments by default. A local credential broker/wrapper executes allowed Buzz CLI operations on the runner's behalf and owns the endpoint credentials.
3. Give each runner only a short-lived, endpoint-scoped broker credential resolved by §6 rule 17. The runner calls a typed RPC operation; the credential already fixes the endpoint identity, the broker validates the operation/resource policy, constructs the complete `buzz-cli` argument vector itself, and rejects all caller-supplied endpoint, relay, private-key, auth-tag, executable, environment, and unrestricted path overrides.
4. Permit raw key injection only with `expose_private_key_to_runner: true` plus an explicit dangerous-operation acknowledgement. Document that this bypasses Torana's command policy because an unrestricted shell can invoke `buzz-cli` directly.
5. Never echo or place private keys in prompts, config validation output, logs, database payloads, or broker responses.
6. Install a shared `buzz` skill for Claude/Codex with the output contracts, broker invocation, and safety rules.
7. Generate a versioned exact-command manifest from the pinned CLI release and add enforceable broker policies for high-impact commands: channel deletion, membership changes, repo protection, workflow approval, agent archive, and moderation. Unknown groups/subcommands fail closed.
8. Record tool-originated mutations in runner logs without secret values; the Buzz event log remains the authoritative audit trail.

### 10.3 What the broker actually protects

Be precise about this, because the plan's own configuration requires the claude-code runner to acknowledge that it runs with `--dangerously-skip-permissions` — full, unsandboxed host access in its `cwd`.

The broker **does** provide:

- a policy chokepoint: which Buzz command groups, subcommands, and target resources an agent may invoke, enforced in one auditable place;
- correct endpoint selection on the normal, non-compromised path: runners receive no raw key and typed calls are scoped to the configured endpoint;
- an audit trail of tool-originated mutations;
- defense against the _ordinary_ failure mode — a model that hallucinates a destructive command, or is talked into one by a prompt-injected message.

The broker **does not** provide containment of a compromised runner or a hard identity boundary between sibling agents in the same Torana installation. All agents in one installation are one trust domain. A runner with host access in the shared container may discover or attack sibling capabilities, the broker, or Torana itself. Short-lived endpoint credentials, typed operations, exact allowlists, and audit logs reduce accidental misuse and raise the cost of an attack; they do not support the claim that a fully compromised runner can never act as another endpoint.

The real containment boundary is the Torana installation's container/VM, exactly as `docs/runners.md#concrete-isolation-patterns` already states for the existing `acknowledge_dangerous` requirement. Operators who require hard persona-to-persona identity isolation must run separate Torana installations/containers (or a future per-runner OS isolation mode); same-container socket names or bearer tokens are not sufficient. The broker narrows blast radius within one trust domain; it does not replace isolation. §13.11 states the same thing normatively.

### 10.4 Command policy profiles

Phase 9 names four profiles and the §6 example uses `collaborate` before it is defined. The generated manifest from the pinned CLI is the machine-readable authority; these lists define the intended policy inputs without Markdown separator ambiguity.

- **`read_only`:** allows exact manifest entries for non-mutating operations, including applicable `get`, `list`, `ls`, `search`, `thread`, `event`, `contacts`, `presence`, `reports`, `restricted`, `audit`, `archived`, `export`, and `repos.protect.list` commands. Denies every mutation.
- **`collaborate` (default):** adds `messages.send`, `messages.send-diff`, `messages.edit`, `messages.delete` for events owned by the selected endpoint, `reactions.add`, `reactions.remove`, `dms.open`, `channels.join`, `channels.leave`, `notes.set`, `mem.set`, `mem.patch`, `upload.file`, `issues.create`, `issues.status`, `patches.send`, `pr.open`, `pr.update`, `social.publish`, `social.set-contacts`, `social.set-list`, and `emoji.list`. It denies channel creation/deletion/archive, member administration, workflow mutations/approval, repo protection, moderation mutations, agent draft/archive requests, `canvas.set`, `emoji.set`, `emoji.rm`, and `mem.rm`.
- **`maintainer`:** adds `channels.create`, `channels.update`, `channels.topic`, `channels.purpose`, `channels.archive`, `channels.unarchive`, `channels.add-member`, `channels.remove-member`, `channels.set-add-policy`, `canvas.set`, `emoji.set`, `emoji.rm`, `emoji.import`, `repos.create`, `repos.bind`, `mem.rm`, `workflows.create`, `workflows.update`, `workflows.delete`, and `workflows.trigger`. It still denies `channels.delete`, `workflows.approve`, moderation mutations, `agents.draft-create`, `agents.draft-update`, `agents.archive`, `agents.unarchive`, `repos.protect.set`, and `repos.protect.remove`.
- **Custom allowlist:** allows exactly the generated `group.subcommand` entries listed by the operator and denies everything else.

Rules:

1. The high-risk command families never granted by a named profile — `channels delete`, `workflows approve`, moderation mutations, `agents draft-create|draft-update|archive|unarchive`, and `repos protect set|remove` — require an explicit custom allowlist entry plus `acknowledge_dangerous: true` on the tools block. This matches how `codex.approval_mode: yolo` and the claude-code runner already gate irreversible capability.
2. Deny wins. A subcommand absent from the resolved allowlist is denied, including subcommands added by a future `buzz` CLI version — this is why the broker validates against an explicit list rather than a denylist.
3. Resource scoping is evaluated after command scoping: a permitted command against a channel the endpoint is not a member of is still denied.
4. Profiles are versioned with the plan. Adding a subcommand to a named profile is a documented, changelog-visible change, not a silent broadening.
5. “Own events only” is enforced by resolving the target event through the authenticated relay, verifying that its author equals the selected endpoint pubkey, and failing closed when ownership cannot be established. Caller-supplied author metadata is never trusted.
6. File-taking operations receive broker-opened descriptors or broker-copied bounded temporary files; the CLI never receives a runner-chosen unrestricted host path.

### 10.5 Experimental/future Buzz surfaces

Huddles and any feature without a stable CLI/event contract are not release blockers. Reserve adapter extension points for ephemeral audio/video/huddle lifecycle events. Add support only after the upstream event kinds, auth rules, and CLI/API behavior are stable and covered by upstream tests.

---

## 11. Phased implementation

Every phase must be independently reviewable. Do not mix the database migration, platform abstraction, and Buzz protocol implementation into one commit.

**Progress-accounting rule:** immediately after each phase passes its gate, update the document status, add dated completion evidence beneath that phase, and append a concise refinement-log entry. Commit that plan update with the phase (or as the immediately following documentation commit) before implementation of the next phase begins.

### Phase 0 — protocol spike and locked decisions

**Purpose:** eliminate unknowns before touching the production path.

**Evidence record:** `docs/buzz-phase0-findings.md`. The local fake-relay, hosted closed-relay, cryptographic, CLI-golden, command-manifest, exact release-artifact provenance, idle and authenticated capacity, authenticated Codex continuity, and authenticated Claude cross-process resume work is complete. All Phase 0 gates are closed.

Work:

1. Build a throwaway `spike/buzz-transport` client that authenticates to a test relay, discovers one channel, subscribes by `h` tag, receives one mention, signs one threaded reply, reconnects, and proves duplicate-event handling.
2. Pin the exact upstream Buzz commit/tag used for all Phase 0 evidence, capture the generated CLI group/subcommand manifest, and record a release artifact checksum/version probe. If that CLI build exposes no version command, the checksum plus generated manifest is authoritative. Mutable `main` links remain explanatory references, not compatibility identifiers.
3. Produce/consume golden events with the pinned `buzz` CLI.
4. Verify NIP-42 and owner-auth-tag behavior against an open and closed relay.
5. Verify message kinds for stream v1/v2, edits, tombstones, reactions, forums, presence, typing, membership notifications, workflow events, and attachments.
6. Verify relay `OK` behavior for replaying an already accepted signed event.
7. Confirm the correct Claude CLI resume sequence for a persisted per-conversation UUID.
8. Measure one, two, eight, and 32 live Codex/Claude conversation sessions for memory/FD/process impact, against the actual deployment ceiling (Railway container memory limit for the `agent-team` service).
9. Lock whether the initial implementation uses a direct TypeScript Nostr client or a narrow maintained library wrapper.

Gate:

- written spike findings with captured sanitized frames and a capability/kind table;
- no unresolved cryptographic or session-resume behavior;
- chosen library licenses are compatible with MIT Torana;
- the pinned Buzz identity, checksum/version probe, and exact command manifest are reproducible in CI;
- **quantified capacity result, with a go/no-go number.** Record steady-state RSS and FD count per resident session and per concurrent per-turn invocation. Local evidence has already rejected the provisional `sessions.max_global: 64` for resident Claude sessions. Phase 0 must replace the placeholder with shipped `max_per_agent`/`max_global` defaults calculated so `max_global × per-session RSS + gateway baseline` fits inside the deployment memory ceiling with ≥30% headroom. Note that the measurement differs by runner model (§7.2): Codex holds no process between turns, so its ceiling is driven by `max_concurrent_turns_global`, not `max_global`.

### Phase 1 — platform-neutral core types with Telegram parity

**Purpose:** create real boundaries without changing observable behavior.

Work:

1. Introduce `PlatformAdapter`, `MessagingEndpoint`, `InboundEvent`, `ConversationRef`, durable `OutboundOperation`, `EphemeralSignal`, `ExternalPrincipal`, and generic attachment types.
2. Move Telegram parsing into `TelegramAdapter.normalizeInbound`.
3. Move Telegram send/edit/reaction/typing/download methods behind endpoint capabilities.
4. Split `processUpdate` into platform-neutral ingest plus Telegram normalization.
5. Replace direct `TelegramClient` dependencies in registry, bot runtime, streaming, outbox, alerts, and commands with interfaces.
6. Keep legacy class/config names externally; internal `AgentRuntime` may replace `Bot` behind an alias.
7. Rename metrics generically while continuing to emit deprecated Telegram-specific series for one release.

Gate:

- all existing tests pass unchanged or with mechanical fixture adapters;
- a contract test runs the complete Telegram flow through the new interfaces;
- no Buzz code exists in the production path yet;
- snapshot comparison shows identical Telegram requests for representative turns.

**Completion evidence (2026-08-01):** the production gateway now normalizes Telegram updates through `TelegramAdapter` and processes them through the platform-neutral inbound path. Registry, bot runtime, streaming, outbox, alerts, and commands depend on `PlatformAdapter`; Telegram send/edit/reaction/typing/download calls remain inside the adapter. The existing full round-trip integration contract passes through these interfaces, and the adapter contract asserts the exact Telegram request bodies for send, edit, reaction, typing, and HTML fallback. The complete repository suite passes with 1,282 tests passed, 13 intentionally skipped, and zero failures; typecheck, lint, format verification, and the production build also pass. Production contains no Buzz integration code yet.

### Phase 2 — configuration v2 and normalized persistence

**Purpose:** make multiple platforms and string external IDs representable.

Work:

1. Add v2 schema and v1-to-internal normalization.
2. Add endpoint and session policy validation.
3. Implement the new SQLite migration and dry-run reporting.
4. Refactor DB helpers to normalized tables/types.
5. Generalize outbox rows and persist prebuilt platform payloads.
6. Add `torana config upgrade` and documentation.
7. Update backup, restore, doctor, and migration tests.
8. Cut and deploy the 1.x compatibility bridge: it applies/understands schema v5, remains v1-config/Telegram compatible, dual-writes legacy and normalized state, and is retained as the supported 2.0 rollback binary (§8.2).
9. Add the normalized `alerts.target` contract and deterministic legacy resolution from §6 rule 18; alert delivery remains Telegram-backed until platform-neutral delivery lands.

Gate:

- v1 fixtures validate and behave identically;
- v2 Telegram-only fixture passes the full integration suite;
- migration preserves all fixture histories and relationships;
- bridge → 2.0 → bridge binary rollback is rehearsed without restoring a snapshot and without losing post-migration Telegram/Agent-API activity;
- snapshot restoration remains documented and rehearsed as the emergency fallback;
- no numeric-only assumption remains in core conversation/outbox code.

**Implementation evidence (2026-08-01):** config v1 and v2 now normalize into one internal agent/endpoint/session model, including deterministic legacy alert-target resolution, while enabled Buzz endpoints remain fail-closed until Phase 4. `torana config upgrade --from v1 --to v2` emits validated v2 YAML without modifying its input. Schema v5 adds normalized endpoints, conversations, sessions, inbound events, turns, and platform-neutral outbox data; migration dry-runs report sanitized backfill counts, pre-v5 snapshots are automatic, incremental auto-vacuum is verified, and v1 Telegram/Agent-API mutations dual-write legacy and normalized state. The bridge runs v1 on schema v3 or v5, ignores preserved Buzz work, and the bridge → v2 → bridge rehearsal preserves post-migration Telegram and Agent-API activity without snapshot restoration; emergency snapshot restoration is separately rehearsed. Core conversation and outbox delivery use string external IDs, including a regression delivery to the disposable Buzz channel UUID. A v2 Telegram-only config passes the full webhook integration flow. The complete repository suite passes with 1,305 tests passed, 13 intentionally skipped, and zero failures; typecheck, lint, format verification, and the production build pass.

**Rollout evidence (2026-08-01 MDT / 2026-08-02 UTC):** `v1.0.0-rc.10` was published from release workflow `30728671948`, and the registry tarball was verified to contain both schema-v5 migrations. Railway deployment `cdb79df8-0171-41ed-b1f8-3e694970f460` ran the bridge with the existing v1 config on schema v3; automatic migration was removed from the service command, Torana emitted the expected compatibility-bridge notice, and a five-minute soak held all five runners ready with zero mailbox backlog, zero 5xx responses, and no runtime failure signals. During the maintenance window, intake was stopped and the explicit `--to 5 --dry-run` reported 4,147 inbound updates, 4,074 turns, 6,900 outbox rows, five worker-state rows, five bot-state rows, five user-chat rows, and no side-session or idempotency rows. The migration wrote the 13,467,648-byte `gateway.db.pre-v5` snapshot, applied migrations 0004 and 0005, and reached `user_version=5`. Post-migration checks found `auto_vacuum=2`, zero foreign-key violations, 10 endpoints, eight conversations, 4,147 inbound events, 4,074 turns, and 6,900 outbox rows. The production config permission gate was corrected to `0600` and baked into `agent-team` commit `1efc44f`; final deployment `c5c51ab4-eed9-4de0-877a-26b9ab679e2e` passed doctor, reopened the existing schema-v5 database without another migration, recovered zero orphaned turns and zero pending outbox rows, and completed a five-minute soak with every runner ready, zero mailbox backlog, zero 5xx responses, stable resources, and no runtime failure signals. Phase 2 is complete; Phase 3 is authorized to begin.

### Phase 3 — general conversation-session manager

**Purpose:** deliver independent sessions per conversation before adding Buzz.

Work:

1. Extract runner construction into `AgentRunnerFactory` and `RunnerSession`.
2. Promote `SideSessionPool` into `ConversationSessionManager`.
3. Persist provider-native resume state per conversation.
4. Add durable per-conversation mailboxes and fair dispatch.
5. Evict idle live processes while retaining resume state.
6. Restore sessions lazily after restart.
7. Route Telegram chats through conversation sessions when v2 policy selects them.
8. Unify Agent API `ask` with the same manager; preserve ephemeral/keyed semantics and HTTP contracts.
9. Update Agent API `send` to target a normalized conversation.
10. Implement per-conversation cancel/status, session-aware reset with shared-binding confirmation, and session aliasing.

Gate:

- two Telegram chats to one agent maintain isolated sentinel facts;
- two conversations run concurrently within configured limits;
- turns within one conversation remain ordered and never overlap;
- two conversations bound to one legacy/alias session never overlap and observe one shared context in scheduler order;
- a restart between turns preserves Codex and Claude continuity;
- **resident runners (claude-code):** LRU eviction followed by lazy rehydration preserves context;
- **per-turn runners (codex):** no process exists between turns, so the equivalent assertion is that the persisted `thread_id` is reused across an eviction sweep and restart, then deliberately cleared at the `context_expires_at` boundary so the next turn starts a fresh thread — and that eviction/idle-TTL metrics report zero rather than fabricating evictions (§7.2);
- **platform ingress** at pool exhaustion queues durably only up to the configured per-conversation and per-agent hard caps. At a cap, the event receives an auditable `rejected` terminal state and the platform-specific backpressure behavior in §7.7; nothing is silently dropped and nothing queues without a bound. **The Agent API keeps its existing HTTP contract unchanged**: `side_session_capacity`, `side_session_busy`, and `token_concurrency_limit` still return 429. Synchronous HTTP callers get backpressure signalled, not an unbounded wait;
- a crash after runner dispatch produces one terminal `interrupted` turn and no automatic second execution; explicit retry creates a linked turn and warns about possible repeated side effects;
- per-conversation and per-agent crash-loop breakers behave as specified in §7.7, verified by a deliberately poisoned conversation that does not trip the agent-wide breaker;
- Agent API compatibility suite remains green, including the per-token concurrency cap.

**Implementation evidence (2026-08-01 MDT / 2026-08-02 UTC):** runner construction now lives behind `AgentRunnerFactory` and `RunnerSession`, and the promoted `ConversationSessionManager` is the single owner of Telegram v2 and Agent API session lifecycle. Provider-native Claude UUIDs and Codex thread IDs persist per conversation, restore lazily after restart, survive resident-runner LRU eviction, and honor explicit context expiry; per-turn Codex sessions report no fabricated process-eviction metrics. The durable scheduler enforces per-conversation ordering, shared-session serialization, fair cross-conversation dispatch, global and per-agent concurrency bounds, bounded ingress with auditable rejection, turn timeouts, dead-letter handling, and independent conversation and agent-wide crash-loop breakers. V2 crash recovery is explicitly at-most-once after dispatch, including before first output. Cancel, status, alias-aware reset confirmation, normalized Agent API targeting, and existing Agent API 429 behavior are covered. The integration suite proves two-chat sentinel isolation, shared-session ordering, concurrent dispatch within limits, provider-specific restart continuity, and lazy rehydration. All local gates pass with 1,306 tests passed, 13 intentionally skipped, and zero failures; typecheck, lint, formatting, build, and whitespace checks also pass. Phase 3 is complete; Phase 4 is ready to implement.

### Phase 4 — Buzz connection, identity, discovery, and replay

**Purpose:** establish production-grade relay connectivity without prompting runners.

Work:

1. Add Buzz config and secret redaction.
2. Implement NIP-42 authentication and owner-auth-tag injection.
3. Verify inbound signatures and event IDs.
4. Discover accessible channels/DMs and subscribe by channel UUID.
5. React to membership changes without restart.
6. Persist cursors and replay safely across disconnect/restart.
7. Implement author and mention gates.
8. Add endpoint presence/health state, including the `limits.reconnect_alert_after_secs` unhealthy transition while capped probes continue.
9. Add doctor checks (IDs **C016+**; C001–C015 are in use) for key derivation, relay connectivity/auth, owner resolution, membership discovery, and publish permission.
10. Implement the persisted `active → draining → disabled` lifecycle from §6 rule 8, including a minimal local drain/status command before any production Buzz endpoint can be enabled.

Gate:

- open- and closed-relay integration tests pass;
- stale mentions that were durably enqueued but never dispatched are dispatched exactly once after restart; post-dispatch crashes follow the explicit `interrupted` policy;
- new membership becomes live without restart;
- removed membership stops intake;
- wrong-key, wrong-auth-tag, malformed-event, and unauthorized-author paths fail closed;
- logs contain no private key or raw auth tag.

**Implementation evidence (2026-08-01 MDT / 2026-08-02 UTC):** the production gateway now uses the exactly pinned Phase 0 Nostr/Noble dependency chain through a narrow Buzz protocol wrapper. Config v2 validates relay URLs, endpoint keys, normalized pubkeys, owner policy, shared identities, trigger prerequisites, endpoint-scoped `tools.buzz` policy, and strict NIP-OA auth tags while collecting private keys and raw auth tags for central redaction; the master and per-endpoint switches remain fail-closed. `BuzzRelayClient`, `BuzzAdapter`, and the per-endpoint supervisor implement bounded-frame NIP-42 authentication, optional owner-auth-tag injection, signed-event verification, authenticated membership discovery, channel-scoped backlog and live subscriptions, dynamic membership refresh, liveness probes, bounded jittered reconnects, and health transitions. Composite cursors advance atomically with accepted/control/rejected rows or cursor-only discard checkpoints; overlap replay deduplicates event IDs, and an undrainable historical page leaves the cursor unchanged and reports `replay_gap`. Restart recovery dispatches durable pre-dispatch work once and converts post-dispatch work to terminal `interrupted` without automatic execution. A process-wide data-directory lock enforces the single-writer rule. Doctor checks C016–C023 cover the lock, key identity, auth, owner, membership, local publish policy, shared identity, and the pre-Phase 9 tools-policy notice; `torana endpoints status|drain|disable|resume` persists lifecycle state, requires an empty backlog or explicit dead-letter acknowledgement before disable, and keeps draining outbox work eligible while stopping intake. Phase 4 deliberately does not prompt runners or publish conversational replies; those begin in Phase 5. Open/closed relay, restart/dedup, live add/remove, wrong/missing auth, wrong key, malformed/unauthorized input, replay-gap, redaction, doctor, and lifecycle command tests pass. The complete repository suite passes with 1,320 tests passed, 13 intentionally skipped, and zero failures; typecheck, lint, formatting, build, whitespace, and the Phase 0 test/typecheck/manifest/provenance regression gates also pass. Phase 4 is complete; Phase 5 is ready to implement.

### Phase 5 — Buzz text, DMs, mentions, and threads

**Purpose:** ship the first usable end-to-end Buzz conversation path.

Work:

1. Normalize stream and DM messages.
2. Implement DM and direct-mention trigger rules.
3. Map channel/DM/thread conversation keys.
4. Send signed Markdown replies with correct `h`, `e`, and `p` tags.
5. Persist signed outbox events before publishing.
6. Add final-response delivery from runner output; do not rely on model tool use.
7. Implement owner `cancel`, `rotate`, and `status` commands.
8. Add deep links to logs/status where safe.
9. Add multi-agent loop protection: trace tags **and** the tag-independent reply rate backstop (§9.5).
10. **Interim attachment behavior.** Buzz media does not land until Phase 8, but Phases 5–7 will receive messages carrying it. Until Phase 8: parse `imeta` references for metadata only, never fetch them, include a labeled "[N attachments not retrieved]" line in the prompt header with filenames and MIME types, and count them in a `attachments_skipped_total` metric. The text of the message is always delivered. This is a documented limitation, not a silent drop.

Gate:

- live E2E: Jason DM -> agent -> threaded reply;
- live E2E: team channel mention -> only mentioned agent responds;
- sibling direct mention delegates once without loops;
- concurrent messages in two channels use isolated sessions;
- crash after signing but before acknowledgement produces one visible reply;
- Telegram and Buzz can use the same agent concurrently without sharing context unless aliased.

This is the first deployable Buzz release candidate.

**Implementation evidence (2026-08-01 MDT / 2026-08-02 UTC):** Buzz kind-9 stream and DM messages now enter the durable conversation scheduler through the normalized inbound-event seam. Kind-39000 channel metadata distinguishes DMs, owner DMs are eligible without a mention, stream traffic requires the endpoint's exact `p` tag, and a sibling's top-level direct mention delegates once while its threaded answer cannot recursively wake the original sibling. Channel, DM, thread, Telegram, and Buzz identities resolve through the existing conversation/session policy; the default v2 conversation scope keeps different Buzz channels and Telegram isolated unless an explicit alias is configured. Runner final output, intrinsic owner `!cancel`, `!rotate`, `!status`, and `!health` replies are transport-owned rather than model-tool-dependent.

Buzz replies are signed once with Markdown content and the required `h`, NIP-10 `e`, `p`, trace, hop, and owner-auth tags, then the exact signed event and event ID are persisted before relay publication. Retry after an uncertain acknowledgement reuses the identical signed bytes, and relay event-ID confirmation treats an already-visible event as success. The authenticated live-WebSocket harness proves owner DM intake through threaded publication; unit and integration coverage also proves exact stream targeting, runner-final delivery, sibling one-hop delegation, channel/cross-platform session isolation, and local conversation reply suppression independent of trace tags. Prompt framing includes community, channel/DM, thread/reply, author, mentions, a `buzz://message` deep link, and the explicit transport-owned-delivery instruction. `imeta` is parsed as metadata only, files are never fetched before Phase 8, prompts label the skipped attachments, and `attachments_skipped_total` records them.

At the Phase 5 checkpoint, the complete repository suite passed with 1,330
tests passed, 13 intentionally skipped, and zero failures; typecheck, lint,
formatting, build, whitespace, and the Phase 0 protocol/typecheck/manifest/
provenance regression gates also passed.

### Phase 6 — streaming, edits, deletion, reactions, emoji, and presence

**Purpose:** reach rich chat parity.

Work:

1. Add a Buzz renderer with its own byte limits and native GFM.
2. Implement lazy first send and cadence-based signed edit events for streaming.
3. Finalize with a stable final edit or continuation messages when limits are exceeded.
4. Handle inbound edits:
   - update queued, not-yet-dispatched text;
   - attach an edit notice to an in-flight/completed conversation without silently rerunning by default;
   - configurable `rerun_on_edit` remains off by default.
5. Handle tombstones/deletes:
   - cancel queued turns sourced only by the deleted message;
   - mark source deleted in audit metadata;
   - never erase Torana audit/turn records automatically.
6. Add received acknowledgement reactions.
7. Normalize reaction add/remove as optional session events.
8. Preserve and publish custom emoji names; optionally validate against the workspace palette.
9. Publish typing and presence as best-effort ephemeral events that bypass the durable outbox and are never replayed after restart.
10. Rate-limit edits, typing, reactions, and presence independently.

Gate:

- stream updates never exceed relay frame/content limits;
- edit retry cannot fork duplicate visible messages;
- deletion and edit races are deterministic;
- reactions can be disabled and do not trigger loops;
- ephemeral failures never fail the underlying turn;
- reconnect leaves the endpoint presence state correct.

**Implementation evidence (2026-08-02):** Buzz now streams through the shared
lazy-send manager: the first delta creates one durably signed kind-9 event,
cadence updates create durably signed kind-40003 edits, and final output either
stabilizes that event or emits UTF-8-safe continuation messages. Native GFM is
preserved, content is byte-bounded independently from the signed WebSocket
frame, and retries reuse the persisted event ID and signed bytes.

Kind-40003 edits, kind-9005/NIP-09 tombstones, and kind-7 reactions enter the
control-event path. Receive sequence is authoritative; pre-target mutations
are buffered and replayed deterministically. Queued prompts can be revised,
queued deleted sources become durable dead-letter records, executed prompts
are never silently rewritten, and explicit `rerun_on_edit` remains disabled by
default. Received acknowledgements enter the outbox only after enqueue commits;
setting `received_emoji: null` disables them, and reactions never trigger a
turn. NIP-30 custom emoji retain their shortcode and require a configured URL.

Typing and presence are independently rate-limited, best-effort signed
ephemeral events with no outbox rows. Clean shutdown sends offline, heartbeat
refreshes online, and reconnect clears stale ephemeral rate state before
publishing online. Focused Phase 6 tests cover byte boundaries, operation
kinds/tags, custom emoji, mutation races, ephemeral failure isolation, and
durable streaming; the unchanged Telegram streaming suite also passes.

### Phase 7 — forums, votes, workflows, and proactive triggers

**Purpose:** support Buzz's asynchronous/project collaboration surfaces.

Work:

1. Normalize forum posts/comments/votes.
2. Use forum root event IDs as session scope.
3. Support agent-created posts, comments, and votes through outbound operations/tool calls.
4. Add configurable subscriptions for workflow execution and approval events.
5. Allow feed mentions/needs-action and heartbeat prompts as lower-priority trigger sources.
6. Frame workflow/run/approval provenance clearly in prompts.
7. Suppress relay/workflow-generated loop events by default.
8. Add scheduled heartbeats with one-in-flight-per-agent and no queueing when saturated.

Gate:

- two forum roots in one channel retain isolated context;
- nested comments return to the correct root session;
- workflow events cannot recursively amplify;
- heartbeat work never delays already queued human work;
- approvals are never issued without explicit tool policy and agent instructions.

Implementation evidence: forum kinds `45001`, `45003`, and `45002` normalize to
posts, comments, and votes, and outbound operations sign the matching native
events. Forum roots are always included in durable session scope, including
when the general policy is conversation-scoped, while nested comments retain
both root and immediate-reply provenance. Explicitly configured workflow kinds
and needs-action events carry workflow-run identity into isolated conversations
and receive a non-recursion/no-implicit-approval prompt boundary. Feed polling
is opt-in and covers stream v1/v2 mentions plus needs-action events. Scheduled
heartbeats are also opt-in, create durable lower-priority prompts only while the
agent has no queued or running turn, and never accumulate. Focused Phase 7 tests
cover isolated roots, nested replies, signed forum operations, workflow-run
isolation, and the one-in-flight heartbeat gate.

### Phase 8 — attachments and Blossom media

**Purpose:** provide secure inbound/outbound files and images.

Work:

1. Parse and validate `imeta`/media references.
2. Download through authenticated Blossom/media APIs with:
   - URL and redirect validation;
   - MIME allowlist plus magic-byte verification;
   - per-file, per-turn, aggregate disk, and time limits;
   - safe gateway-generated filenames;
   - hash/size verification when metadata supplies them.
3. Feed supported images/files into runners using existing attachment capability checks.
4. Upload outbound files, persist descriptors, and include correct tags.
5. Handle partial upload/send failure and orphan-media cleanup policy.
6. Support media-thread comments through normal reply routing.

Gate:

- image and PDF round trips work with real relay/media storage;
- SSRF, traversal, MIME spoofing, redirect, oversized, and decompression-bomb cases are rejected;
- attachment cleanup survives crash/restart;
- Codex's image-only limitation is surfaced without losing accompanying text;
- outbound retries reuse uploaded media and signed message events.

Implementation evidence: `imeta` references are accepted only when the URL is
an exact-origin `/media/<sha256>[.<ext>]` resource on the configured relay.
Downloads use fresh signed Blossom `t=get` authorization plus NIP-OA
delegation where configured, reject redirects and content encodings, stream
under hard byte/time limits, and verify declared size, SHA-256, allowlisted
MIME, and magic bytes before an exclusive gateway-named write. Image and PDF
paths are durably attached to turns and use the existing retention and orphan
sweeps; Codex continues to receive images while its documented PDF limitation
does not discard the accompanying prompt text.

Outbound image/PDF files are validated locally, uploaded with signed Blossom
`t=upload` authorization (`/upload`, with the Block-compatible legacy fallback),
and converted to native `imeta` tags before the message or forum-comment event
is signed. The descriptors and final event are persisted together before relay
publication, so an acknowledgement-loss retry neither uploads again nor changes
the event ID. A partial multi-file upload is safe but may leave a
content-addressed blob that is not referenced by an event; Torana does not issue
an unsafe delete because the current relay API exposes no ownership-safe orphan
delete contract, leaving blob lifecycle to relay retention/deduplication policy.
Focused Phase 8 tests cover signed image/PDF materialization, durable paths,
same-origin SSRF defense, traversal-safe names, redirect/compression/oversize/
MIME-spoof rejection, retry reuse, and media-thread root routing. The remaining
live gate passed against the Block-hosted closed relay on 2026-08-02: a PNG and
PDF uploaded with signed Blossom authorization, the original signed message was
accepted, an exact-event retry was deduplicated, and authenticated downloads
matched the advertised MIME types, sizes, and SHA-256 hashes.

### Phase 9 — complete Buzz CLI/skill integration

**Purpose:** make the full stable Buzz workspace surface available to agents.

Work:

1. Add a pinned Buzz CLI installation/verification path.
2. Add a Torana-owned Buzz skill package for Claude and Codex.
3. Implement the local endpoint-scoped credential broker/wrapper. The Torana process retains private keys; runners receive no raw Buzz signing material by default.
4. Route skill operations through the broker and validate command group, subcommand, target channel/resource, file arguments, and input/output size before execution.
5. Document and test every CLI command group listed in the capability matrix.
6. Add command policy profiles:
   - `read_only`;
   - `collaborate`;
   - `maintainer`;
   - explicit custom allowlist.
7. Default destructive/admin commands to denied unless the operator opts in.
8. Ensure final conversational replies still go through Torana, while extra workspace actions go through the broker and `buzz-cli`.
9. Add skill/CLI/broker version compatibility doctor checks.

Gate:

- skill parity tests pass for Claude and Codex installs;
- a representative read and write from every CLI group is covered by a mock or live E2E test;
- forbidden policy actions stop before executing the CLI;
- normal typed broker calls always resolve to their configured endpoint and no raw credential enters a runner; same-installation compromised-runner isolation is explicitly out of scope (§10.3);
- the default runner environment contains no raw Buzz private key or auth tag;
- broker path/argument tricks cannot escape the configured command/resource policy;
- all output-contract and exit-code behavior is documented.

Implementation evidence: Torana now starts one local credential broker for
configured Buzz tool policies, using a mode-0600 Unix socket and capability
files on Unix and loopback HTTP with the same short-lived bearer contract on
Windows. Capabilities are bound to the current runner session and exactly one
allowed endpoint; Buzz-origin turns use their ingress endpoint while Telegram
and Agent API turns require an explicit default. The normal runner environment
contains no Buzz private key, auth tag, or relay URL. The broker verifies the
configured CLI checksum at startup, discovers each command's exact flags from
the pinned CLI, builds argv without a shell, applies strict request/input/output
and timeout limits, verifies channel membership and referenced signed events,
limits edit/delete to endpoint-owned messages, and stages only bounded regular
files or symlink-free packs from approved roots. Output paths, credential and
relay overrides, unknown fields/options, malformed event references, and policy
denials stop before CLI execution.

The shared `torana-buzz` skill ships byte-identically for Claude and Codex and
uses `torana buzz call` typed JSON only; final conversational replies remain on
Torana's transport-owned outbox. Named `read_only`, `collaborate`, and
`maintainer` profiles plus exact custom allowlists cover the pinned manifest;
destructive/admin commands require explicit acknowledgement. Doctor C023
reports broker enforcement or the acknowledged raw-key bypass, and C024 checks
the configured binary checksum plus CLI/broker/skill compatibility. Tests cover
a representative operation from all 21 pinned CLI groups, endpoint binding,
credential isolation, command/option/resource policy, file and argument escape
attempts, raw `mem get` bytes, CLI exit codes, runner session wiring, skill
installation/parity, and the official current-format Codex plugin manifest.
The complete repository suite passes with 1,362 tests passed, 13 intentionally
skipped, and zero failures; typecheck, lint, formatting, build, whitespace,
plugin validation, and the Phase 0 transport test/typecheck/manifest/provenance
regression gates also pass. Phase 9 is complete; Phase 10 is ready to implement.

### Phase 10 — observability, administration, and reliability

**Purpose:** make the multi-platform system operable.

Work:

1. Add platform/endpoint/conversation dimensions to logs and metrics with bounded cardinality.
2. Add metrics for:
   - connection/auth/reconnect state;
   - inbound accepted/rejected/deduped by platform/reason;
   - subscription count and replay lag;
   - conversation queue depth and dispatch wait;
   - live/evicted/rehydrated sessions;
   - outbox attempts/retries/dead letters;
   - relay publish acknowledgements and rate limits;
   - attachment bytes/failures;
   - loop-budget rejections.
3. Extend `doctor` (new checks continue from **C016+**), `/health`, dashboard status, and admin APIs.
4. Extend the Phase 4 endpoint lifecycle commands with administrative listing, resume, forced dead-letter acknowledgement, conversation/session inspection, session rotation, outbox replay/dead-letter, and gateway-wide graceful drain.
5. Make the already-normalized alert target platform-neutral in delivery, with a log-only fallback; do not change the Phase 2 target contract.
6. Add graceful shutdown ordering: stop intake, checkpoint cursors, drain accepted turns, finalize/cancel streams, drain outbox, stop sessions, close sockets.

Gate:

- an operator can diagnose wrong key, expired auth tag, lost membership, reconnect loop, stuck conversation, dead outbox, and runner crash without exposing secrets;
- all high-cardinality identifiers stay out of metric labels;
- shutdown/restart loses no accepted inbound event;
- dashboard and CLI accurately distinguish platform, endpoint, conversation, and session.

**Implementation evidence (2026-08-02):** `/health` now combines runner
readiness with persisted endpoint lifecycle, runtime connection state,
redacted/bounded Buzz diagnosis, subscriptions, queue depth, conversations,
sessions, and outbox state. Prometheus adds configured platform/endpoint
lifecycle, connection, subscription, conversation, session, queue, and outbox
families; no conversation, session, turn, event, user, or channel identifier is
used as a metric label. Dispatch and outbox logs carry the corresponding
operator dimensions without changing metric cardinality.

`torana conversations list`, `sessions list|reset`, `outbox
list|replay|dead-letter`, endpoint lifecycle/status commands, and `gateway
drain` provide local administration. The authenticated `/v1/admin/*` surface
mirrors endpoint, conversation, session, rotation, outbox, resume/drain, and
explicitly acknowledged forced-dead-letter operations while filtering every
result and action to the token's allowed agents. Outbox inspection omits
payload bodies and replay republishes the exact stored payload/signed event.
Doctor C025 diagnoses durable backlog without identifiers, C026 validates the
platform-neutral alert target or log fallback, and C027 validates the hard
shutdown budget.

Shutdown now unregisters HTTP intake and stops transports, drains work accepted
before the cutoff within the runner budget, preserves undispatched rows for
restart, cancels unfinished stream cadence, drains the durable outbox, stops
sessions/runners/broker, and closes sockets/SQLite last. Focused tests prove
agent-scoped admin authorization, explicit data-loss acknowledgement, exact
outbox replay, bounded metric labels, platform-neutral Buzz alerts, and both
successful and over-budget accepted-turn drain behavior. The complete
repository suite passes with 1,370 tests passed, 13 intentionally skipped, and
zero failures; typecheck, lint, formatting, build, whitespace, official Codex
plugin validation, and the Phase 0 transport test/typecheck/manifest/provenance
regression gates also pass. Phase 10 is complete; Phase 11 is ready to
implement.

### Phase 11 — security review, soak, documentation, and release

**Purpose:** finish the production rollout.

Work:

1. Threat-model private keys, signed-event replay, author spoofing, membership changes, malicious tags, loop amplification, attachment URLs, workflow injection, and tool policy bypass.
2. Run dependency/license/security audits and secret scanning.
3. Add fault injection for relay disconnects, duplicate delivery, delayed `OK`, dropped `OK`, out-of-order events, DB busy, runner crash, outbox crash windows, membership removal, and auth rotation.
4. Run a mixed-platform soak with all intended personas and realistic conversation counts.
5. Update README positioning from Telegram-only to multi-platform while preserving migration guidance.
6. Update configuration, transports/platforms, security, operations, runners, Agent API, CLI, and examples docs.
7. Publish a Buzz example and an agent-team production example with placeholder secrets only.
8. Roll out behind `platforms.buzz.enabled: false` (§6 rule 8), then one canary agent via its endpoint-level `enabled`, then the full team.
9. Pin the tested Torana and Buzz versions in `agent-team`.
10. Confirm the deployed compatibility bridge is the supported rollback target, then cut **2.0.0** (§6.1) with a CHANGELOG entry covering config v2, the DB migration, the `bot_id`/`agent_id` alias window, and the deprecation of `agent_api.side_sessions` and `pass_continue_flag`.

Release gates:

- default unit/integration suite green;
- real Telegram regression E2E green;
- real Buzz open- and closed-relay E2E green;
- real Codex and Claude restart-continuity E2E green;
- 24-hour mixed-platform soak with zero lost accepted events, zero cross-conversation context failures, bounded resources, and no orphan subprocesses;
- security review has no unresolved P0/P1 findings;
- lossless binary rollback to the compatibility bridge succeeds against the migrated database; emergency snapshot restoration also succeeds with its documented loss window.

**Local implementation evidence (2026-08-02 MDT):** Phase 11 adds a real
Buzz-only v2 runtime path, disabled-by-default Buzz-only and multi-persona
agent-team examples, stale-auth-tag and SQLite-busy fault injection, and a
gated five-persona mixed Telegram/Buzz soak that verifies signed events,
durable delivery, and one-to-one conversation-session isolation. The security
review, fault matrix, audit/license inventory, migration notes, platform,
session, configuration, operations, runner, Agent API, CLI, and release docs
are published in the repository. The default suite passes with 1,376 tests,
14 intentional opt-in skips, zero failures, and 3,735 assertions; typecheck,
lint, formatting, build, whitespace, and the high-severity dependency audit
also pass. Phase 11 is **not release-complete**: the real Telegram and relay
E2Es, real Codex/Claude restart checks, 24-hour soak, canary/full-team rollout,
rollback rehearsal, external `agent-team` version pins, and the 2.0.0 tag and
publication remain operator gates.

**Live gate update (2026-08-02 MDT):** the configured Block hosted closed
relay passed authenticated discovery, signed publication, exact-event
duplicate acknowledgement, intake readback, reconnect replay, and deduplication.
The hosted media probe also passed signed PNG/PDF upload, exact signed-event
retry, signed download, MIME/size validation, and SHA-256 verification. Real
Codex and Claude Agent API request/response and same-session continuity passed
4/4. The pinned local open/closed WebSocket, Rust CLI golden, typecheck,
manifest, installed-binary checksum, release-artifact checksum, and provenance
gates all passed. Remaining operator gates are the real Telegram sandbox and
external open-relay E2Es, fresh cross-process Codex/Claude restart checks,
24-hour mixed-platform soak, production `agent-team` config/version pin and
canary, full-team rollout, rollback rehearsal, and 2.0.0 publication.

---

## 12. Test strategy

### 12.1 Unit tests

- platform capability negotiation;
- Telegram and Buzz normalization;
- Nostr signature/event-ID verification and tag parsing;
- conversation-key derivation and collision resistance;
- Agent API virtual-endpoint/key derivation, including preserved `(agent_id, session_id)` context sharing across authorized tokens while token caps remain independent;
- author/mention/loop gates;
- session scheduling, fairness, eviction, rotation, cancellation, and resume-state updates;
- platform renderers and byte-aware chunking;
- signed-event outbox idempotency;
- ephemeral typing/presence bypass the outbox and are never replayed;
- attachment metadata and URL policy;
- v1/v2 config normalization and redaction, including every row of the §6.3 mapping table and the `agent_api.side_sessions` → `sessions.*` merge with its inherited `superRefine` invariants;
- `received_seq` assignment and out-of-order edit/delete resolution (§9.4);
- composite per-subscription cursor advancement, overlap dedup, pagination, and replay-gap fail-closed behavior (§9.1);
- queue-depth caps, overflow modes, inbound/outbound dead-lettering, and the two-level crash-loop breakers (§7.7);
- ingress-rate coalescing, database high-water behavior, and bridge/incremental-vacuum maintenance (§7.7, §8.4);
- broker policy resolution: each named profile's allow/deny set, deny-wins for unknown subcommands, resource scoping, and argument/path escape attempts (§10.4);
- the tag-independent reply rate backstop (§9.5);
- conversation-row null-normalization (`threadRootId: null` → `''`) at the DB boundary, including a regression test that two non-threaded inserts for one channel collide (§8.1);
- every database helper and migration backfill, including the five v1 tables in §8.2's backfill list.
- compatibility bridge dual-write parity for Telegram and Agent API, plus bridge → 2.0 → bridge rollback on schema v5.

### 12.2 Contract tests

Create reusable suites every platform adapter must pass:

- normalize valid inbound message;
- reject malformed/unauthorized/self events;
- send/edit/delete/reaction where supported;
- retry semantics and stable external ID;
- attachment download/upload;
- typing/presence are best effort;
- an interrupted post-dispatch turn is terminal and never executes automatically a second time;
- reconnect and replay;
- clean shutdown;
- control-plane events (`membership_change`, `channel_lifecycle`, `presence`, `typing`) are handled without creating a turn, and are persisted with status `control`;
- `received_seq` is assigned monotonically and out-of-order edit/delete events resolve per §9.4;
- capability negotiation: an operation the adapter does not advertise degrades gracefully rather than throwing.

### 12.3 Fake Buzz integration service

Build a test fixture implementing the minimal relay behavior Torana depends on:

- NIP-42 challenge/auth;
- channel-scoped REQ/EVENT/EOSE/OK/CLOSED/NOTICE;
- membership discovery and changes;
- event storage/dedup;
- delayed/dropped/negative publish acknowledgements;
- WebSocket disconnect/reconnect;
- Blossom upload/download;
- closed-relay auth-tag enforcement.

Use upstream Buzz fixtures/golden events where licensing and stability allow. Do not make the production test suite depend on the public hosted relay.

### 12.4 Isolation tests

For each supported runner:

1. Put secret sentinel A into conversation A.
2. Put secret sentinel B into conversation B.
3. Ask each conversation for its sentinel and assert no cross-answer.
4. Evict both live processes and repeat.
5. Restart Torana and repeat.
6. Alias A to an explicitly configured cross-platform conversation and verify sharing only under that alias.

### 12.5 Soak invariants

- no accepted inbound event lacks a terminal turn state, with `interrupted` terminal after a post-dispatch crash;
- no successfully completed turn lacks a sent/dead outbox state when a reply is expected; interrupted turns are exempt until an operator explicitly retries them;
- no duplicate visible message for one outbox event ID;
- one in-flight turn maximum per resolved session key (which also implies per-conversation serialization);
- configured concurrency/cap limits never exceeded;
- no context leakage across session keys;
- no unbounded DB, attachment, FD, process, or memory growth;
- no orphan live session rows or subprocesses after shutdown;
- reconnect replay lag converges to zero;
- no queue exceeds its configured depth cap without the documented overflow behavior firing;
- no ephemeral signal survives a restart or appears in the durable outbox;
- outbound replies never exceed `limits.agent_reply_rate_per_conversation` or `limits.agent_reply_rate_per_endpoint`, measured from the outbox rather than from trace tags;
- retention sweeps run and DB size is flat or declining under steady-state load;
- the hard database-size cap stops intake/cursor advancement without acknowledging unpersisted events;
- a single advisory lock holder throughout — no second process ever attaches to the data directory.

---

## 13. Security model

1. **Identity:** every Buzz endpoint uses a distinct Nostr private key by default.
2. **Secret storage:** secrets come from environment/secret files and are held only where signing requires them; never persist raw private keys in SQLite.
3. **Authentication:** validate NIP-42 challenges and relay URL binding; inject only the configured owner auth tag.
4. **Inbound integrity:** verify event IDs and Schnorr signatures even when the relay is trusted.
5. **Authorization:** combine relay membership with Torana's author/mention policy; both must pass.
6. **Private channels:** subscribe only with explicit channel scope and confirmed membership.
7. **Outbound integrity:** persist signed event bytes before publish and never mutate them during retry.
8. **Prompt injection:** frame untrusted message/event metadata distinctly; never turn event tags into system instructions.
9. **Agent loops:** self rejection, direct-mention requirements, trace/hop budgets, and workflow-loop suppression.
10. **Attachments:** authenticated download, SSRF protection, safe filenames, magic-byte validation, caps, and retention.
11. **Tools and trust domain:** keep raw Buzz signing keys in Torana's credential broker by default and enforce destructive/admin command policy there. The broker is a **policy chokepoint, not a sandbox** — the claude-code runner always runs with `--dangerously-skip-permissions`, and every agent in one Torana installation/container belongs to one trust domain. Typed endpoint-scoped calls prevent ordinary cross-identity mistakes, enforce the resolved command/resource policy, and leave an audit trail, but a fully compromised same-container runner may attack sibling capabilities or Torana itself. Hard persona isolation requires separate Torana installations/containers. If an operator explicitly injects a raw key via `expose_private_key_to_runner: true`, even broker policy enforcement for that identity is gone and Torana must say so in validation output, doctor, and logs. See §10.3.
12. **Audit:** Torana records delivery state; Buzz's signed event log remains the collaboration record.
13. **Loop budgets:** trace/hop tags are cooperative metadata, not a control. The enforced limit is Torana's own outbound rate per conversation and per endpoint (§9.5).
14. **Shared identity:** `allow_shared_identity: true` collapses two endpoints onto one keypair. Self-event rejection, outbox ordering, and reply-rate budgets then apply process-wide rather than per endpoint. Doctor warns; the plan does not recommend it.
15. **Key rotation:** rotating a Buzz keypair changes the endpoint's external identity but **not** its conversation keys or resolved session bindings — conversation-scoped keys use stable `endpoint_id`, while legacy/alias keys use stable agent/config identities, never the pubkey (§5.3). Rotation therefore preserves every conversation session and all persona memory. The procedure is in §14.5.

---

## 14. Operations and deployment

### 14.1 Railway secret layout

Use one secret pair per persona:

```text
BUZZ_PRIVATE_KEY_CATO
BUZZ_AUTH_TAG_CATO
BUZZ_PRIVATE_KEY_HARPER
BUZZ_AUTH_TAG_HARPER
...
BUZZ_RELAY_URL                    # non-secret if shared
BUZZ_OWNER_PUBKEY                 # non-secret
```

Materialize secret files mode `0600` when subprocess compatibility requires files. Torana and its credential broker may access only the relevant endpoint key. Conversation runners receive broker access rather than raw signing keys unless the operator explicitly enables the dangerous bypass.

**Cost note.** Per-conversation sessions multiply provider context: ten active Buzz channels against one agent are ten independent contexts, not one shared one. Provider billing and reload behavior differ by runner, but both retained context and concurrent turns can increase cost. `sessions.max_global`, the concurrent-turn caps, and `context_retention_ms` are therefore cost controls as well as resource controls. Operators moving from one Telegram chat to a team-wide Buzz deployment should expect spend to scale with both conversation count and activity.

### 14.2 Canary sequence

1. Deploy platform-neutral refactor with v1 Telegram config only.
2. Enable conversation sessions for one Telegram canary agent.
3. Add one Buzz endpoint for a non-critical canary persona: configure it, then flip `platforms.buzz.enabled: true` **and** that endpoint's `enabled: true`. Every other Buzz endpoint stays `enabled: false`, so the master switch alone activates nothing.
4. Test owner DM, one team channel, one forum thread, restart, key rotation (§14.5), and membership removal.
5. Add remaining personas one at a time.
6. Enable sibling-agent author allowlists only after loop-budget metrics are visible.
7. Enable rich triggers, workflows, and heartbeats last.

### 14.3 Rollback

- Feature flags can stop Buzz intake without stopping Telegram.
- Endpoint disablement checkpoints the cursor and leaves sessions/context intact.
- Database migration always creates a pre-upgrade snapshot.
- The designated 1.x compatibility bridge runs against the migrated database and v1 config; arbitrary older releases do not.
- Key rotation or Buzz rollback never requires changing persona content/memory.

**The snapshot rollback has a data-loss window, and it must be stated plainly.** Restoring the pre-migration snapshot discards everything written after the migration ran — turns, outbox rows, and conversation context from the entire post-upgrade period. Mitigations, in order of preference:

1. _Preferred:_ transition Buzz endpoints to `draining`, let accepted turns and outbox rows reach terminal states, transition them to `disabled`, then roll back the **binary only** to the designated compatibility bridge. The bridge understands schema v5, dual-written Telegram/Agent-API state, nullable legacy columns, and preserved Buzz rows (§8.2). It ignores Buzz work while keeping it intact for a later 2.0 recovery. Verify this path before the canary — it is the difference between a 5-minute lossless revert and a data-losing restore.
2. _Fallback:_ snapshot restore, accepting the loss window. Take a fresh snapshot immediately before restoring so the discarded period is recoverable for forensics.
3. Rehearse both paths before the canary, not after.

The current `1.0.0-rc.9` and any other binary whose migration dispatcher knows only schema version 3 are not valid binary-only rollback targets. “Previous binary” throughout release documentation means the specifically tested compatibility bridge.

### 14.4 Single-writer requirement

The design assumes exactly one Torana process owns a given database and set of endpoints. Two processes would double-subscribe to the relay, double-dispatch queued turns, and publish duplicate signed events (relay dedup only helps for byte-identical events, which independently-signed replies are not).

- Acquire an exclusive advisory lock on the data directory at startup; refuse to start if held, with a clear error naming the holding PID.
- Deployment platforms that overlap old and new instances during a deploy (Railway included) must be configured for stop-then-start, not overlap, for the gateway service.
- Doctor check (C016+) verifies the lock is obtainable and reports the configured deploy strategy where detectable.
- This is not new to this plan — the current single-primary-runner design has the same requirement implicitly. Making it explicit is a prerequisite for relay connectivity, where duplicate publication is externally visible.

### 14.5 Buzz key rotation

Rotation must not disturb conversations. Because conversation keys and resolved session bindings derive from stable endpoint/agent/config identities and never from the pubkey (§5.3, §13.15):

1. Provision the new keypair as a new secret (`BUZZ_PRIVATE_KEY_<PERSONA>_NEXT`) and register its pubkey with the relay/community; obtain the new auth tag.
2. Transition the endpoint to `draining`. Intake and proactive triggers stop, the cursor checkpoints, sessions/context stay resident, and already accepted turns plus outbox rows continue toward terminal states.
3. After the accepted-work and outbox backlog reaches zero, transition the endpoint to `disabled`. Rows still holding signed bytes from the **old** key must have published or been explicitly dead-lettered before the swap — they cannot be re-signed under the new key without changing their event IDs (§8.3).
4. Swap `private_key` and `auth_tag`, restart, set `enabled: true`, and explicitly resume the endpoint to `active`.
5. Re-verify membership: channel access is granted per pubkey, so the new identity must be re-admitted to every channel the old one belonged to. `subscribe` discovery reports what is missing; doctor check C016+ flags channels lost across the rotation.
6. Announce the identity change in the affected channels — to human collaborators the agent is a new pubkey, and the old one should be treated as retired.

Q4 is closed: the Block-hosted relay uses the NIP-OA tag as a reusable capability on fresh NIP-42 connections. No periodic refresh is required. Replace it only with key rotation, before an explicit `created_at<...` condition expires, or in response to an authentication failure; owner membership is rechecked on each new connection.

---

## 15. Proposed source layout

```text
src/
  platform/
    types.ts
    capabilities.ts
    registry.ts
    telegram/
      adapter.ts
      normalize.ts
      delivery.ts
      webhook.ts
      polling.ts
    buzz/
      adapter.ts
      client.ts
      auth.ts
      kinds.ts
      tags.ts
      normalize.ts
      delivery.ts
      discovery.ts
      subscriptions.ts
      cursor.ts
      media.ts
      policy.ts
  conversation/
    key.ts
    manager.ts
    scheduler.ts        # §7.6 dispatcher — sole owner of turn dispatch
    session.ts
    commands.ts
    aliases.ts
    backpressure.ts     # §7.7 queue caps, breakers, dead-letter rules
  tools/
    broker/
      server.ts         # §10.2/§10.3 credential broker (Unix socket / loopback HTTP)
      policy.ts         # §10.4 profile resolution and command/resource validation
      client.ts         # the shim the runner invokes in place of `buzz`
  core/
    agent-runtime.ts
    ingest.ts
    attachments.ts
    retention.ts        # §8.4 purge sweeps
  rendering/
    telegram.ts
    buzz.ts
  outbox/
    processor.ts
    payload.ts
  db/migrations/
    0004_platform_core.sql
    0005_conversation_sessions.sql
```

Migration numbering is confirmed against the repository as of this revision: `PRAGMA user_version` is currently `3` (set by `0003_runner_session_resume.sql`), so `0004` and `0005` are the next free numbers and land the database at `user_version = 5`. Re-verify before implementation in case another migration merges first.

---

## 16. Documentation deliverables

- `README.md`: multi-platform positioning and quick starts.
- `docs/platforms.md`: common platform contract and capability matrix.
- `docs/platforms/telegram.md`: webhook/polling and v1 compatibility. Absorbs the current `docs/transports.md`, which is reduced to a one-line stub pointing here — the file is linked from README and existing installs, so it must not simply disappear.
- `docs/platforms/buzz.md`: identities, relay auth, membership, subscriptions, sessions, event kinds, tools, and troubleshooting.
- `docs/sessions.md`: conversation keys, isolation, aliases, retention, reset/cancel, and capacity.
- `docs/configuration.md`: full v2 schema and v1 upgrade path.
- `docs/security.md`: Nostr keys/auth, signatures, channel access, loop prevention, media, and tool policy.
- `docs/operations.md`: cursors, replay, dead letters, key rotation, membership changes, backup/restore, and rollback.
- `docs/agent-api.md`: normalized conversation targets and shared session manager.
- `examples/buzz-agent/`: one Buzz-only agent.
- `examples/multiplatform-agent/`: one logical agent on Telegram and Buzz.

---

## 17. Open decisions

The first draft filed all ten of these as "close in Phase 0". Four of them are not Phase-0-shaped, and three are already decisions rather than investigations. Splitting them prevents Phase 0's gate from being unpassable and prevents the settled ones from being silently reopened.

### 17.1 Genuinely open — block Phase 0

No architecture decision remains open. Q5 was closed by the authenticated real-CLI E2E and is recorded in §17.3.

The artifact-provenance and deployment-capacity evidence gates are closed in `docs/buzz-phase0-findings.md`; they are locked implementation inputs rather than unresolved architecture choices.

### 17.2 Open, but owned by a later phase

| #   | Question                                                                         | Owning phase              | Interim position                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q8  | Which typed broker transport enforces tool policy without exposing signing keys? | Phase 9                   | typed RPC over a private Unix socket on Unix, loopback HTTP + short-lived bearer on Windows; broker constructs CLI argv. One installation remains one trust domain (§10.3) |
| Q9  | Which Buzz binary/version distribution suits Linux Railway images?               | Phase 9                   | pin a released tag and verify checksum at image build                                                                                                                      |
| Q11 | Should Telegram forum topics get their own sessions?                             | deferred, no owning phase | `telegram_topic_isolation` defined in §5.3, ships disabled and untested                                                                                                    |

### 17.3 Decided — recorded here so they are not reopened

| #   | Decision                                                                                                                                  | Rationale                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q4  | Block-hosted relay NIP-OA auth tags are reused across fresh NIP-42 connections; no periodic refresh job is required                       | Block's NIP-AA contract defines reusable credentials; rotate with the agent key, before an explicit time condition expires, or after auth failure while rechecking owner membership |
| Q1  | Use a narrow wrapper around exactly pinned `nostr-tools@2.24.1` and Noble primitives                                                      | MIT-compatible dependency chain, precise protocol control, Rust CLI event-ID parity, and Buzz NIP-OA golden-vector parity                                                           |
| Q2  | Default turn-producing stream kinds are `9` and `40002`; mutation state uses `40003`, `5`, and `9005`; rich surfaces remain feature-gated | Preserves stream v1/v2 compatibility without turning control or rich-surface events into prompts                                                                                    |
| Q3  | Membership add/remove are relay-signed global kinds `44100`/`44101`, scoped by `p=<agent>` and carrying `h=<channel>`                     | Matches the pinned relay and `buzz-acp` contract; event-ID dedup preserves same-second transitions                                                                                  |
| Q5  | Claude uses `--session-id <persisted-uuid>` for the first process and `--resume <persisted-uuid>` after eviction                          | Authenticated Claude Code `2.1.220` cross-process E2E preserved the provider session ID and sentinel context                                                                        |
| Q6  | Stream-thread isolation is **opt-in per channel**, not inferred from the presence of a reply root                                         | inferring would silently fragment a channel's context the first time anyone threads a reply                                                                                         |
| Q7  | Outbound streaming edits are **on by default from Phase 6**, with final-only fallback when the relay rejects edit rate                    | matches Telegram behavior; fallback keeps a slow relay from losing the reply                                                                                                        |
| Q10 | Package **name** stays `torana`; the **description** and README change at 2.0.0                                                           | renaming a published package costs more than the positioning gain                                                                                                                   |
| Q12 | Release is cut as **2.0.0** (§6.1)                                                                                                        | config v2 + DB migration + repositioning                                                                                                                                            |
| Q13 | Lossless rollback targets a deployed 1.x compatibility bridge, not the current rc.9 binary or an arbitrary prior binary                   | schema-v5 awareness and dual-write behavior are required for a non-data-losing revert (§8.2, §14.3)                                                                                 |
| Q14 | One Torana installation/container is one trust domain; hard persona identity isolation requires separate installations                    | all agents in the planned deployment share one container and therefore no reliable OS boundary (§10.3)                                                                              |
| Q15 | Post-dispatch runner execution is at-most-once; interrupted turns require explicit retry                                                  | automatic replay could duplicate file, Git, messaging, or administrative side effects (§7.6)                                                                                        |

---

## 18. Definition of done

The implementation is complete when:

1. Existing v1 Telegram deployments upgrade without behavior changes under documented resource limits; overload receives the new explicit bounded/rejected behavior in §7.7.
2. A v2 agent can expose Telegram and Buzz endpoints simultaneously.
3. Every Telegram chat, Buzz DM/channel/forum thread, and Agent API session receives the configured independent session scope.
4. Session context survives live-process eviction and gateway restart for Codex and Claude.
5. Accepted inbound events are durable, deduplicated, authorized, and either reach a terminal turn or a visible dead-letter state.
6. Outbound Buzz retries cannot create duplicate signed messages.
7. DMs, channels, mentions, threads, edits, deletions, reactions, custom emoji, forums/votes, files/media, presence, typing, membership changes, feed/heartbeat triggers, and owner controls have documented and tested behavior.
8. Every stable Buzz CLI command group is available through the pinned CLI/skill with appropriate policy controls.
9. Multiple personas can share a Buzz team channel, delegate through explicit mentions, and remain protected from response loops — including against a peer that omits or forges trace tags.
10. The mixed-platform 24-hour soak and security gates pass.
11. Production can enable/disable Buzz per endpoint and roll back to the designated compatibility bridge without losing post-upgrade Telegram/Agent-API state, Buzz rows, or persona memory; snapshot restore remains the documented emergency fallback (§14.3).
12. Every queue, table, and process pool has a documented bound and every failure has a terminal state plus an operator path: no unbounded mailbox, no unbounded retention, and no ambiguous post-crash execution state (§7.6–§8.4).
13. The Agent API's existing HTTP contract — including 429 on capacity, busy, and per-token limits — is unchanged, and the per-token concurrency cap survives the promotion to `ConversationSessionManager`.
14. A Buzz keypair can be rotated per §14.5 without losing conversation sessions, and doctor reports any channel membership lost across the rotation.
15. Broker tests prove exact typed-command/resource enforcement and absence of raw keys in runners; documentation and doctor state that one installation/container is one trust domain and that hard sibling-identity isolation requires separate installations.

---

## 19. Primary references

- Torana current architecture: `README.md`, `docs/transports.md`, `docs/agent-api.md`, `src/transport/types.ts`, `src/core/bot.ts`, `src/core/registry.ts`, `src/outbox.ts`, `src/streaming.ts`, and `src/db/schema.sql`.
- Buzz ACP harness and channel/session behavior: <https://github.com/block/buzz/blob/main/crates/buzz-acp/README.md>
- Buzz protocol and relay architecture: <https://github.com/block/buzz/blob/main/ARCHITECTURE.md>
- Buzz agent-first CLI: <https://github.com/block/buzz/blob/main/crates/buzz-cli/README.md>
- Buzz repository guidance/event scoping: <https://github.com/block/buzz/blob/main/AGENTS.md>
- Buzz project/forge direction: <https://github.com/block/buzz/blob/main/VISION_PROJECTS.md>

These `main` links are human-readable entry points. Phase 0 records the exact commit/tag, CLI manifest, and artifact checksum used as implementation evidence; compatibility and broker policy never float with `main`.

Ground-truth references verified against the repository at this revision: `src/config/schema.ts` (v1 schema and `SECRET_PATHS`), `src/config/v2.ts` (v2 endpoint and Buzz invariants), `src/agent-api/pool.ts` (`SideSessionPool`, per-token caps), `src/agent-api/errors.ts` (429 codes), `src/runner/types.ts` (`SIDE_SESSION_ID_REGEX`, `runnerSupportsSideSessions`), `src/runner/claude-code.ts` (`claudeUuid`, `--session-id`), `src/runner/codex.ts` (one-shot `exec resume` model), `src/platform/buzz/protocol.ts`, `src/platform/buzz/client.ts`, `src/platform/buzz/adapter.ts`, `src/platform/buzz/transport.ts`, `src/db/schema.sql`, `src/db/migrations/0001–0005`, and `src/doctor.ts` (C001–C023).

---

## 20. Known risks carried into implementation

These are accepted, not solved. Each has an owner phase and a fallback.

| Risk                                                                                                                                         | Severity | Fallback                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner or Railway resource characteristics drift beyond Phase 0's measured envelope                                                          | High     | Ship the approved `max_global: 32` and concurrent-turn ceilings; rerun the authenticated capacity probe after a material runner-version or deployment-limit change                                                                    |
| One Torana installation/container is one trust domain; the broker does not hard-isolate sibling identities from a compromised runner (§10.3) | High     | Keep raw keys in the typed broker, use short-lived endpoint-scoped calls and exact policy manifests, and deploy separate Torana installations/containers when hard persona isolation is required                                      |
| A time-bounded Buzz auth tag expires or the owner's relay membership is removed                                                              | High     | Validate tag conditions at load, reuse the tag only within its declared window, recheck membership on every connection, and fail closed with an authentication alert                                                                  |
| A 12-phase program risks a long-lived refactor branch with no user-visible value through Phases 1–3                                          | Medium   | Phases 1–3 are behavior-preserving by construction and must land on trunk incrementally behind config defaults, not on a long branch. Phase 1's gate ("identical Telegram requests for representative turns") is what makes that safe |
| Telegram forum topics share one session (§5.3)                                                                                               | Low      | Matches today's behavior exactly; `telegram_topic_isolation` exists as an escape hatch if it becomes a real complaint                                                                                                                 |
| Buzz protocol drift — kinds and tags may change upstream                                                                                     | Low      | Centralized in `src/platform/buzz/protocol.ts`; unknown or disabled kinds are ignored without runner dispatch (§10.1)                                                                                                                 |

## 21. Refinement log

- **Passes completed:** the original 8-pass review plus a second implementation-readiness review against the current Torana schema/migration dispatcher, installed Buzz CLI command tree, and upstream Buzz documentation.
- **Product decisions closed:** lossless rollback uses a deployed compatibility bridge (Q13); one Torana installation/container is one trust domain (Q14); post-dispatch runner execution is at-most-once with explicit retry (Q15).
- **Second-review corrections:** replaced the impossible arbitrary-prior-binary rollback promise; added expand/contract dual-write behavior; separated conversation keys from shared session bindings; made ephemeral sessions representable; made control-event fields nullable; bounded queue overflow; prevented automatic side-effect replay; split typing/presence from the outbox; reconciled signed-payload retention; added transactional receive sequences, pending mutation storage, and composite cursors; completed retention/trigger/alias configuration; and aligned broker profiles with exact pinned CLI commands.
- **Phase 0 execution pass:** resolved Q1–Q3 and Q5; added the tracked transport spike, CLI manifest/checksum, Rust↔TypeScript golden-event tests, NIP-OA verification, fake open/closed relay coverage, authenticated hosted closed-relay publish/replay/intake evidence, reconnect/dedup coverage, local idle and authenticated 1/2/8/32 capacity measurements, authenticated Codex runner plus full-HTTP continuity E2E coverage, authenticated Claude cross-process resume coverage, and a byte-for-byte mapping from the installed CLI to the official `desktop-v0.5.3` release at commit `3a96acea09b4a9e3f02c3a26cfb0607d2ccacf42`. The production defaults are `max_per_agent: 8`, `max_global: 32`, `max_concurrent_turns_per_agent: 2`, and `max_concurrent_turns_global: 12`. No additional internal design inconsistency is known, and Phase 1 is ready to implement.
- **Phase 1 implementation pass:** introduced the platform-neutral endpoint, conversation, principal, inbound-event, outbound-operation, ephemeral-signal, and attachment contracts; moved Telegram normalization and capabilities behind `TelegramAdapter`; split Telegram compatibility ingestion from platform-neutral processing; converted registry, runtime, streaming, outbox, alerts, and commands to adapter dependencies; added generic metrics while retaining the deprecated Telegram series for one release; and verified identical representative Telegram request bodies plus the complete Telegram integration flow. All Phase 1 gates pass, and Phase 2 is ready to implement.
- **Phase 2 completion pass:** added validated config v2 plus lossless v1 normalization and upgrade output; added schema v5, sanitized migration planning, automatic snapshots, incremental auto-vacuum, normalized DB helpers, compatibility dual-writes, and string-safe platform-neutral outbox delivery; rehearsed bridge → v2 → bridge and emergency snapshot restoration; and verified v1 parity plus a complete v2 Telegram flow. All local gates pass with 1,305 tests passed and 13 intentionally skipped. The published `v1.0.0-rc.10` compatibility bridge then completed the required Railway schema-v3 soak, explicit dry-run and v3→v5 maintenance migration, post-migration doctor and invariant checks, and schema-v5 soak. Final deployment `c5c51ab4-eed9-4de0-877a-26b9ab679e2e` is healthy on schema v5, so Phase 2 is complete and Phase 3 is ready to implement.
- **Phase 3 implementation pass:** extracted provider construction and session state into `AgentRunnerFactory`, `RunnerSession`, and `ConversationSessionManager`; persisted provider-native resume state with lazy restore, LRU behavior, and context expiry; introduced bounded, fair, durable scheduling with per-conversation ordering, shared-session serialization, concurrency limits, timeout/dead-letter handling, at-most-once crash recovery, and scoped circuit breakers; routed Telegram v2 and Agent API work through the same manager while preserving Agent API IDs and 429 contracts; and added session-aware cancel, status, aliases, and reset confirmation. The complete suite passes with 1,306 tests passed and 13 intentionally skipped, including two-chat isolation, concurrency and ordering, shared context, provider restart continuity, lazy rehydration, cap rejection, poison isolation, and v2 no-replay recovery. Phase 3 is complete and Phase 4 is ready to implement.
- **Phase 4 implementation pass:** promoted the pinned Phase 0 cryptographic wrapper into production; added strict Buzz config, identity, owner-auth, shared-key, trigger, tools-policy, kill-switch, and redaction handling; implemented authenticated per-endpoint relay supervision, scoped discovery/subscriptions, heartbeat probes, dynamic membership changes, composite cursor replay, cursor-only discard checkpoints, replay-gap failure, durable pre-dispatch recovery, and post-dispatch interruption; added single-writer locking, C016–C023 doctor coverage, health reporting, and persisted endpoint status/drain/disable/resume commands with backlog-safe disable semantics. Open/closed relay and all fail-closed/restart/lifecycle gates pass without runner prompting. The complete suite passes with 1,320 tests passed and 13 intentionally skipped; all static, build, whitespace, and Phase 0 regression gates pass. Phase 4 is complete and Phase 5 is ready to implement.
- **Phase 5 implementation pass:** connected durable Buzz stream/DM intake to the conversation scheduler and transport-owned runner final delivery; added exact direct-mention and owner-command triggers, channel/DM/thread context framing and deep links, conversation-scoped cross-platform isolation, signed Markdown replies persisted before publish, exact-byte acknowledgement-loss retry, one-hop sibling delegation, trace/hop diagnostics, tag-independent local reply budgets, and metadata-only interim `imeta` handling with skipped-attachment metrics. The authenticated WebSocket E2E and complete repository/static/Phase 0 regression gates pass. Q4 is closed from Block's current NIP-AA contract: the auth tag is reusable across fresh NIP-42 connections and needs replacement only for key rotation, an explicit time-bound condition, or auth failure. Phase 5 is complete and Phase 6 is ready to implement.
