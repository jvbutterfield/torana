# Agent API

The Agent API is an opt-in, bearer-authenticated HTTP surface (`/v1/*`) that
lets external processes — other agents, scripts, cron jobs, CI systems — drive
the bots a torana gateway owns. It ships with torana v1 and is off by default.

Two modes:

- **`ask`** — synchronous request/response against a bot's runner in an
  isolated **side-session**. The caller gets `{text, turn_id, usage}` back, no
  Telegram involvement.
- **`send`** — post a system message into an existing Telegram chat
  so the runner responds as if the user had typed it. The sent text is
  wrapped with a marker (`[system-message from "<source>"]`) so the runner
  can distinguish machine-initiated turns from real ones.

---

## Enable it

```yaml
agent_api:
  enabled: true
  tokens:
    - name: ci-reviewer
      secret_ref: ${TORANA_CI_TOKEN}
      bot_ids: ["reviewer"]
      scopes: ["ask", "send"]
  side_sessions:
    idle_ttl_ms: 3_600_000 # 1h of no use → reaped
    hard_ttl_ms: 86_400_000 # 24h absolute lifetime
    max_per_bot: 8
    max_global: 64
  send:
    max_body_bytes: 104_857_600 # 100 MiB — applies to JSON and multipart
    idempotency_retention_ms: 86_400_000
  ask:
    default_timeout_ms: 60_000
    max_timeout_ms: 300_000
    max_body_bytes: 104_857_600 # 100 MiB — applies to JSON and multipart
    max_files_per_request: 10
  expose_runner_type: false         # opt-in: include `runner_type` in /v1/bots
```

All fields have defaults. Minimally you need `enabled: true` and at least one
`tokens[]` entry. `torana doctor` runs `C009..C014` against this block —
unknown `bot_ids`, empty token lists, `ask`-scope tokens pointing at a runner
without side-session support, and TTL/cap invariant violations all surface
there.

---

## Architecture

```
┌──────────────────┐           ┌─────────────────────────────────┐
│ caller (CI, cron,│  HTTP/1.1 │ torana                          │
│ another agent)   │────────── ▶                                 │
│                  │  bearer   │  /v1/bots/:id/ask    → pool →  │
└──────────────────┘           │                         ├──────▶│ claude
                               │  /v1/bots/:id/send   → db → dispatch → │ codex
                               │                                 │ command
                               │  /v1/turns/:id       (poll)     │
                               │  /v1/bots, /v1/bots/:id/sessions│
                               │  /v1/health                     │
                               └─────────────────────────────────┘
```

Side-sessions are per-bot subprocess instances that are _separate from_ the
main Telegram-serving runner. A long-running `ask` from CI cannot block a
Telegram reply, and vice versa.

The pool:

- Mints `eph-<uuid>` sessions for callers that don't pass `session_id`; they
  auto-stop when their turn ends.
- Reuses keyed sessions across turns (per-session concurrency = 1; a second
  turn while the first is still running returns 429 `side_session_busy`).
- Enforces `max_per_bot` and `max_global` caps; when full, LRU-evicts the
  oldest idle entry (bot-local preferred) before spawning.
- Reaps on `idle_ttl_ms` (no inflight, unused) and `hard_ttl_ms` (absolute
  lifetime regardless of usage).

---

## Authentication

```
Authorization: Bearer <raw-token>
```

Tokens are validated with a **constant-time SHA-256 compare** — the gateway
stores only the hash at load time. The raw token is added to the secret
redaction set so it never lands in logs. Token secrets must be at least
32 characters (schema-enforced — generate with `openssl rand -base64 32`).

Authorization runs in this exact order so an unauthenticated or
under-privileged caller cannot enumerate bot ids:

1. `authenticate` — does the presented bearer match any configured token?
   Missing or wrong → `401 missing_auth` / `401 invalid_token`. Runs
   **before** any lookup against `:bot_id`.
