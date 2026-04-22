# Configuration reference

All configuration lives in a single YAML file (default `./torana.yaml`). The schema is validated with [Zod](https://zod.dev); errors point at the exact bad path.

> **Version key.** Every config must start with `version: 1`. Future breaking schema changes bump the version. Anything other than `1` is rejected at load time.

## Env interpolation

Any string value supports `${VAR}` and `${VAR:-default}` substitution:

```yaml
bots:
  - id: cato
    token: ${TELEGRAM_BOT_TOKEN_CATO}           # required env var
    reactions:
      received_emoji: ${ACK_EMOJI:-👀}          # with default
```

A missing `${VAR}` (no default) is a fatal load error. Numeric fields use `z.coerce.number()`, so `allowed_user_ids: [${MY_ID}]` works naturally.

## Env inheritance to runner subprocesses

`runner.env` is the **complete** environment passed to the subprocess. Parent-process env is **not** inherited by default — except `PATH`, which is inherited unless explicitly set.

To inherit a specific var, reference it via `${VAR}`. To disable PATH inheritance, set `PATH: ""` explicitly. Rationale: explicit > implicit, and avoids the classic "works locally, breaks in prod because PATH differs" footgun.

## Config resolution order

1. `--config <path>` CLI flag
2. `$TORANA_CONFIG` env var
3. `./torana.yaml` in cwd
4. `./torana.config.yaml` in cwd

## Full reference

### `version`
`1` (required). Schema version.

### `gateway`
| Key | Type | Default | Notes |
|---|---|---|---|
| `port` | int | `3000` | HTTP listen port. On PaaS (Railway/Heroku/Fly/Render) use `${PORT:-3000}` — see note below |
| `data_dir` | string | — (required) | Absolute or resolved against config file's dir |
| `db_path` | string | `${data_dir}/gateway.db` | SQLite state file |
| `log_level` | `debug\|info\|warn\|error` | `info` | |
| `log_format` | `json\|text` | auto (json when non-TTY) | |

> **Deploying to Railway / Heroku / Fly / Render?** Use `port: ${PORT:-3000}`.
> These platforms set `$PORT` to a platform-chosen value (usually 8080) and
> route public traffic there. Hardcoding a port will pass every internal
> check — `/health` from inside the container, startup logs, even a
> localhost `curl` — and return **502 Bad Gateway** at the edge, because the
> router is forwarding to the platform port and finding nothing listening.
> The gateway's own logs stay quiet: the requests never reach it.

### `telegram`
| Key | Type | Default | Notes |
|---|---|---|---|
| `api_base_url` | URL | `https://api.telegram.org` | Used for tests / self-hosted Bot API servers |

### `transport`
| Key | Type | Default | Notes |
|---|---|---|---|
| `default_mode` | `webhook\|polling` | — (required) | Per-bot `transport_override.mode` overrides |
| `allowed_updates` | string[] | `["message"]` | Passed to `setWebhook`/`getUpdates`; applies to both transports |
| `webhook.base_url` | URL | — | Required iff any bot uses webhook |
| `webhook.secret` | string (non-empty) | — | Required iff any bot uses webhook |
| `polling.timeout_secs` | int 1..60 | `25` | `getUpdates` long-poll timeout |
| `polling.backoff_base_ms` | int | `1000` | |
| `polling.backoff_cap_ms` | int | `30000` | |
| `polling.max_updates_per_batch` | int 1..100 | `100` | |

### `access_control`
| Key | Type | Default | Notes |
|---|---|---|---|
| `allowed_user_ids` | int[] | — (required) | Global default-deny allowlist |

### `alerts` (optional block)
| Key | Type | Default | Notes |
|---|---|---|---|
| `chat_id` | int | first entry of global `allowed_user_ids` | Alert recipient |
| `via_bot` | bot id | first `bots[].id` | Delivery bot (token) |
| `cooldown_ms` | int | `600000` | Per-(bot_id, alert_kind) rate limit |

Omit the block entirely to disable Telegram alerts (they become log-only).

### `worker_tuning`
Operational timeouts and crash-loop backoff. Defaults from §3.4 of the plan.

### `streaming`
| Key | Type | Default |
|---|---|---|
| `edit_cadence_ms` | int | `1500` |
| `message_length_limit` | int | `4096` |
| `message_length_safe_margin` | int | `3800` |

### `outbox`
| Key | Type | Default |
|---|---|---|
| `max_attempts` | int | `5` |
| `retry_base_ms` | int | `2000` |

### `shutdown`
| Key | Type | Default |
|---|---|---|
| `outbox_drain_secs` | int | `10` |
| `runner_grace_secs` | int | `5` |
| `hard_timeout_secs` | int | `25` |

### `dashboard` (optional)
| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | bool | `false` | |
| `proxy_target` | URL | — | Required if enabled |
| `mount_path` | string | `/dashboard` | Must not conflict with any bot id |

### `metrics`
| Key | Type | Default |
|---|---|---|
| `enabled` | bool | `false` |

When off, `/metrics` returns 404.

### `attachments`
| Key | Type | Default |
|---|---|---|
| `max_bytes` | int | `20971520` (20 MB) |
| `max_per_turn` | int | `10` |
| `retention_secs` | int | `86400` |
| `disk_usage_cap_bytes` | int | `1073741824` (1 GB) |

### `agent_api` (optional block — opt-in HTTP surface)

Bearer-authenticated `/v1/*` API that lets external processes drive bots via
`ask` (sync) and `send` (queue into Telegram chat). Full protocol in
[`agent-api.md`](agent-api.md).

```yaml
agent_api:
  enabled: true
  tokens:
    - name: ci-reviewer
      secret_ref: ${TORANA_CI_TOKEN}       # env-interpolated bearer string
      bot_ids: ["reviewer"]
      scopes: ["ask", "send"]
  side_sessions:
    idle_ttl_ms: 3600000        # 1h
    hard_ttl_ms: 86400000       # 24h
    max_per_bot: 8
    max_global: 64
  send:
    idempotency_retention_ms: 86400000
  ask:
    default_timeout_ms: 60000
    max_timeout_ms: 300000
    max_body_bytes: 104857600   # 100 MiB
    max_files_per_request: 10
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | bool | `false` | When `false`, only `/v1/health` is served; all other `/v1/*` routes 404 |
| `tokens[].name` | string | — | `^[a-z][a-z0-9_-]{0,63}$`; unique within the block |
| `tokens[].secret_ref` | string | — | Non-empty after interpolation. SHA-256 hashed at load; raw value added to log redactor |
| `tokens[].bot_ids` | string[] | — | Must reference configured bots (enforced by schema + doctor `C010`) |
| `tokens[].scopes` | `(ask\|send)[]` | — | Min length 1 |
| `side_sessions.idle_ttl_ms` | int ≥ 60000 | `3600000` | Unused-for-this-long → reap |
| `side_sessions.hard_ttl_ms` | int ≥ 60000 | `86400000` | Absolute lifetime; `idle_ttl_ms ≤ hard_ttl_ms` (doctor `C013`) |
| `side_sessions.max_per_bot` | int 1..64 | `8` | |
| `side_sessions.max_global` | int 1..512 | `64` | `max_per_bot ≤ max_global` (doctor `C013`) |
| `send.idempotency_retention_ms` | int ≥ 60000 | `86400000` | Sweeps hourly |
| `ask.default_timeout_ms` | int 1000..300000 | `60000` | Clamped to `max_timeout_ms` on every request |
| `ask.max_timeout_ms` | int 1000..300000 | `300000` | |
| `ask.max_body_bytes` | int ≥ 4096 | `104857600` | Multipart aggregate cap |
| `ask.max_files_per_request` | int 1..50 | `10` | |

Pre-flight: `torana doctor` runs `C009..C014` against this block. See
[`security.md`](security.md#agent-api-auth) for the auth model and
[`agent-api.md`](agent-api.md) for endpoint-level details.

### `bots[]`
| Key | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Regex `^[a-z][a-z0-9_-]{0,31}$`. Reserved: `health`, `metrics`, `dashboard`, `webhook` |
| `token` | string | yes | Non-empty after interpolation |
| `transport_override.mode` | `webhook\|polling` | no | Overrides global `default_mode` |
| `access_control.allowed_user_ids` | int[] | no | **Replaces** global list for this bot |
| `commands[].trigger` | string | yes | Must start with `/` |
| `commands[].action` | `builtin:reset\|builtin:status\|builtin:health` | yes | |
| `reactions.received_emoji` | string \| null | no | `null` disables received-ack reaction; default `"👀"` |
| `runner` | object | yes | Discriminated on `type` |

### `bots[].runner`
Type is one of `claude-code`, `codex`, or `command`. See [`runners.md`](runners.md).

#### claude-code
| Key | Default |
|---|---|
| `cli_path` | `claude` |
| `args` | `[]` — appended to protocol-required flags (see below) |
| `cwd` | gateway cwd |
| `env` | `{}` |
| `pass_continue_flag` | `true` |

The runner always passes these protocol-required flags to the CLI, in this order, before your `args`: `--print --output-format stream-json --input-format stream-json --include-partial-messages --replay-user-messages --verbose --dangerously-skip-permissions`. Your `args` are appended. `--continue` is then appended when `pass_continue_flag: true` and the session isn't fresh. Typical user `args`: `["--agent", "cato"]`.

#### codex
| Key | Default |
|---|---|
| `cli_path` | `codex` |
| `args` | `[]` — user extras appended to the runner-built argv (e.g. `["--profile", "x"]`) |
| `cwd` | gateway cwd |
| `env` | `{}` |
| `pass_resume_flag` | `true` — capture `thread_id` and resume on subsequent turns |
| `approval_mode` | `full-auto` (one of `untrusted`, `on-request`, `never`, `full-auto`, `yolo`) |
| `sandbox` | `workspace-write` (one of `read-only`, `workspace-write`, `danger-full-access`) |
| `model` | (optional `--model` override) |
| `acknowledge_dangerous` | `false` — required to be `true` if `approval_mode: yolo` |

The runner always invokes `codex exec [resume <thread_id>] --json --skip-git-repo-check …`. The `exec` subcommand, `--json`, and `--skip-git-repo-check` are protocol-required and not user-configurable. Approval/sandbox flags are derived from `approval_mode` and `sandbox`. The user prompt is piped on stdin (the runner appends `-` as the prompt argument). Image attachments are passed as repeated `--image <path>`; non-image attachments are skipped with a warning. On resume turns, `--sandbox` is omitted (Codex inherits sandbox from the original session and `exec resume` rejects the flag).

#### command
| Key | Default |
|---|---|
| `cmd` | (required; argv) |
| `protocol` | (required: `jsonl-text`, `claude-ndjson`, or `codex-jsonl`) |
| `cwd` | gateway cwd |
| `env` | `{}` |
| `on_reset` | `signal` |

## Strict mode

Unknown keys at any nesting level produce a precise error (`bots[0].runnr: Unrecognized key`). Keep your config tidy.
