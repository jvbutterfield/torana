# rc.7 security hardening — handoff

**Branch:** `rc.7/security-hardening` (10 commits ahead of `main`, head `fa0370b`)
**Status:** All P0 + P1 fixes landed. Tests 1185 pass / 0 fail / 13 skip across 118 files. Typecheck + prettier clean. Working tree clean.
**Not yet:** version bump, CHANGELOG section move, push, tag, release.

---

## What's on the branch

10 commits, oldest first:

| Commit  | Severity   | Title                                                                          |
| ------- | ---------- | ------------------------------------------------------------------------------ |
| 4696b97 | P1+P2+P3   | Initial 5 fixes (acknowledge_dangerous + enumeration + secret-min-32 + body cap + bind_host) |
| 7f98ed3 | **P0**     | Dashboard proxy: strip sensitive headers + redirect:manual + loopback-only default |
| 42c31b1 | **P0**     | Webhook 1 MiB body cap (Content-Length precheck + chunked abort)               |
| 78ac264 | **P1**     | Reject `[system-message from "…"]` marker injection in send text               |
| 03d22ed | **P1**     | Magic-byte MIME validation on every attachment write                           |
| e2e2fae | **P1**     | Migration OS file lock with stale-lock recovery                                |
| eac8703 | **P1**     | Crash recovery skips Telegram notify for agent_api_send / agent_api_ask        |
| d3a4898 | **P1**     | `gateway.db` + WAL/SHM chmod 0600 + doctor C015                                |
| c8dd3a9 | **P1**     | `redactString` applied to all 12 runner stdout/stderr log-write sites          |
| fa0370b | docs       | CHANGELOG update grouping P0 / P1 / initial-rc.7-fixes + upgrade notes         |

The first commit (`4696b97`) is wide because it bundled `prettier --write` drift across `src/` + `test/` from the rc.6 tree. Logical changes there are confined to the files mentioned in its commit message; the rest is pure formatting.

---

## To cut rc.7 from this branch