2. `authorize` — does the authenticated token's `bot_ids` include this
   `:bot_id`, and does its `scopes` include the required scope (`ask` or
   `send`)? Either miss → `403 bot_not_permitted` /
   `403 scope_not_permitted`. Returned the same way whether or not
   `:bot_id` actually names a registered bot — a token-for-A probing bot
   B cannot tell real bots from non-existent ones.
3. Registry check — is `:bot_id` actually registered? Only reached when
   the caller's token is legitimately authorized for that id. Unknown →
   `404 unknown_bot`, which at this point only fires for misconfigured
   deployments (token `bot_ids` references a bot id that no longer
   exists in `bots[]`).

A turn that belongs to another caller returns `404 turn_not_found` —
never `403` — so enumeration attacks can't distinguish "doesn't exist"
from "not yours."

---

## Endpoints

### `POST /v1/bots/:bot_id/ask`

Synchronous request/response. Body (`application/json` or `multipart/form-data`):

```json
{
  "text": "what's wrong with this PR?",
  "session_id": "review-PR-4201",
  "timeout_ms": 60000
}
```

- `text` — prompt. 1–64 KiB.
- `session_id` — optional. `^[A-Za-z0-9_-]{1,64}$`. Omit for an ephemeral
  session (auto-stopped after the turn). Pass a stable id to reuse a
  side-session across multiple asks.
- `timeout_ms` — optional. Clamped to `[1000, ask.max_timeout_ms]`. Default
  `ask.default_timeout_ms`.

Multipart requests use the same fields plus `file` parts (per-file and
aggregate size caps; allowlisted MIME only). Files are staged under
`<data_dir>/attachments/<bot_id>/agentapi-<uuid>-<idx><ext>` and cleaned
up on every pre-commit failure path.

Allowlisted MIME types (anything else returns
`attachment_mime_not_allowed`):

| `Content-Type`    | Extension written to disk |
| ----------------- | ------------------------- |
| `image/jpeg`      | `.jpg`                    |
| `image/png`       | `.png`                    |
| `image/webp`      | `.webp`                   |
| `image/gif`       | `.gif`                    |
| `application/pdf` | `.pdf`                    |

**Responses:**

| Status        | Meaning                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`         | `{text, turn_id, session_id, usage, duration_ms}` — done.                                                                                    |
| `202`         | `{turn_id, session_id, status: "in_progress"}` — runner still working at `timeout_ms`. Poll `GET /v1/turns/:turn_id`.                        |
| `400`         | `invalid_body`, `invalid_timeout`.                                                                                                           |
| `401` / `403` | `missing_auth`, `invalid_token`, `bot_not_permitted`, `scope_not_permitted`.                                                                 |
| `413`         | `body_too_large` — Content-Length or streamed body exceeds `ask.max_body_bytes`. Multipart also counts file + form-field bytes in aggregate. |
| `429`         | `side_session_busy` (same id mid-turn) or `side_session_capacity` (pool full).                                                               |
| `500`         | `runner_error` — includes an `X-Torana-Retriable` header whose value is `true` or `false`.                                                   |
| `501`         | `runner_does_not_support_side_sessions`.                                                                                                     |
| `503`         | `runner_fatal` (side-session torn down) or `gateway_shutting_down`.                                                                          |

The 202 path is the "you wanted sync but your runner is slow" escape. The
gateway keeps the side-session locked and wires an **orphan listener** that
persists the eventual terminal event to the DB; the caller polls
`GET /v1/turns/:turn_id` to retrieve the result.

### `POST /v1/bots/:bot_id/send`

Push a message into an existing Telegram chat as if the user had typed it.

```
Idempotency-Key: <A-Za-z0-9_->{16,128}      # required
Content-Type: application/json
```

The key must match `^[A-Za-z0-9_-]{16,128}$`. The 16-char lower bound
pushes callers toward keys with enough entropy to resist accidental
collision across retries and bots (a 32-char UUID without dashes or a
base64url-encoded `randomBytes(12)` are both comfortably above the floor);
the 128-char upper bound caps the size of the idempotency table row.
Keys are scoped per `bot_id` — the same key used against a different bot
inserts a fresh turn. Retention is controlled by
`agent_api.send.idempotency_retention_ms` (default 24h); rows older
than that get swept hourly.

```json
{
  "source": "ci-pr-reviewer",
  "text": "heads up: CI failed on main",
  "user_id": "111222333"
}
```

- `source` — 1–64 chars, lowercase + digits + `_-`. Appears verbatim in the
  system-message marker so the runner (and a reviewer inspecting logs) knows
  who sent it.
- `text` — 1–64 KiB.
- `user_id` OR `chat_id` required. `user_id` is preferred; the gateway maps
  it to the last known `chat_id` from the `user_chats` table. `chat_id` must
  already be associated with this bot (default-deny).

**ACL re-check.** Even with a valid token, the resolved `user_id` must be
in `access_control.allowed_user_ids` for the target bot — agent-API tokens
grant access to _bots_, not to _users_.

**Responses:**

| Status        | Meaning                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- | --------------------------- |
| `202`         | `{turn_id, status: "queued"                                                             | "in_progress"}` — enqueued. |
| `400`         | `invalid_body`, `missing_target`, `missing_idempotency_key`, `invalid_idempotency_key`. |
| `401` / `403` | auth failures; `chat_not_permitted`, `target_not_authorized`.                           |
| `404`         | `user_not_opened_bot`.                                                                  |
| `413`         | `body_too_large` — exceeds `send.max_body_bytes`.                                       |
| `500`         | `internal_error`.                                                                       |

**Idempotency.** Per `(bot_id, idempotency_key)` pair, within
`send.idempotency_retention_ms` (default 24h), the gateway returns the
prior turn id and **ignores the current body**. This applies both to the
pre-write check (before file writes) and to the in-transaction race where
two concurrent callers present the same key.

### `GET /v1/turns/:turn_id`

Read the state of any turn the caller's token owns.

```json
// in_progress
{"turn_id": 42, "status": "in_progress"}

