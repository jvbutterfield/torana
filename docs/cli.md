# CLI reference

The `torana` binary has two surfaces:

- **Gateway** — `start`, `doctor`, `validate`, `migrate`, `version`. Operate
  on a local `torana.yaml` and (for some) a local SQLite DB.
- **Agent-API client** — `ask`, `inject`, `turns get`, `bots list`. Operate
  on a **running gateway** over HTTP; need `--server` + `--token` (or the
  env equivalents).

This doc is exhaustive. For higher-level architecture see
[`agent-api.md`](agent-api.md).

---

## Global conventions

- **Flag forms.** Every long flag accepts both `--name VALUE` and
  `--name=VALUE`. Short aliases (`-c`, `-h`) exist for a subset.
- **Config resolution.** Gateway commands need a config path. Precedence:
  `--config PATH` → `$TORANA_CONFIG` → `./torana.yaml` → `./torana.config.yaml`.
- **Credential resolution (agent-api commands).** `--server`/`--token` flags
  override `$TORANA_SERVER`/`$TORANA_TOKEN` env vars. Both sources must
  yield a value — there's no "default localhost" behavior.
- **Debug.** `TORANA_DEBUG=1` or `--verbose` prints the credential
  resolution trace on stderr.
- **Help.** `--help` / `-h` on any subcommand short-circuits before any
  credential check or network call.

---

## Exit codes (agent-api commands)

Stable across commands. Skill packages and monitoring scripts rely on them.

| Code | Meaning | Typical cause |
|---|---|---|
| `0` | Success | 2xx response |
| `1` | Unspecified / internal | Malformed server response, unknown failure |
| `2` | Bad usage | 4xx other than auth/not-found/capacity; flag-parse error |
| `3` | Authentication failed | 401, 403 (`invalid_token`, `bot_not_permitted`, `scope_not_permitted`, `target_not_authorized`) |
| `4` | Not found | 404, 410 (`turn_not_found`, `session_not_found`, `turn_result_expired`) |
| `5` | Server / runner error | 5xx, transport errors |
| `6` | Timeout | Ask returned 202 — the `turn_id` is printed for polling |
| `7` | Capacity / busy | 429 (`side_session_capacity`, `side_session_busy`) |

---

## Gateway commands

### `torana start`

Run the gateway.

```
torana start [--config PATH] [--auto-migrate]
```

- `--config PATH` — path to `torana.yaml`. See resolution above.
- `--auto-migrate` — apply pending DB migrations automatically on startup.
  Without this flag, the gateway refuses to start if migrations are pending.

Exits 0 on clean SIGTERM/SIGINT; 1 on any startup failure.

### `torana doctor`

Pre-flight checks against a local config OR a remote gateway.

**Local mode (default).**

```
torana doctor [--config PATH] [--format text|json]
```

Runs `C001..C014`:

| ID | Severity | What |
|---|---|---|
| C001 | ok | Config schema validates |
| C002 | fail | `gateway.data_dir` exists, is a directory |
| C003 | fail | DB schema matches current version |
| C004 | fail | Per-bot `getMe` against Telegram succeeds |
| C005 | fail | Runner entry binary resolvable in `PATH` |
| C006 | skip/fail | Webhook `base_url` reachable (HEAD, any non-5xx) — skipped if no bot uses webhook |
| C007 | fail | Config file mode is not world-readable (POSIX only) |
| C008 | fail | `alerts.via_bot` resolves to a configured bot |
| C009 | warn | `agent_api.enabled=true` but `tokens: []` |
| C010 | fail | Agent-API token references an unknown `bot_id` |
| C011 | fail | Ask-scope token on a runner without side-session support |
| C012 | fail | Agent-API token's `secret_ref` is empty after interpolation |
| C013 | fail | `idle_ttl_ms > hard_ttl_ms`, `max_per_bot > max_global`, or `default_timeout_ms > max_timeout_ms` |
| C014 | warn | Reminder about TLS / firewall / reverse-proxy posture when agent-api is enabled |

**Remote mode.**

```
torana doctor --server URL --token TOK [--format text|json]
# or: TORANA_SERVER=… TORANA_TOKEN=… torana doctor
```