1. **Bump version** in `package.json`: `1.0.0-rc.6` → `1.0.0-rc.7`.
2. **Move `## [Unreleased]`** in `CHANGELOG.md` to `## [1.0.0-rc.7] - <today>`.
3. **Commit** these two as a single "rc.7: cut" commit.
4. **Push** the branch: `git push -u origin rc.7/security-hardening`.
5. **Open a PR** into `main` (rc.6 went via PR #7 — same flow). The diff is large because of the prettier drift; reviewer can lean on the per-commit messages and the CHANGELOG.
6. **Tag after merge**: `git tag v1.0.0-rc.7` from main, push tag, the existing release workflow publishes to npm under the `rc` dist-tag.
7. **Note** the prior memory entry about the 24h-soak: that gate is for the 1.0.0 cut, not rc.7 — but if the soak harness is currently running on rc.6 fixtures, stop it before merging since the schema changed (acknowledge_dangerous, bind_host, send.max_body_bytes) and its config will no longer parse.

---

## Breaking config changes since rc.6 (10 items in the CHANGELOG upgrade notes)

Three are hard breaks that fail config-load on existing rc.6 yaml:

1. **`bots[].runner.acknowledge_dangerous: true`** required for every claude-code bot.
2. **`transport.webhook.secret`** + **`agent_api.tokens[].secret_ref`** must be ≥ 32 chars. Generate with `openssl rand -base64 32`.
3. **`gateway.bind_host`** defaults to `127.0.0.1`. Container / PaaS deployments must set `bind_host: "0.0.0.0"` explicitly.

Plus seven softer breaks documented in CHANGELOG (`agent_api.send.max_body_bytes` is new with default; auth-ordering response-shape change; `dashboard.allow_non_loopback_proxy_target` opt-in; DB chmod best-effort; marker-injection rejection; webhook 1 MiB cap; multipart magic-byte validation).

---

## P2 deferred items (rc.8 or 1.0.0)

These came out of the deep security review but were judged not blocking for rc.7. None is exploitable by an unauthorized caller; all need the bearer to even land. Listed roughly in descending priority:

1. **Per-bot webhook secrets.** `transport.webhook.secret` is one global value used to register every bot's webhook. Compromise of one bot host = compromise of all webhook updates. Fix: derive per-bot via `HMAC(master, botId)` + verify against the bot indexed by `:botId` in the URL. Touches `src/transport/webhook.ts` + setWebhook calls.

2. **`runner.env` values in the log redactor.** Operators commonly stash `ANTHROPIC_API_KEY`, DB creds, etc. in `runner.env`. They aren't currently in the redaction set; they leak into `torana validate` output and any log line that echoes resolved config. Fix: opt-in `secret: true` schema marker, OR auto-redact any `runner.env` value > 16 chars with a doctor warning to encourage `${VAR}` indirection.

3. **Codex `thread_id` argv validation.** `src/runner/codex.ts:421-428` accepts whatever `thread.started.thread_id` the codex subprocess emits, persists it, then replays it as argv on the next turn. Bun's `spawn` argv-element separation makes shell injection impossible, but a control-char-bearing id lands in argv + on disk. Fix: anchored regex `^[A-Za-z0-9_-]{1,128}$` in the parser before invoking `onThreadStarted`.

4. **`invalid_body` detail sanitization.** `src/agent-api/handlers/send.ts:199` and `src/agent-api/attachments.ts:151-159` reflect raw exception messages (`req.formData()` / `JSON.parse` / `insertSendTurn`) into the response detail. Authenticated callers get internal SQL/file-path text. Map to canonical strings; log details server-side only.

5. **`/v1/turns/:turn_id` timing normalization.** Malformed-id branch (`src/agent-api/handlers/turns.ts:22-24`) returns instantly; valid-int-not-yours does a DB round-trip. Distinguishable via timing. Fix: always do the DB lookup (also for non-integer ids) or add a fixed minimum delay.

6. **Per-token side-session cap.** `src/agent-api/pool.ts:341-358` enforces `max_per_bot` then `max_global`. A noisy token holding many bots in `bot_ids` can exhaust the global budget against tokens sharing it. Fix: track inflight per-token, add `agent_api.tokens[].max_concurrent_side_sessions`.

7. **`db.query()` raw-SQL escape hatch.** `src/db/gateway-db.ts:88-90` exposes raw `prepare()`. Currently only used by tests + one parameterized callsite, but a footgun. Rename to `_unsafeQuery` or move to a test-only export.

8. **`dynamicUpdate` column-name interpolation.** `src/db/gateway-db.ts:591-608` builds `UPDATE ${table} SET ${k} = ?` from caller-supplied object keys. Both call sites pass typed `Partial<…>` so it's safe at compile time but TypeScript erases at runtime. Add an allowlist intersection per table.

9. **`/v1/bots` `runner_type` exposure.** Token-permitted listing returns `claude-code` / `codex` / `command`. Probably intentional but worth reviewing whether deployment-shape disclosure matters for the threat model.

10. **Telegram attachment TOCTOU on collision.** `src/core/attachments.ts:83,125` use `writeFile` (no `O_EXCL`, follows symlinks). `update_id` collisions are rare but possible. Fix: `O_CREAT | O_EXCL | O_NOFOLLOW`; on collision, regenerate with a UUID suffix.

11. **Outbox retry semantics under crash.** `src/outbox.ts:170-179` calls `markOutboxSent` AFTER the Telegram POST succeeds. A crash between success and bump replays the send → duplicate Telegram message. Inherent to at-least-once delivery without server-side idempotency, but worth mitigating: mark `in_flight` BEFORE send; on crash recovery, dedupe by tracking message-content hash.

12. **URL bot-token redactor regex requires trailing `/`.** `src/log.ts:50` `URL_BOT_TOKEN_RE`. Telegram file-URL truncations without trailing slash slip through. Belt-and-braces only because `bots[].token` is in `setSecrets`. Make trailing slash optional.

13. **Schema-string size cap.** `loadConfigFromString` (`src/config/load.ts:195`) skips `maxBytes`. No internal route accepts YAML strings from the network today, but if `/admin/config/preview` ever lands it inherits unbounded parse cost. Pass cap through.

14. **`yaml.load` schema pinning.** `src/config/load.ts:204` uses default schema (which is safe in js-yaml v4). Pin explicitly to `yaml.CORE_SCHEMA` so a future dep upgrade can't silently widen the type set.

15. **Recovery from an interpolation result that's > maxBytes.** `loadConfigFromFile` checks file size at `src/config/load.ts:157` but interpolation can expand the string (a single `${VAR}` reference resolving to MB of content). Re-check size after interpolation.

---

## Surfaces NOT covered by the deep review

The three security-review agents skipped these — worth a pass before 1.0.0 final, not blockers for rc.7:

- Runner sandbox internals beyond the config gate (claude `--dangerously-skip-permissions` is now config-gated; codex `yolo`/`full-auto`/`workspace-write` modes ditto — the actual sandbox enforcement at the OS / capability level is the runner's responsibility, not torana's).
- `src/alerts.ts` plumbing — no review of how alert messages are built / where data flows.
- `src/transport/polling.ts` backpressure under sustained load.
- Upstream Telegram rate-limit handling end-to-end.
- `src/dashboard/*` — confirmed no such directory exists; the dashboard surface is the proxy block in `main.ts:459-505` only.

---

## Recovery if you re-open this work

`git checkout rc.7/security-hardening` and you're back where this handoff started. Working tree is clean; everything is committed. Start with the "To cut rc.7" steps above. Memory-system entry (separate from this file) points here under the title "rc.7 security hardening".