// done (ask)
{"turn_id": 42, "status": "done", "text": "...", "usage": {...}, "duration_ms": 4231}

// failed
{"turn_id": 42, "status": "failed", "error_text": "..."}
```

- Turns older than 24h return **`410 turn_result_expired`** — the result
  gets swept off the disk.
- Turns owned by a different token, Telegram-origin turns, and nonexistent
  turns all return the same `404 turn_not_found` (prevents enumeration).
- `status: "failed"` with a null `error_text` is set to
  `"interrupted_by_gateway_restart"` — crash recovery sweeps up in-flight
  turns this way.

### `GET /v1/bots`

```json
{
  "bots": [
    {
      "bot_id": "reviewer",
      "supports_side_sessions": true
    },
    {
      "bot_id": "drafter",
      "supports_side_sessions": true
    }
  ]
}
```

Filtered to bots the caller's token is scoped to. Useful for discovery: a
CI script can run `torana bots list` to see what it's allowed to drive.

`runner_type` is **omitted by default** so a bearer token doesn't leak
deployment shape (see [Security model](#security-model)). Set
`agent_api.expose_runner_type: true` in the gateway config to include it:

```json
{
  "bots": [
    {"bot_id": "reviewer", "runner_type": "claude-code", "supports_side_sessions": true},
    {"bot_id": "drafter",  "runner_type": "codex",       "supports_side_sessions": true}
  ]
}
```

### `GET /v1/bots/:bot_id/sessions` · `DELETE /v1/bots/:bot_id/sessions/:session_id`

Live pool snapshot + explicit teardown, for operators debugging capacity
or reclaiming sessions that a caller lost track of. Read-only; the DB's
`side_sessions` table is observational and not consulted by these endpoints.

### `GET /v1/health`

Unauthenticated. Always registered (even when `agent_api.enabled=false`)
so operators can confirm the binary has Agent-API support compiled in.

```json
{
  "ok": true,
  "version": "1.0.0",
  "agent_api_enabled": true,
  "uptime_secs": 3600
}
```

---

## Rate-limit and concurrency model

- **Per side-session: concurrency = 1.** A second `ask` on a keyed session
  while the first is mid-turn returns `429 side_session_busy`. v1 fixes this
  at 1 for predictability; a future version may raise it if users hit the
  ceiling in practice.
- **Per bot: `max_per_bot` side-sessions.** At cap the pool LRU-evicts the
  oldest idle (bot-local) entry before spawning. If none are evictable →
  `429 side_session_capacity`.
- **Globally: `max_global` side-sessions.** Same rule, LRU'd across bots.
- **Ask timeout.** Clamp on the wire; `timeout_ms > max_timeout_ms` →
  `400 invalid_timeout`. Running past `timeout_ms` → 202 handoff (see
  below), not 503.

---

## Observability

Every agent-API call is metered on the gateway's `/metrics` endpoint (when
`metrics.enabled=true`). Prefix: `torana_agent_api_*`. Counters, gauges,
and two histograms:

| Metric                                                  | Type      | Labels                                          |
| ------------------------------------------------------- | --------- | ----------------------------------------------- |
| `torana_agent_api_requests_total`                       | counter   | `bot_id, mode, outcome ∈ {2xx,4xx,5xx,timeout}` |
| `torana_agent_api_send_idempotent_replays_total`        | counter   | `bot_id`                                        |
| `torana_agent_api_side_sessions_started_total`          | counter   | `bot_id`                                        |
| `torana_agent_api_side_session_evictions_total`         | counter   | `bot_id, reason ∈ {idle,hard,lru}`              |
| `torana_agent_api_side_session_capacity_rejected_total` | counter   | `bot_id`                                        |
| `torana_agent_api_ask_orphan_resolutions_total`         | counter   | `bot_id, outcome ∈ {done,error,fatal,backstop}` |
| `torana_agent_api_side_sessions_live`                   | gauge     | `bot_id`                                        |
| `torana_agent_api_request_duration_ms`                  | histogram | `bot_id, route ∈ {ask,send}`                    |
| `torana_agent_api_side_session_acquire_duration_ms`     | histogram | `bot_id, outcome ∈ {reuse,spawn,capacity,busy}` |

`ask_timeouts_total` (in the `requests_total` table above, counted once per
202 handoff) pairs with `ask_orphan_resolutions_total` (counted once per
eventual terminal event) to answer "of the asks that timed out and got a
202, how did the runner actually finish?" A sustained gap between the two
means turns are being force-released at the 1h backstop
(`outcome="backstop"`) — the runner isn't emitting terminal events.

Bucket sequence for both histograms (ms): `50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000`.

**Pre-flight checks.** `torana doctor` runs:

- **C009..C014** (local, from `torana.yaml`): enabled-without-tokens warning;
  unknown `bot_ids`; ask-scope on non-side-session-capable runner; empty
  `secret_ref`; TTL/cap invariant violations; deployment-posture notice.
- **R001..R003** (remote, via `torana doctor --server URL --token TOK`):
  `GET /v1/health` (2s timeout); `GET /v1/bots` returns non-empty; TLS chain
  validates on `https://`. `torana doctor --profile NAME` — a profile-store
  convenience over `--server` + `--token` — ships in Phase 6b.