Runs `R001..R003` against the remote gateway:

| ID | Severity | What |
|---|---|---|
| R001 | fail | `GET /v1/health` returns 200 within 2s |
| R002 | fail/warn | `GET /v1/bots` returns 200 with a non-empty list |
| R003 | fail/skip | TLS chain validates (skipped on `http://`) |

`--profile NAME` is reserved for the profile store landing in Phase 6b;
until then the CLI exits 2 with an explanatory message.

Exits 1 if any check is `fail`; warnings don't fail the run.

### `torana validate`

Offline schema check — no Telegram, no DB.

```
torana validate [--config PATH]
```

Prints the redacted resolved config as JSON on success.

### `torana migrate`

Apply or preview pending DB migrations.

```
torana migrate [--config PATH] [--dry-run]
```

`--dry-run` prints the planned SQL as JSON without touching the DB.

### `torana version`

Print package version + Bun runtime.

---

## Agent-API client commands

All four require credentials. Prefer env vars for production:

```
export TORANA_SERVER=https://gateway.example.com
export TORANA_TOKEN=<bearer-token>
```

### `torana ask`

Synchronous prompt.

```
torana ask [options] <bot_id> <text>
```

Options:

| Flag | Meaning |
|---|---|
| `--server URL` | Gateway URL. Env: `TORANA_SERVER`. |
| `--token TOK` | Bearer token. Env: `TORANA_TOKEN`. |
| `--session-id ID` | Reuse a keyed side-session (`^[A-Za-z0-9_-]{1,64}$`). Omit for ephemeral. |
| `--timeout-ms N` | Clamp to `[1000, ask.max_timeout_ms]`. Default 60000. |
| `--file PATH` | Attach a file. Repeatable. |
| `--json` | JSON output instead of human text. |
| `-h, --help` | Print help. |

On 200: prints the reply text on stdout, then a separator line with usage.
On 202 (ask didn't complete in `timeout_ms`): prints the `turn_id` on
stdout and exits **6** (timeout). Poll with `torana turns get $id`:

```
id=$(torana ask reviewer "long-running task") && torana turns get "$id"
```

### `torana inject`

Push a message into a user's chat.

```
torana inject [options] --source LABEL <bot_id> <text>
```

Options:

| Flag | Meaning |
|---|---|
| `--server URL` / `--token TOK` | Credentials (as above). |
| `--user-id ID` | Telegram user id to inject into. Either this or `--chat-id` required. |
| `--chat-id ID` | Alternative target (must already be associated with the bot). |
| `--source LABEL` | Lowercase `[a-z0-9_-]{1,64}` — required. Appears in the `[system-injected from "<label>"]` marker. |
| `--idempotency-key K` | Explicit key. If omitted, one is auto-generated and printed as a `#`-prefixed comment on stderr so you can reuse it on retry. |
| `--file PATH` | Attach a file. Repeatable. |
| `--json` | JSON output instead of human text. |
| `-h, --help` | Print help. |

Always returns 202; use `torana turns get <id>` for delivery status.

### `torana turns get`

Fetch the state of a turn.

```
torana turns get [options] <turn_id>
```

Returns the turn's current status (`in_progress`, `done`, `failed`) plus the
final text / error text / duration / usage as appropriate. Exits `4` on
`turn_not_found` or `turn_result_expired`.

### `torana bots list`

List bots the token is authorized for.

```
torana bots list [options]
```

Prints a table (or JSON with `--json`) of `bot_id`, `runner_type`,
`supports_side_sessions`.

---

## Environment variables

| Var | Used by | Meaning |
|---|---|---|
| `TORANA_CONFIG` | Gateway commands | Default path to `torana.yaml` |
| `TORANA_SERVER` | Agent-API commands | Gateway URL |
| `TORANA_TOKEN` | Agent-API commands | Bearer token |
| `TORANA_DEBUG` | All | `1` enables credential-resolution trace on stderr |

---

## See also

- [`configuration.md`](configuration.md) — `torana.yaml` reference.
- [`agent-api.md`](agent-api.md) — protocol-level details, rate-limits,
  metrics.
- [`security.md`](security.md) — threat model.
- [`operations.md`](operations.md) — logs, metrics, health endpoints.
