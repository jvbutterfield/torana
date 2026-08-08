# Configuration reference

All configuration lives in a single YAML file (default `./torana.yaml`). The schema is validated with [Zod](https://zod.dev); errors point at the exact bad path.

> **Version key.** Config versions `1` and `2` are accepted. Version 1 remains
> the compatibility format. Version 2 models agents, platform endpoints, and
> session policy separately. Version 2 is required for Buzz endpoints.

## Upgrading a v1 config

Render a reviewable v2 file without changing the source:

```sh
torana config upgrade --from v1 --to v2 --input ./torana.yaml > ./torana.v2.yaml
torana validate --config ./torana.v2.yaml
```

The upgrade preserves the v1 agent-wide session behavior as
`sessions.scope: legacy_agent`, maps every `bots[]` entry to an `agents[]`
entry with a `<agent>-telegram` endpoint, and converts legacy alerts to
`alerts.target`. Buzz endpoints can now be enabled for authenticated channels,
DMs, streaming replies, edits, deletes, reactions, typing, and presence.

### Buzz endpoint controls

Buzz uses the Block hosted relay over an authenticated WebSocket. Keep the
private key and reusable owner-attestation tag in runtime secrets, not in the
checked-in YAML.

```yaml
platforms:
  buzz:
    enabled: true
    cli_path: buzz
    # Exact checksum of the pinned Buzz 0.5.7 binary in this image/host.
    cli_sha256: 3c0d8264d8b994c3a19e4d769802e184b74caa8e5688ad432fc5722acc7eb545
    message_max_bytes: 65536
    max_frame_bytes: 524288

limits:
  buzz_edit_cadence_ms: 2000
  typing_min_interval_ms: 4000
  reaction_min_interval_ms: 1000
  presence_min_interval_ms: 30000
  presence_failure_threshold: 2
  owner_shutdown_drain_ms: 30000

agents:
  - id: assistant
    endpoints:
      - id: assistant-buzz
        platform: buzz
        enabled: true
        community_id: primary
        relay_url: ${BUZZ_RELAY_URL}
        private_key: "${BUZZ_PRIVATE_KEY_CATO}"
        auth_tag: "${BUZZ_AUTH_TAG_CATO}"
        owner_pubkey: "${BUZZ_OWNER_PUBKEY}"
        respond_to: owner_only
        owner_shutdown: enabled # owner "!shutdown" stops the endpoint
        reactions: { received_emoji: "👀" } # null disables acknowledgements
        rerun_on_edit: false
        include_reactions_in_context: false
        custom_emoji_palette:
          ship_it: https://cdn.example/emoji/ship-it.png
    tools:
      buzz:
        policy: collaborate
        default_endpoint_id: assistant-buzz
        allowed_endpoint_ids: [assistant-buzz]
```

#### Presence, heartbeats, and the relay's TTL

A Buzz client decides whether an agent is online from one thing only: kind
`20001` presence events signed by the agent's own key. The relay expires
presence 180 seconds after the last accepted one, so the online dot is a
countdown that each endpoint supervisor restarts every
`platforms.buzz.subscription.heartbeat_secs` (default 30).

Two settings interact here, and the interaction is deliberate:

- `limits.presence_min_interval_ms` (default 30000) rate-limits
  **conversation- and runner-driven** presence signals only. The supervisor's
  own lifecycle refresh — the connect-time publish and every heartbeat — is
  exempt. Without that exemption a heartbeat sitting at or inside the rate
  limit loses roughly every other refresh, halving the margin against the
  180 s TTL, and the shipped defaults (30 s heartbeat, 30000 ms limit) sit
  exactly on that boundary. Configuring a limit longer than the heartbeat is
  therefore allowed and harmless.
- `heartbeat_secs` must stay under 90. One dropped publish must not outlive
  the relay's TTL, and config validation rejects anything that could. Leave it
  at the default unless you have a measured reason.

#### Owner `!shutdown`

`owner_shutdown` (endpoint-level, default `enabled`) makes a stream message
whose trimmed content is exactly `!shutdown`, p-tagging the endpoint and signed
by `owner_pubkey`, a stop command rather than a prompt — that is what Buzz
Desktop's "Stop" publishes for a remote agent. The endpoint drains for up to
`limits.owner_shutdown_drain_ms` (default 30000), publishes presence `offline`,
and is disabled durably; it does not come back on restart. `disabled` restores
the previous behaviour, where the agent answers its own stop command. See
[operations](operations.md#owner-shutdown-remote-agent-stop).

`limits.presence_failure_threshold` (default 2) is how many consecutive
lifecycle presence publishes may fail before the endpoint is marked
`unhealthy` with `last_error: presence_stale` and a `workerDegraded` alert
fires — once per episode, cleared by the next successful publish. Two failures
flags the problem while a third heartbeat can still land inside the TTL.
`/health` reports `endpoints[].presence`, and `/metrics` exposes
`torana_endpoint_presence_publishes_total` by outcome plus
`torana_endpoint_presence_stale`.

`message_max_bytes` is the UTF-8 content ceiling. `max_frame_bytes` is the
larger signed WebSocket envelope ceiling and must be at least 4096 bytes above
the content ceiling. Edits and reactions are durable; typing and presence are
best effort and are never replayed after restart. A custom emoji shortcode
must have an HTTP(S) URL in `custom_emoji_palette` so the emitted NIP-30 tag is
complete.

### Buzz CLI broker and policies

Torana 2 runs workspace actions through a local credential broker. During an
active runner turn, the `torana-buzz` skill sends a typed request to a private
Unix socket (loopback HTTP on Windows). The short-lived capability is bound to
one endpoint. The runner normally receives neither `BUZZ_PRIVATE_KEY` nor
`BUZZ_AUTH_TAG`; Torana injects those only into the pinned `buzz` subprocess.

Available policies are:

- `read_only`: stable read commands only.
- `collaborate` (default): ordinary messages, reactions, joins/leaves, notes,
  memory updates, uploads, issues, patches, pull requests, and social actions.
- `maintainer`: adds channel/canvas/emoji/project/repository/workflow
  maintenance, but still excludes high-risk administration.
- `custom`: exactly the entries in `allowed_commands`.

High-risk custom entries such as `channels.delete`, `projects.delete`,
`workflows.approve`, moderation mutations, agent management, and
`repos.protect.set|remove` also require `acknowledge_dangerous: true`. Unknown
commands fail closed. A channel
operation is denied when the bound endpoint is not a member, and message edits
or deletes are limited to events authored by that endpoint.

The escape hatch `expose_private_key_to_runner: true` requires both an explicit
`default_endpoint_id` and `acknowledge_dangerous: true`. It bypasses broker
policy because the runner can invoke Buzz directly, so use it only inside a
separately isolated Torana installation.

### Pinned Buzz CLI installation

The supported command manifest comes from Block Buzz tag `desktop-v0.5.7`,
commit `f167818d25dd9f03115ab907a16f07daee2ece5c`. On Apple Silicon, the verified
release archive is `Buzz_0.5.7_aarch64.app.tar.gz` with SHA-256
`7a3db77fdb658637b1316b5aa09b2c8a82090ff380c8bf0961fd0273f4c472d2`;
the bundled `buzz` executable has the default checksum shown above.

For Linux images, build `buzz-cli` from that exact tag with the committed
`Cargo.lock`, copy only the resulting `buzz` binary into the runtime image, and
set `platforms.buzz.cli_sha256` to the checksum calculated during the image
build. Do not use a floating `main` build. At startup the broker refuses a byte
mismatch, and `torana doctor` C024 reports CLI checksum plus broker/skill
manifest compatibility.

Follow [Buzz CLI upgrades](buzz-cli-upgrades.md) for the required provenance,
policy-review, release, downstream-image, canary, and rollback sequence. The
Desktop app, local CLI symlink, Torana broker manifest, and deployed Linux CLI
are separate version surfaces and must not be assumed to advance together.

Install the shared skills for both supported runners with:

```sh
torana skills install --host=claude,codex
```

In v2, Telegram-wide transport settings live under
`platforms.telegram.delivery`; bot identity and credentials live under
`agents[].endpoints[]`; Agent API side-session limits move to `sessions.*`.
The deprecated `agent_api.side_sessions` block is accepted during the bridge
window, but `sessions.*` is authoritative.

## Env interpolation

Any string value supports `${VAR}` and `${VAR:-default}` substitution:

```yaml
bots:
  - id: assistant
    token: ${TELEGRAM_BOT_TOKEN_CATO} # required env var
    reactions:
      received_emoji: ${ACK_EMOJI:-👀} # with default
```

A missing `${VAR}` (no default) is a fatal load error. Numeric fields use `z.coerce.number()`, so `allowed_user_ids: [${MY_ID}]` works naturally.

## Env inheritance to runner subprocesses

`runner.env` is the **complete** environment passed to the subprocess. Parent-process env is **not** inherited by default — except `PATH`, which is inherited unless explicitly set.

To inherit a specific var, reference it via `${VAR}`. To disable PATH inheritance, set `PATH: ""` explicitly. Rationale: explicit > implicit, and avoids the classic "works locally, breaks in prod because PATH differs" footgun.

`runner.secrets` is a sibling of `runner.env` for **inlined sensitive values**. Same shape (string→string), merged on top of `runner.env` into the spawn env, but every value is registered with the log redactor at load time and printed as `<redacted:N chars>` in `torana validate`. Setting the same key in both `env` and `secrets` is rejected at load time. Prefer `${VAR}` indirection in `env`; use `secrets` only when env-var indirection isn't feasible. See [Inlined secrets](runners.md#inlined-secrets-runnersecrets) in the runners doc.

## Config resolution order

1. `--config <path>` CLI flag
2. `$TORANA_CONFIG` env var
3. `./torana.yaml` in cwd
4. `./torana.config.yaml` in cwd

## Full reference

Both config versions are supported. The blocks below are grouped by which
version uses them:

- **[Common](#version)** — `version`, `gateway`, `access_control`, `alerts`,
  `worker_tuning`, `streaming`, `outbox`, `shutdown`, `dashboard`, `metrics`,
  `attachments`, `agent_api`
- **[v2 only](#v2-only-blocks)** — `platforms`, `sessions`, `retention`,
  `agents[]`, `agents[].endpoints[]`, `publishers[]`, `publisher_api`
- **[v1 only](#v1-only-blocks)** — `telegram`, `transport`, `bots[]`

A v1 config keeps working unchanged. `torana config upgrade --from v1 --to v2
--input torana.yaml` renders the v2 equivalent without overwriting the original.

### `version`

`1` or `2` (required). Schema version.

### `gateway`

| Key          | Type                       | Default                  | Notes                                                                                                                                                                                                     |
| ------------ | -------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port`       | int                        | `3000`                   | HTTP listen port. On PaaS (Railway/Heroku/Fly/Render) use `${PORT:-3000}` — see note below                                                                                                                |
| `bind_host`  | string                     | `127.0.0.1`              | Interface the HTTP server binds to. Default is loopback-only so `/health`, `/metrics`, `/dashboard`, and the agent API are not exposed to the network. Set to `0.0.0.0` for container / PaaS deployments. |
| `data_dir`   | string                     | — (required)             | Absolute or resolved against config file's dir                                                                                                                                                            |
| `db_path`    | string                     | `${data_dir}/gateway.db` | SQLite state file                                                                                                                                                                                         |
| `log_level`  | `debug\|info\|warn\|error` | `info`                   |                                                                                                                                                                                                           |
| `log_format` | `json\|text`               | auto (json when non-TTY) |                                                                                                                                                                                                           |

> **Deploying to Railway / Heroku / Fly / Render?** Use `port: ${PORT:-3000}`
> **and** `bind_host: "0.0.0.0"`. These platforms set `$PORT` to a platform-chosen
> value (usually 8080) and route public traffic there, but they connect to the
> container on its external interface — the default loopback bind refuses
> their health checks. Hardcoding a port or leaving `bind_host` at `127.0.0.1`
> in a PaaS will pass every internal check — `/health` from inside the
> container, startup logs, even a localhost `curl` — and return **502 Bad
> Gateway** at the edge, because the router is forwarding to the platform
> port and finding nothing listening. The gateway's own logs stay quiet: the
> requests never reach it.

### `telegram` (v1 only — see `platforms.telegram`)

| Key            | Type | Default                    | Notes                                        |
| -------------- | ---- | -------------------------- | -------------------------------------------- |
| `api_base_url` | URL  | `https://api.telegram.org` | Used for tests / self-hosted Bot API servers |

### `transport` (v1 only — see `platforms.telegram.delivery`)

| Key                             | Type                | Default       | Notes                                                                                                          |
| ------------------------------- | ------------------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| `default_mode`                  | `webhook\|polling`  | — (required)  | Per-bot `transport_override.mode` overrides                                                                    |
| `allowed_updates`               | string[]            | `["message"]` | Passed to `setWebhook`/`getUpdates`; applies to both transports                                                |
| `webhook.base_url`              | URL                 | —             | Required iff any bot uses webhook                                                                              |
| `webhook.secret`                | string (≥ 32 chars) | —             | Required iff any bot uses webhook. Schema enforces a 32-char minimum; generate with `openssl rand -base64 32`. |
| `polling.timeout_secs`          | int 1..60           | `25`          | `getUpdates` long-poll timeout                                                                                 |
| `polling.backoff_base_ms`       | int                 | `1000`        |                                                                                                                |
| `polling.backoff_cap_ms`        | int                 | `30000`       |                                                                                                                |
| `polling.max_updates_per_batch` | int 1..100          | `100`         |                                                                                                                |

### `access_control`

| Key                | Type  | Default      | Notes                         |
| ------------------ | ----- | ------------ | ----------------------------- |
| `allowed_user_ids` | int[] | — (required) | Global default-deny allowlist |

### `alerts` (optional block)

| Key           | Type   | Default                                  | Notes                               |
| ------------- | ------ | ---------------------------------------- | ----------------------------------- |
| `chat_id`     | int    | first entry of global `allowed_user_ids` | Alert recipient                     |
| `via_bot`     | bot id | first `bots[].id`                        | Delivery bot (token)                |
| `cooldown_ms` | int    | `600000`                                 | Per-(bot_id, alert_kind) rate limit |

Omit the block entirely to disable Telegram alerts (they become log-only).

### `worker_tuning`

Operational timeouts and crash-loop backoff. Defaults from §3.4 of the plan.

### `streaming`

| Key                          | Type | Default |
| ---------------------------- | ---- | ------- |
| `edit_cadence_ms`            | int  | `1500`  |
| `message_length_limit`       | int  | `4096`  |
| `message_length_safe_margin` | int  | `3800`  |

### `outbox`

| Key             | Type | Default |
| --------------- | ---- | ------- |
| `max_attempts`  | int  | `5`     |
| `retry_base_ms` | int  | `2000`  |

### `shutdown`

Shutdown first stops transport ingress, then gives accepted runner work and
the durable outbox their configured drain windows. Outbound connections remain
available through that drain and close before runners, HTTP, and SQLite.

| Key                 | Type | Default |
| ------------------- | ---- | ------- |
| `outbox_drain_secs` | int  | `10`    |
| `runner_grace_secs` | int  | `5`     |
| `hard_timeout_secs` | int  | `25`    |

### `dashboard` (optional)

| Key                               | Type   | Default      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                         | bool   | `false`      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `proxy_target`                    | URL    | —            | Required if enabled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `mount_path`                      | string | `/dashboard` | Must not conflict with any bot id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `allow_non_loopback_proxy_target` | bool   | `false`      | Default config-load rejects a non-loopback `proxy_target` (the dashboard has no auth of its own; a non-loopback target lets anyone reaching the gateway port drive requests against that upstream). Set true to opt in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `forward_full_request`            | bool   | `false`      | Default mode is GET-only with `Authorization` and `Cookie` stripped — safe for a dashboard with no auth of its own. Set true for dashboards that own their own auth: forwards all standard methods (GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD) and preserves `Authorization` + `Cookie` so the upstream can validate bearers and session cookies. `Proxy-Authorization`, `Idempotency-Key`, `X-Telegram-Bot-Api-Secret-Token`, `Host` are still stripped, and redirect-following stays disabled (`redirect: "manual"`) regardless. The operator is asserting the upstream is at least as trusted as the gateway and owns its own CSRF defenses. Combining with `allow_non_loopback_proxy_target: true` emits a load-time warning. |

### `metrics`

| Key       | Type | Default |
| --------- | ---- | ------- |
| `enabled` | bool | `false` |

When off, `/metrics` returns 404.

### `attachments`

| Key                    | Type | Default             |
| ---------------------- | ---- | ------------------- |
| `max_bytes`            | int  | `20971520` (20 MB)  |
| `max_per_turn`         | int  | `10`                |
| `retention_secs`       | int  | `86400`             |
| `disk_usage_cap_bytes` | int  | `1073741824` (1 GB) |

### `agent_api` (optional block — opt-in HTTP surface)

Bearer-authenticated `/v1/*` API that lets external processes drive bots via
`ask` (sync) and `send` (queue into Telegram chat). Full protocol in
[`agent-api.md`](agent-api.md).

```yaml
agent_api:
  enabled: true
  tokens:
    - name: ci-reviewer
      secret_ref: ${TORANA_CI_TOKEN} # env-interpolated bearer string
      bot_ids: ["reviewer"]
      scopes: ["ask", "send"]
      buzz_tools: false # opt-in Buzz CLI access for this token's ask turns
    - name: operator # `admin` opens /v1/admin/*; may accompany ask/send
      secret_ref: ${TORANA_OPERATOR_TOKEN}
      bot_ids: ["reviewer"]
      scopes: ["admin"]
    - name: buzz-provisioner # dedicated: endpoints:admin cannot be combined
      secret_ref: ${TORANA_ADMIN_TOKEN_BUZZ_PROVISION}
      bot_ids: ["assistant"] # which agents it may attach endpoints to
      scopes: ["endpoints:admin"]
  side_sessions:
    idle_ttl_ms: 3600000 # 1h
    hard_ttl_ms: 86400000 # 24h
    max_per_bot: 8
    max_global: 64
  send:
    idempotency_retention_ms: 86400000
  ask:
    default_timeout_ms: 60000
    max_timeout_ms: 300000
    max_body_bytes: 104857600 # 100 MiB
    max_files_per_request: 10
```

| Key                             | Type                | Default     | Notes                                                                                                                                                                                                                          |
| ------------------------------- | ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                       | bool                | `false`     | When `false`, only `/v1/health` is served; all other `/v1/*` routes 404                                                                                                                                                        |
| `tokens[].name`                 | string              | —           | `^[a-z][a-z0-9_-]{0,63}$`; unique within the block                                                                                                                                                                             |
| `tokens[].secret_ref`           | string (≥ 32 chars) | —           | Resolved via `${VAR}` interpolation. Schema enforces a 32-char minimum (generate with `openssl rand -base64 32`). SHA-256 hashed at load; raw value added to log redactor                                                      |
| `tokens[].bot_ids`              | string[]            | —           | Must reference configured bots (enforced by schema + doctor `C010`)                                                                                                                                                            |
| `tokens[].scopes`               | `(ask\|send)[]`     | —           | Min length 1                                                                                                                                                                                                                   |
| `tokens[].buzz_tools`           | bool                | `false`     | Grants this token's `ask` turns a session-scoped Buzz capability. Requires the target agent to set `tools.buzz.default_endpoint_id`. Carries the agent's full `tools.buzz` policy profile — see [`agent-api.md`](agent-api.md) |
| `side_sessions.idle_ttl_ms`     | int ≥ 60000         | `3600000`   | Unused-for-this-long → reap                                                                                                                                                                                                    |
| `side_sessions.hard_ttl_ms`     | int ≥ 60000         | `86400000`  | Absolute lifetime; `idle_ttl_ms ≤ hard_ttl_ms` (doctor `C013`)                                                                                                                                                                 |
| `side_sessions.max_per_bot`     | int 1..64           | `8`         |                                                                                                                                                                                                                                |
| `side_sessions.max_global`      | int 1..512          | `64`        | `max_per_bot ≤ max_global` (doctor `C013`)                                                                                                                                                                                     |
| `send.idempotency_retention_ms` | int ≥ 60000         | `86400000`  | Sweeps hourly                                                                                                                                                                                                                  |
| `ask.default_timeout_ms`        | int 1000..300000    | `60000`     | Clamped to `max_timeout_ms` on every request                                                                                                                                                                                   |
| `ask.max_timeout_ms`            | int 1000..300000    | `300000`    |                                                                                                                                                                                                                                |
| `ask.max_body_bytes`            | int ≥ 4096          | `104857600` | Multipart aggregate cap                                                                                                                                                                                                        |
| `ask.max_files_per_request`     | int 1..50           | `10`        |                                                                                                                                                                                                                                |

Pre-flight: `torana doctor` runs `C009..C014` against this block. See
[`security.md`](security.md#agent-api-auth) for the auth model and
[`agent-api.md`](agent-api.md) for endpoint-level details.

## v2-only blocks

These replace v1's `telegram`, `transport`, and `bots[]`. A v2 config separates
a **logical agent** (one id, one runner policy) from the **endpoints** where
people reach it, so one agent can own a Telegram identity and any number of
Buzz identities without duplicating its runner.

### `platforms`

Master switches and per-platform transport settings. Both a platform's switch
and an individual endpoint's `enabled` must be true before that endpoint
connects.

| Key                                     | Type               | Default                    | Notes                                                            |
| --------------------------------------- | ------------------ | -------------------------- | ---------------------------------------------------------------- |
| `telegram.enabled`                      | bool               | `true`                     | Master switch for every Telegram endpoint                        |
| `telegram.api_base_url`                 | url                | `https://api.telegram.org` | Override for a proxy or test double                              |
| `telegram.delivery.default_mode`        | `webhook\|polling` | —                          | Replaces v1 `transport.default_mode`                             |
| `telegram.delivery.allowed_updates`     | string[]           | `["message"]`              | Telegram update types to subscribe to                            |
| `telegram.delivery.webhook.base_url`    | url                | —                          | Required for webhook mode                                        |
| `telegram.delivery.webhook.secret`      | string ≥ 32        | —                          | Compared constant-time against Telegram's header                 |
| `telegram.delivery.polling.*`           | —                  | —                          | Same keys as v1 `transport.polling`                              |
| `buzz.enabled`                          | bool               | `false`                    | Master switch for every Buzz endpoint                            |
| `buzz.cli_path`                         | string             | `buzz`                     | Path to the pinned Buzz CLI                                      |
| `buzz.cli_sha256`                       | 64 hex             | pinned build's checksum    | Refuses to spawn a binary that doesn't match                     |
| `buzz.message_max_bytes`                | int                | `65536`                    | Outbound message ceiling                                         |
| `buzz.max_frame_bytes`                  | int                | `524288`                   | Relay frame ceiling                                              |
| `buzz.reconnect.base_ms` / `.cap_ms`    | int                | `1000` / `30000`           | Backoff bounds                                                   |
| `buzz.subscription.historical_limit`    | int 1..5000        | `500`                      | Events replayed per subscription on connect                      |
| `buzz.subscription.replay_overlap_secs` | int 0..86400       | `300`                      | Cursor overlap, so a gap can't silently drop events              |
| `buzz.subscription.heartbeat_secs`      | int 5..300         | `30`                       | Presence refresh cadence; the relay expires presence after 180 s |

See [`platforms/buzz.md`](platforms/buzz.md) for the Buzz endpoint controls
covered in prose earlier in this document.

### `sessions`

Which conversations share a runner context, and the caps that bound them. This
is authoritative in v2 — the deprecated `agent_api.side_sessions` block is
accepted during the bridge window but `sessions.*` wins.

| Key                                | Type               | Default            | Notes                                                      |
| ---------------------------------- | ------------------ | ------------------ | ---------------------------------------------------------- |
| `scope`                            | see below          | `conversation`     | Default isolation policy                                   |
| `idle_process_ttl_ms`              | int ≥ 60000        | `3600000` (1h)     | Unused this long → the subprocess is reaped                |
| `hard_process_ttl_ms`              | int ≥ 60000        | `86400000` (24h)   | Absolute subprocess lifetime                               |
| `context_retention_ms`             | int ≥ 60000        | `7776000000` (90d) | How long resume state is kept; independent of process TTLs |
| `max_per_agent`                    | int 1..64          | `8`                | Live sessions per agent                                    |
| `max_global`                       | int 1..512         | `32`               | Live sessions across all agents                            |
| `max_per_token_default`            | int 1..512         | `8`                | Default per-token cap; a token may override it             |
| `max_concurrent_turns_per_agent`   | int 1..64          | `2`                | Turns running at once for one agent                        |
| `max_concurrent_turns_global`      | int 1..512         | `12`               | Turns running at once overall                              |
| `max_queue_depth_per_conversation` | int ≥ 1            | `50`               | Queued turns per conversation                              |
| `max_queue_depth_per_agent`        | int ≥ 1            | `500`              | Queued turns per agent                                     |
| `overflow`                         | `queue\|reject`    | `queue`            | What happens when a depth cap is hit                       |
| `aliases[]`                        | `{name, agent_id}` | `[]`               | Declares deliberate same-agent context sharing             |

`scope` accepts `conversation` (alias `channel`), `thread`, `ephemeral`,
`legacy_agent` (v1 behaviour: one context per agent), or `alias:<name>`
referencing an entry in `aliases[]`. A conversation mailbox is serial
regardless. See [`sessions.md`](sessions.md).

### `retention`

Sweeper windows and the database ceiling. All durations are whole days unless
noted.

| Key                         | Type    | Default              | Notes                                               |
| --------------------------- | ------- | -------------------- | --------------------------------------------------- |
| `database_size_cap_bytes`   | int ≥ 1 | `4294967296` (4 GiB) | Logical ceiling; enqueue fails before it grows past |
| `inbound_payload_days`      | int ≥ 0 | `30`                 | `0` drops raw payloads immediately after processing |
| `inbound_event_days`        | int ≥ 1 | `90`                 | Dedup records                                       |
| `terminal_turn_days`        | int ≥ 1 | `90`                 | Completed and failed turns                          |
| `sent_outbox_days`          | int ≥ 1 | `14`                 | Delivered outbox rows                               |
| `dead_outbox_days`          | int ≥ 1 | `90`                 | Dead-lettered rows, kept for inspection             |
| `signed_sent_payload_hours` | int ≥ 1 | `24`                 | Signed Buzz payload bytes after successful delivery |
| `pending_mutation_days`     | int ≥ 1 | `30`                 | Unresolved edit/delete/reaction mutations           |

### `agents[]`

At least one required.

| Key           | Type             | Required | Notes                                                                                  |
| ------------- | ---------------- | -------- | -------------------------------------------------------------------------------------- |
| `id`          | string           | yes      | Regex `^[a-z][a-z0-9_-]{0,31}$`. Reserved: `health`, `metrics`, `dashboard`, `webhook` |
| `runner`      | runner block     | yes      | Identical shape to [`bots[].runner`](#botsrunner)                                      |
| `endpoints[]` | array, min 1     | yes      | Telegram and/or Buzz endpoints, discriminated on `platform`                            |
| `tools.buzz`  | Buzz tools block | no       | Grants this agent's turns a brokered Buzz capability                                   |

Endpoint ids must be globally unique, must not equal any agent id, and must not
collide with the reserved `<agent>-agent-api` endpoint Torana synthesizes for
every agent. An agent may own at most one Telegram endpoint and any number of
Buzz endpoints; a Buzz-only agent is valid and gets no Telegram identity.

### `agents[].endpoints[]` — `platform: telegram`

| Key                       | Type               | Default | Notes                                                |
| ------------------------- | ------------------ | ------- | ---------------------------------------------------- |
| `id`                      | string             | —       | Regex `^[a-z][a-z0-9_-]{0,47}$`                      |
| `platform`                | `telegram`         | —       | Discriminator                                        |
| `enabled`                 | bool               | `true`  | Per-endpoint switch                                  |
| `token`                   | string             | —       | Bot token from @BotFather                            |
| `transport_override.mode` | `webhook\|polling` | —       | Overrides `platforms.telegram.delivery.default_mode` |
| `allowed_user_ids`        | int[]              | —       | **Replaces** the global ACL for this endpoint        |
| `reactions`               | block              | —       | e.g. `received_emoji: "👀"`                          |
| `commands[]`              | array              | `[]`    | `{trigger, action}`; same shape as v1                |
| `chat_overrides`          | map                | `{}`    | Per-chat `session_scope`, keyed by chat id           |

### `agents[].endpoints[]` — `platform: buzz`

| Key                            | Type                                    | Default            | Notes                                                  |
| ------------------------------ | --------------------------------------- | ------------------ | ------------------------------------------------------ |
| `id`                           | string                                  | —                  | Regex `^[a-z][a-z0-9_-]{0,47}$`                        |
| `platform`                     | `buzz`                                  | —                  | Discriminator                                          |
| `enabled`                      | bool                                    | `false`            | Per-endpoint switch                                    |
| `community_id`                 | string                                  | —                  | Regex `^[a-z][a-z0-9_-]{0,47}$`                        |
| `relay_url`                    | ws/wss url                              | —                  | Community relay                                        |
| `private_key`                  | string                                  | —                  | 64-hex or `nsec1…`. Quote it in YAML                   |
| `auth_tag`                     | string                                  | —                  | Owner-signed NIP-OA tag, serialized JSON. **Quote it** |
| `owner_pubkey`                 | string                                  | —                  | The signing owner                                      |
| `respond_to`                   | `owner_only\|allowlist\|anyone\|nobody` | `owner_only`       | Who this endpoint answers                              |
| `allowed_pubkeys`              | string[]                                | `[]`               | Used when `respond_to: allowlist`                      |
| `subscribe`                    | `mentions_and_dms\|all_channels`        | `mentions_and_dms` | Intake breadth                                         |
| `owner_shutdown`               | `enabled\|disabled`                     | `enabled`          | Honour the owner's `!shutdown`                         |
| `triggers`                     | block                                   | all off            | Feed, workflow, and heartbeat triggers; off by default |
| `channel_overrides`            | map                                     | `{}`               | Per-channel session scope and kinds                    |
| `allow_shared_identity`        | bool                                    | `false`            | Permit two endpoints on one identity                   |
| `reactions`                    | block                                   | —                  | Received-emoji and related signals                     |
| `rerun_on_edit`                | bool                                    | `false`            | Re-run a turn when its source event is edited          |
| `include_reactions_in_context` | bool                                    | `false`            | Surface reactions to the runner                        |
| `custom_emoji_palette`         | map                                     | `{}`               | Named custom emoji                                     |

Torana derives the public key from `private_key` and refuses to start if it
doesn't match what the auth tag attests. See
[`platforms/buzz.md`](platforms/buzz.md) for how to obtain these values.

### `agents[].tools.buzz`

Grants this agent's runner a brokered Buzz capability. The runner receives a
short-lived, endpoint-scoped token — not the private key.

| Key                            | Type                                         | Default | Notes                                                        |
| ------------------------------ | -------------------------------------------- | ------- | ------------------------------------------------------------ |
| `policy`                       | `read_only\|collaborate\|maintainer\|custom` | —       | Command tier                                                 |
| `allowed_commands[]`           | string[]                                     | —       | Required for `custom`; each must be a known command path     |
| `acknowledge_dangerous`        | bool                                         | `false` | Required to allow a destructive command in `custom`          |
| `default_endpoint_id`          | string                                       | —       | Which identity the runner publishes as                       |
| `allowed_endpoint_ids[]`       | string[]                                     | —       | Bounds identity selection                                    |
| `expose_private_key_to_runner` | bool                                         | `false` | Removes broker enforcement. See [`security.md`](security.md) |

### `publishers[]`

Outbound-only service principals: no runner, no inbound subscription, no
commands, no session. Use these for notifications rather than conversation.

| Key                                    | Type       | Default | Notes                                         |
| -------------------------------------- | ---------- | ------- | --------------------------------------------- |
| `id`                                   | string     | —       | Same id rules as an agent; globally unique    |
| `enabled`                              | bool       | `false` | Separate from `publisher_api.enabled`         |
| `endpoint.id`                          | string     | —       | Endpoint id rules                             |
| `endpoint.platform`                    | `buzz`     | —       | Buzz only                                     |
| `endpoint.community_id`                | string     | —       | Regex `^[a-z][a-z0-9_-]{0,47}$`               |
| `endpoint.relay_url`                   | ws/wss url | —       | Community relay                               |
| `endpoint.private_key`                 | string     | —       | Quote in YAML                                 |
| `endpoint.auth_tag`                    | string     | —       | Owner-signed NIP-OA tag. Quote in YAML        |
| `endpoint.owner_pubkey`                | string     | —       | The signing owner                             |
| `endpoint.expected_pubkey`             | 64 hex     | —       | Must equal the key derived from `private_key` |
| `destination.external_conversation_id` | uuid       | —       | The one channel this publisher may post to    |

The destination is fixed in config on purpose: a publish request cannot select
an endpoint, identity, relay, or channel.

### `publisher_api`

The HTTP surface publishers are driven through.

| Key                                | Type              | Default               | Notes                                           |
| ---------------------------------- | ----------------- | --------------------- | ----------------------------------------------- |
| `enabled`                          | bool              | `false`               | Separate from each publisher's own switch       |
| `max_body_bytes`                   | int 4096..1048576 | `73728`               | Request ceiling                                 |
| `max_content_bytes`                | int 1..1048576    | `65536`               | Message content ceiling                         |
| `idempotency_retention_ms`         | int ≥ 60000       | `1209600000` (14d)    | Keep longer than any caller's retry budget      |
| `max_pending_per_publisher`        | int ≥ 1           | `500`                 | New requests get a retriable 503 past this      |
| `max_retained_per_publisher`       | int ≥ 1           | `2000`                | Rows retained across all statuses               |
| `max_retained_bytes_per_publisher` | int ≥ 4096        | `268435456` (256 MiB) | Payload + signed-payload bytes                  |
| `rate_per_minute_per_publisher`    | int 1..100000     | `60`                  | Sustained rate                                  |
| `burst_per_publisher`              | int 1..10000      | `10`                  | Burst allowance                                 |
| `tokens[]`                         | array             | `[]`                  | `{name, secret_ref, publisher_ids[], scopes[]}` |

Token scopes are `publish` and `status`. See
[`publisher-api.md`](publisher-api.md).

## v1-only blocks

Still fully supported. `telegram` and `transport` (documented above) belong to
this group as well; in v2 their settings live under `platforms.telegram`.

### `bots[]`

| Key                               | Type                                            | Required | Notes                                                                                  |
| --------------------------------- | ----------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `id`                              | string                                          | yes      | Regex `^[a-z][a-z0-9_-]{0,31}$`. Reserved: `health`, `metrics`, `dashboard`, `webhook` |
| `token`                           | string                                          | yes      | Non-empty after interpolation                                                          |
| `transport_override.mode`         | `webhook\|polling`                              | no       | Overrides global `default_mode`                                                        |
| `access_control.allowed_user_ids` | int[]                                           | no       | **Replaces** global list for this bot                                                  |
| `commands[].trigger`              | string                                          | yes      | Must start with `/`                                                                    |
| `commands[].action`               | `builtin:reset\|builtin:status\|builtin:health` | yes      |                                                                                        |
| `reactions.received_emoji`        | string \| null                                  | no       | `null` disables received-ack reaction; default `"👀"`                                  |
| `runner`                          | object                                          | yes      | Discriminated on `type`                                                                |

### `bots[].runner`

Type is one of `claude-code`, `codex`, or `command`. See [`runners.md`](runners.md).

#### claude-code

| Key                     | Default                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `cli_path`              | `claude`                                                                  |
| `args`                  | `[]` — appended to protocol-required flags (see below)                    |
| `cwd`                   | gateway cwd                                                               |
| `env`                   | `{}`                                                                      |
| `pass_continue_flag`    | `true`                                                                    |
| `acknowledge_dangerous` | `false` — **must be set to `true`** (schema rejects the config otherwise) |

The runner always passes these protocol-required flags to the CLI, in this order, before your `args`: `--print --output-format stream-json --input-format stream-json --include-partial-messages --replay-user-messages --verbose --dangerously-skip-permissions`. Your `args` are appended. `--continue` is then appended when `pass_continue_flag: true` and the session isn't fresh. Typical user `args`: `["--agent", "assistant"]`.

> **Why `acknowledge_dangerous` is required.** The claude-code runner always
> passes `--dangerously-skip-permissions` (the CLI's interactive permission
> prompt does not compose with torana's NDJSON protocol, so it has to be off).
> Every turn therefore runs without the CLI's per-tool guardrails and inherits
> host-level file + command access in the runner's `cwd`. Treat a claude-code
> bot the same way you would a Codex bot in `approval_mode: yolo`: only run
> it inside a container, VM, or otherwise hardened environment where the
> blast radius is bounded. Setting `acknowledge_dangerous: true` is the
> operator's confirmation that this has been accounted for. **It does not
> change any runtime behavior** — the flag is a documentation gate at config
> load, not enforcement at run time. See
> [docs/security.md#runner-isolation](security.md#runner-isolation) for the
> isolation patterns the operator is expected to provide.

#### codex

| Key                     | Default                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `cli_path`              | `codex`                                                                          |
| `args`                  | `[]` — user extras appended to the runner-built argv (e.g. `["--profile", "x"]`) |
| `cwd`                   | gateway cwd                                                                      |
| `env`                   | `{}`                                                                             |
| `pass_resume_flag`      | `true` — capture `thread_id` and resume on subsequent turns                      |
| `approval_mode`         | `full-auto` (one of `untrusted`, `on-request`, `never`, `full-auto`, `yolo`)     |
| `sandbox`               | `workspace-write` (one of `read-only`, `workspace-write`, `danger-full-access`)  |
| `model`                 | (optional `--model` override)                                                    |
| `acknowledge_dangerous` | `false` — required to be `true` if `approval_mode: yolo`                         |

The runner always invokes `codex exec [resume <thread_id>] --json --skip-git-repo-check …`. The `exec` subcommand, `--json`, and `--skip-git-repo-check` are protocol-required and not user-configurable. Approval/sandbox flags are derived from `approval_mode` and `sandbox`. The user prompt is piped on stdin (the runner appends `-` as the prompt argument). Image attachments are passed as repeated `--image <path>`; non-image attachments are skipped with a warning. On resume turns, `--sandbox` is omitted (Codex inherits sandbox from the original session and `exec resume` rejects the flag).

#### command

| Key        | Default                                                     |
| ---------- | ----------------------------------------------------------- |
| `cmd`      | (required; argv)                                            |
| `protocol` | (required: `jsonl-text`, `claude-ndjson`, or `codex-jsonl`) |
| `cwd`      | gateway cwd                                                 |
| `env`      | `{}`                                                        |
| `on_reset` | `signal`                                                    |

## Strict mode

Unknown keys at any nesting level produce a precise error (`bots[0].runnr: Unrecognized key`). Keep your config tidy.

## Buzz endpoint provisioning

Buzz endpoints normally live in this file. They can also be created at runtime
through `PUT /v1/admin/buzz/endpoints/<id>`, which is how a Buzz Desktop
provider deploys an agent onto Torana. A provisioned endpoint is stored in the
gateway database on the data volume and is otherwise identical to a YAML one:
it is re-validated through the same schema on every load, so identity checks,
auth-tag authorization, globally unique endpoint ids, and the shared-identity
rules apply unchanged.

Three things make it safe to expose:

- **`TORANA_PROVISIONING_SECRETS_KEY` (required to provision).** 32 bytes as 64
  hex characters or base64 — `openssl rand -hex 32`. Each row's private key and
  auth tag are sealed with AES-256-GCM under this key, bound to the endpoint id,
  so a ciphertext cannot be moved between rows. The key is deliberately not in
  the database: a restored or copied volume without it yields rows that cannot
  be opened, and startup fails closed rather than running an endpoint nobody can
  account for. **Back up the key separately from the volume — a restore without
  it cannot recover those agent identities.** Doctor check `C029` reports
  whether every stored row decrypts with the configured key.
- **A dedicated token.** The routes require the `endpoints:admin` scope, and
  config validation rejects a token that combines it with `ask` or `send`. The
  token's `bot_ids` still bound which agents it may attach endpoints to.
- **Agent binding.** Every deploy names an `agent_id` that already exists in
  this file with a runner. Provisioning creates _endpoints_, never agents or
  runners, so an identity with no agent to bind to — an outbound-only publisher,
  for instance — is refused rather than half-created.

Precedence, which matters because `torana.yaml` is baked into a deploy image
while provisioned rows live on the volume:

1. **A YAML endpoint always wins.** A deploy whose endpoint id _or_ whose
   derived pubkey collides with a YAML-declared endpoint is rejected with
   "managed by static config".
2. **Provisioned endpoints survive redeploys untouched.** They are never
   regenerated from image state.
3. **Migrating an agent from YAML to provisioned is an explicit operator
   sequence** — remove the endpoint block, redeploy, then provider-deploy. It
   never happens automatically.

`torana endpoints status` shows `yaml` or `provisioned` per endpoint.