---

## Security model

- **Bearer tokens are the only authentication.** Network access controls
  (TLS, firewall, VPN, reverse proxy) are your responsibility — see `C014`.
- **SHA-256 + timingSafeEqual.** No raw token equality checks.
- **Redaction.** The raw token is added to the log redactor's set at
  config-load time; it won't appear in structured logs or `/bot<TOKEN>/`
  URL paths.
- **Per-bot scoping.** A token can drive exactly the bots listed in its
  `bot_ids` array. Other bots return the same error shape as
  "token invalid" so callers can't probe for bot existence.
- **Per-scope gating.** `ask` and `send` are independent; a token scoped
  `["send"]` cannot call `/v1/bots/:id/ask`.
- **Send ACL re-check.** Agent-API tokens grant access to _bots_, not
  _users_. The resolved `user_id` is re-validated against the bot's
  `access_control.allowed_user_ids` before the turn is enqueued.
- **No enumeration.** Every 404 path for turn reads returns a single
  `turn_not_found` code regardless of the underlying reason.
- **Attachment hardening.** Gateway-controlled filenames only
  (`agentapi-<uuid>-<idx><ext>`); callers never supply paths. Per-file,
  aggregate, count, and disk-usage caps all enforce in
  `parseMultipartRequest`.
- **Idempotency is a safety feature**, not just a convenience: retrying an
  `send` won't double-send even if the caller's network flapped.
