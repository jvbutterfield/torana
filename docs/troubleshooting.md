# Troubleshooting

Symptoms, likely causes, and the check that confirms it. Run
`torana doctor --config torana.yaml` first — most problems below have a doctor
check that names them directly, and it is cheaper than reading logs.

## Start here

```sh
torana validate --config torana.yaml   # schema only: no network, no database
torana doctor   --config torana.yaml   # + Telegram, runner binaries, DB, permissions
```

`validate` failing means the config is wrong on its face. `doctor` failing
means the config is well-formed but the environment disagrees with it.

Logs are JSON on stdout (text when attached to a TTY). Per-bot runner output —
including the subprocess's own stderr — is at
`<data_dir>/logs/<bot_id>.log`. Secrets are redacted in both.

---

## The gateway won't start

**`config validation failed: …`**
Schema rejection. The message carries the failing path, e.g.
`agents[0].endpoints[0].auth_tag`. Every key is documented in
[`configuration.md`](configuration.md); unknown keys are rejected on purpose
(strict mode), so a typo'd key reads as "unrecognized key" rather than being
silently ignored.

**`${VAR}` appears literally, or an empty-secret error**
Env interpolation happens at load. A missing variable is fatal rather than
silently empty — see [env interpolation](configuration.md#env-interpolation).
Bun auto-loads `.env` from the working directory, so a variable exported in a
different shell than the one running Torana is a common cause.

**`data directory is locked` / another process holds the lock**
Torana is a single writer per `data_dir`. A previous process may still be
running or may have died without releasing the lock. `torana gateway drain`
validates the recorded PID and shuts the owner down cleanly. Doctor check
**C016** reports the lock state.

**`database is locked` on open**
Another writer — often a `sqlite3` session left open, or a second Torana on the
same volume. Stop it. Torana must be the only writer.

**Schema version mismatch**
`torana migrate --dry-run` shows what would be applied; `torana migrate` applies
it. Doctor check **C003** reports the current and expected version. Migrations
snapshot the database before altering it; see
[migrations](operations.md#migrations).

---

## Doctor fails

| Check    | Means                                                  | Fix                                                                               |
| -------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| **C002** | `data_dir` missing or not writable                     | Create it, or fix ownership. Torana does not create parent directories.           |
| **C003** | DB schema older than the binary expects                | `torana migrate`                                                                  |
| **C004** | Telegram `getMe` failed                                | Bad or revoked bot token. Reports `skip` for Buzz-only agents, which is normal.   |
| **C005** | Runner entry point not executable / not on `PATH`      | Install the `claude` or `codex` CLI, or fix `runner.cmd`. See below.              |
| **C006** | Webhook `base_url` unreachable                         | DNS, TLS, or firewall. Any non-5xx counts as reachable.                           |
| **C007** | Config file is world-readable                          | `chmod 600 torana.yaml`. Warns; does not block startup.                           |
| **C015** | Database file is world-readable                        | `chmod 600` the DB. It contains every bot token.                                  |
| **C016** | Data-directory lock is held or unverifiable            | See "data directory is locked" above.                                             |
| **C027** | `shutdown.hard_timeout_secs` is below the drain budget | Raise it above `outbox_drain_secs + runner_grace_secs`.                           |
| **C029** | Provisioned Buzz rows can't be decrypted               | `TORANA_PROVISIONING_SECRETS_KEY` is missing or wrong. **Restore the key** — the  |
|          |                                                        | rows are unrecoverable without it. A `warn` instead means a rotation is mid-way.  |
| **C030** | An allowlisted harness binary doesn't resolve          | Fix `provisioning.harnesses.<name>.runner.cli_path`, or install the binary.       |
| **C031** | A managed agent's harness or workspace is gone         | The harness was removed from the allowlist, or the volume lost `workspaces/`.     |
| **C032** | A tombstone cursor is ahead of the local clock         | Warns only. A future cursor narrows backfill; check for host clock skew.          |
| **C033** | Staged deletions are pending                           | Warns, with each deadline. `torana agents restore <id>` while the window is open. |

Agent-API specific: **C009** (enabled with no tokens), **C010** (token names an
unknown bot), **C011** (`ask` scope on a runner without side-session support),
**C012** (`secret_ref` resolves to empty), **C013** (TTL/cap invariants),
**C014** (deployment reminder that bearer tokens are the only auth).

---

## The bot doesn't answer

**Nothing at all, no log line for your message**
The ACL rejected it. Default policy is deny, and rejected updates return HTTP
200 with no reaction on purpose — an attacker gets no signal. Confirm your
Telegram user id is in `access_control.allowed_user_ids`. An **empty** list
denies everyone and logs a loud warning at startup.

**Polling: nothing arrives**
Another process is polling the same bot token. Telegram delivers each update
once, to one long-poll. Stop the other consumer — a second Torana, a local dev
instance, or a webhook still registered for that token.

**Webhook: Telegram reports a URL you didn't set**
Torana warns about a stale webhook at startup. Re-register by restarting with
the correct `transport.webhook.base_url`, or clear it in the Bot API.

**Webhook: 403 on every delivery**
`X-Telegram-Bot-Api-Secret-Token` didn't match `transport.webhook.secret`. The
comparison is constant-time and exact.

**It answers, then goes silent after a while**
Check `<data_dir>/logs/<bot_id>.log` for a runner `fatal`. A crashed runner
surfaces as `fatal{code:"exit"}` and the in-flight turn is errored. `GET /health`
reports per-bot readiness, mailbox depth, and last turn time.

**Replies are truncated or split oddly**
Expected. Telegram caps messages at 4096 characters and rate-limits edits;
Torana splits with a safe margin and streams at
`streaming.edit_interval_ms`. Nothing is dropped.

---

## Runner problems

**`spawn failed` / command not found**
`runner.env` is the **complete** environment — the parent process's variables
are not inherited, except `PATH`. A CLI that works in your shell can fail here
because `HOME`, `PATH`, or its credential variable never reached it. Pass what
it needs explicitly:

```yaml
env:
  HOME: ${HOME} # OAuth-authenticated CLIs read credentials from here
  PATH: ${PATH}
  CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}
```

See [env inheritance](configuration.md#env-inheritance-to-runner-subprocesses).

**The runner starts but never becomes ready**
A `command` runner must emit `{"type":"ready"}` on stdout at startup. Until it
does, the bot is not ready and turns are queued. See
[writing-a-runner](writing-a-runner.md).

**`RunnerDoesNotSupportSideSessions`**
The Agent API `ask` mode needs side-sessions. `jsonl-text` has no session
semantics — use `claude-ndjson` or `codex-jsonl`, or drop to `send`. Doctor
**C011** catches this at config time.

**Reset does nothing**
`on_reset: signal` is only meaningful for `jsonl-text`. For the other protocols
use `on_reset: restart`; Torana logs a warning if you don't.

---

## Agent API

Every error is a JSON body with a stable `error` code.

| Code                                           | Cause                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `missing_auth` / `invalid_token`               | No or unknown bearer token.                                                                 |
| `bot_not_permitted`                            | The token's `bot_ids` doesn't include this bot. Same shape as an unknown bot, deliberately. |
| `scope_not_permitted`                          | Wrong scope. `/v1/admin/*` needs `admin`; provisioning needs `endpoints:admin`.             |
| `target_not_authorized` / `chat_not_permitted` | `send` re-checks the resolved user against the bot's ACL. Tokens authorize bots, not users. |
| `side_session_busy`                            | That session has a turn in flight. Retry, or use a different `session_id`.                  |
| `side_session_capacity`                        | Per-bot or global pool cap reached. Raise `sessions.max_per_agent` / `max_global`.          |
| `token_concurrency_limit`                      | This token's `max_concurrent_side_sessions` cap. Raise it or reduce parallelism.            |
| `missing_idempotency_key`                      | `send` requires one.                                                                        |
| `invalid_idempotency_key`                      | Must match the documented format; see [agent-api](agent-api.md).                            |
| `attachment_mime_not_allowed`                  | The declared MIME didn't match the file's magic bytes, or isn't allowlisted.                |
| `gateway_shutting_down`                        | Drain in progress. Retry against the new instance.                                          |

`turn_not_found` is returned for every lookup failure — nonexistent,
cross-caller, or Telegram-origin — so turns cannot be enumerated.

Probe a running gateway from the caller's side with
`torana doctor --server URL --token TOK` (checks **R001..R003**).

---

## Buzz

**The endpoint never connects**
Both switches must be true: `platforms.buzz.enabled` and the endpoint's own
`enabled`. Either one false means no connection, by design.

**`403 relay_membership_required`**
The identity reached the relay but has no valid owner attestation. The
`auth_tag` must be signed by `owner_pubkey`, be for this endpoint's public key,
and permit kind 9. See
[getting Buzz credentials](platforms/buzz.md#getting-buzz-credentials).

**`auth tag must be a strict lowercase NIP-OA auth tag`**
Malformed tag. Mint one with `torana buzz auth-tag`. Quote the value in YAML —
it is serialized JSON.

**The agent is connected but ignores stream messages**
Stream prompts require an exact mention of the endpoint by default, and
`respond_to` defaults to `owner_only`. Both are deliberate; widen with
`respond_to: allowlist` plus `allowed_pubkeys`, or `anyone`.

**It shows offline in Buzz clients**
Presence expires 180 s after the last accepted publish. A run of failed
refreshes marks the endpoint `presence_stale`. Check connectivity and
`torana endpoints status`.

**It stopped and won't restart**
An owner `!shutdown` disables an endpoint durably. `torana endpoints resume`
brings it back, as does a fresh provider deploy. Opt out with
`owner_shutdown: disabled`.

---

## Desktop-managed agents

**A deploy is refused with `not_configured`**
The gateway has no `provisioning:` block, so it can attach endpoints to agents
you declared but cannot create new ones. See
[configuration](configuration.md#provisioning).

**A deploy is refused with `managed by static config`**
The id belongs to a static publisher or endpoint in `torana.yaml`. That is
deliberate and nothing was written except the rejection audit record. Pick a
different `torana_agent_id`. A YAML *agent* id remains valid only for the
legacy endpoint-attach path; Desktop-supplied instruction fields are not
applied to that agent.

**Instructions edited in Desktop had no effect**
No Desktop _edit_ action calls the provider. The change reaches Torana on the
next deploy — pressing Start, or the automatic reconcile when Desktop loads
community UI. Confirm which version is live with
`torana agents list` and compare `instruction_version` before and after.

**An agent was deleted in Desktop but is still running**
Check `torana agents list`. If it is `staged_delete`, it is inside its grace
window and will purge at `purge_at`. If it is still `active`, the tombstone
never arrived: Desktop's publish is best-effort and a failure is swallowed
locally. It will show in `torana agents report` with `record_state: absent`;
remove it deliberately with
`torana agents purge <id> --acknowledge-data-loss`.

**An agent was staged for deletion and you want it back**
`torana agents restore <id>`, any time before `purge_at`. The endpoint stays
down until the next deploy or `torana endpoints resume <id>`, and the agent is
now running with no Desktop record behind it — expect it in the reconciliation
report.

**`torana agents purge` printed success but nothing was destroyed**
That command moves the deadline; the running gateway's sweep destroys, within
300 s. With the gateway stopped, it happens at the next start. Confirm with
`torana agents list`.

**The reconciliation report says `record_state: unknown` for everything**
The relay could not be reached inside the 10 s probe budget, or the watcher is
not connected. `unknown` is deliberate — an unreachable relay is never reported
as `absent`, because `absent` reads as "the Desktop deleted this".

**A tombstone appears under `rejected_tombstones`**
It deleted nothing, by design. `yaml_identity` means it named an agent declared
in `torana.yaml`, which relay events can never remove. `owner_mismatch` and
`invalid_signature` mean it was not the owner's word. `unmatched_pubkey` means
no managed agent holds that identity.

---

## Still stuck

- `GET /health` — per-bot readiness, mailbox depth, last turn time
- `torana endpoints status`, `torana conversations list`, `torana sessions list`,
  `torana outbox list` — live operational state
- [`operations.md`](operations.md) — runbook snippets for the common recoveries
- Bugs and questions: [Issues](https://github.com/jvbutterfield/torana/issues).
  Security issues go through [`SECURITY.md`](../SECURITY.md), not public issues.