- **`runner_type` is hidden by default.** `GET /v1/bots` omits each bot's
  runner kind (`claude-code` / `codex` / `command`) unless the operator
  sets `agent_api.expose_runner_type: true`. This keeps a leaked token
  from revealing what side-channels (prompt injection, tool-use abuse,
  command-shell access) are worth probing.

### Session-id sharing across tokens

In v1 the side-session key is `(bot_id, session_id)`. If two tokens scoped
to the same bot happen to use the same `session_id`, they share a
conversation context. This is a known v1 design trade-off; pick
`session_id` values with enough entropy that collisions are unlikely
(e.g. prefix with the caller's identity) or issue one token per caller.

---

## CLI

The gateway binary ships four client subcommands. See [`docs/cli.md`](cli.md)
for every flag; a quick tour:

```sh
torana bots list --server https://gw --token $TOK
torana ask reviewer "review this diff"           --server https://gw --token $TOK
torana send drafter --user-id 111 "hey"          --server https://gw --token $TOK --source ci
torana turns get 42                              --server https://gw --token $TOK
```

`TORANA_SERVER` and `TORANA_TOKEN` stand in for the flags. Exit codes follow
a fixed taxonomy (`0` success, `2` bad usage, `3` auth failed, `4` not
found, `5` server error, `6` timeout / 202 handoff, `7` capacity).

When `torana ask` receives a 202 the CLI exits **6** and prints `turn_id`
on stdout so you can pipe it into `torana turns get`:

```sh
id=$(torana ask reviewer "long job") && torana turns get "$id"
```

---

## Worked examples

### Synchronous code review from CI

```sh
DIFF=$(git diff main...HEAD)
RESULT=$(torana ask reviewer "Review this diff:\n$DIFF" \
  --server $TORANA_URL --token $TORANA_CI_TOKEN --timeout-ms 180000)
echo "$RESULT"
```

### Posting a CI alert into a Telegram chat

```sh
torana send reviewer \
  --user-id $TELEGRAM_USER_ID \
  --source ci-pr-reviewer \
  --idempotency-key "ci-pr-4201-run-7" \
  "PR #4201 failed tests: test/unit/foo.test.ts"
```

Safe to retry — the idempotency key dedupes.

### Running a side-session across multiple asks

```sh
SID="review-PR-4201"
torana ask reviewer --session-id $SID "Here's the PR description: ..."
torana ask reviewer --session-id $SID "What's the most likely bug?"
torana ask reviewer --session-id $SID "Rewrite the tests."
```

The runner sees all three turns in one conversation. When the caller is
done, either stop explicitly or let `idle_ttl_ms` reap it:

```sh
curl -X DELETE $TORANA_URL/v1/bots/reviewer/sessions/$SID \
  -H "Authorization: Bearer $TORANA_CI_TOKEN"
```

---

## What's not in v1

- **CommandRunner side-sessions** (Phase 2c). `ask` against a `command`-type
  runner returns `501 runner_does_not_support_side_sessions`. `send`
  works against `command` runners today.
- **Profile store at `~/.config/torana/config.toml`** (Phase 6b). Use
  `--server`/`--token` flags or `TORANA_SERVER`/`TORANA_TOKEN` env vars
  for now.
- **`torana skills install --host=claude|codex`** (Phase 6b).
- **Per-session concurrency > 1.** Fixed at 1 for v1.
- **Session-id partitioning by token.** v1 keys by
  `(bot_id, session_id)`; a future version may include `token_name`.
