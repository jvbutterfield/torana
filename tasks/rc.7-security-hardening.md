# rc.7 security hardening — handoff

**Branch:** `rc.7/security-hardening` (31 commits ahead of `main` once this CHANGELOG-count fix lands — see "What's on the branch")
**Status:** All P0 + P1 + P2 fixes landed, the 4-finding review-pass follow-ups from the previous round, and the 8-finding Telegram rate-limit + polling reliability stack from a second review pass. Tests 1243 pass / 0 fail / 13 skip across 120 files. Typecheck + prettier clean.
**Not yet:** version bump, CHANGELOG section move, push, tag, release.

---

## What's on the branch

29 commits already in the table below, plus the tracker update (this commit), oldest first:

| Commit  | Severity | Title                                                                                              |
| ------- | -------- | -------------------------------------------------------------------------------------------------- |
| 4696b97 | P1+P2+P3 | Initial 5 fixes (acknowledge_dangerous + enumeration + secret-min-32 + body cap + bind_host)       |
| 7f98ed3 | **P0**   | Dashboard proxy: strip sensitive headers + redirect:manual + loopback-only default                 |
| 42c31b1 | **P0**   | Webhook 1 MiB body cap (Content-Length precheck + chunked abort)                                   |
| 78ac264 | **P1**   | Reject `[system-message from "…"]` marker injection in send text                                   |
| 03d22ed | **P1**   | Magic-byte MIME validation on every attachment write                                               |
| e2e2fae | **P1**   | Migration OS file lock with stale-lock recovery                                                    |
| eac8703 | **P1**   | Crash recovery skips Telegram notify for agent_api_send / agent_api_ask                            |
| d3a4898 | **P1**   | `gateway.db` + WAL/SHM chmod 0600 + doctor C015                                                    |
| c8dd3a9 | **P1**   | `redactString` applied to all 12 runner stdout/stderr log-write sites                              |
| fa0370b | docs     | CHANGELOG update grouping P0 / P1 / initial-rc.7-fixes + upgrade notes                             |
| 57720d7 | docs     | Initial rc.7 handoff tracker                                                                       |
| bbc3098 | **P2**   | O_EXCL + O_NOFOLLOW on attachment writes (overwrite + symlink hardening)                           |
| 86f4226 | **P2**   | Normalize timing on `GET /v1/turns/:turn_id` 404 paths                                             |
| e0544df | **P2**   | Hide `runner_type` from `/v1/bots` by default (`agent_api.expose_runner_type`)                     |
| 4c6ae18 | **P2**   | Canonical `detail` strings for agent-API error responses                                           |
| 9d0d4e6 | **P2**   | Validate codex `thread_id` before persisting + replaying as argv                                   |
| 2fa31b8 | **P2**   | Rename `GatewayDB.query` → `_unsafeQuery` + typed prod helpers                                     |
| 05763f0 | **P2**   | Runtime column allowlist on `GatewayDB.dynamicUpdate`                                              |
| d36498a | **P2**   | `bots[].runner.secrets` map for inlined-secret redaction                                           |
| 54ab67f | **P2**   | Per-token concurrent side-session cap                                                              |
| 88c0d97 | docs     | Fold rc.8 P2 backlog into rc.7 release (CHANGELOG + tracker + format drift)                        |
| 23715e5 | chore    | `.prettierignore` for example torana.yaml files                                                    |
| 46affcd | **P2**   | Sanitize remaining agent-API error detail leaks (`body.ts` + `ask.ts`)                             |
| da860e5 | **P2**   | Outbox `in_flight` marker narrows crash-window dup risk                                            |
| 18d6851 | **P2**   | Redact alert text + check `sendMessage` result                                                     |
| eabbb9d | docs     | Tracker update for review-pass follow-ups + 1.0.0 backlog                                          |
| 3dc7ced | **P1**   | Telegram 429/Retry-After awareness + polling reliability fixes (F2/F4/F6/F7 + C-1/C-2)             |
| 1624a7b | **P1**   | Outbox per-bot sharding + Retry-After-respecting retries + streaming 429 backoff (F1/F3/F5/F9)     |
| fa2b92c | docs     | Runner sandbox boundary — explicit isolation patterns + non-enforcement of `acknowledge_dangerous` |

The first commit (`4696b97`) is wide because it bundled `prettier --write` drift across `src/` + `test/` from the rc.6 tree. Logical changes there are confined to the files mentioned in its commit message; the rest is pure formatting. The rc.8 P2 commits (`bbc3098..54ab67f`) were originally authored on nine separate branches off `main`; cherry-picked into this branch with conflict resolution preserving the rc.7 P0/P1 contracts (notably the `attachment_mime_not_allowed` distinct response code from `03d22ed`, and the multi-line prettier-friendly formatting in the 6 conflicted test files where `query` was renamed to `_unsafeQuery`).

The first review-pass follow-up commits (`46affcd..18d6851`) came after the 9-item fold-in: an audit of agent-API handlers found two more `err.message` leaks (`body.ts:83` + `ask.ts:247`); the outbox dup-on-crash item from the deferred backlog was upgraded from "documented limitation" to "narrowed window with operator visibility"; and a dedicated review of `src/alerts.ts` (the deep review had skipped this file) surfaced an unredacted-reason gap and a dead-catch operability bug.

The second review-pass commits (`3dc7ced..fa2b92c`) addressed the rate-limit findings: Retry-After parsing in TelegramClient (F2), HTTP timeouts on every Telegram request (F4), polling honoring Retry-After (F6), webhook startup transient classification (F7), polling offset-on-failure semantics + failureCount cap (Group C), outbox per-bot sharding (F1), Retry-After-respecting retries that don't burn the attempt budget (F5), streaming 429 backoff + typing-ping gating (F3 + F9), and runner sandbox documentation upgrades. Together these remove the self-DoS lever an attacker could induce via per-chat throttling.

---

## To cut rc.7 from this branch

1. **Bump version** in `package.json`: `1.0.0-rc.6` → `1.0.0-rc.7`.
2. **Move `## [Unreleased]`** in `CHANGELOG.md` to `## [1.0.0-rc.7] - <today>`.
3. **Commit** these two as a single "rc.7: cut" commit.
4. **Push** the branch: `git push -u origin rc.7/security-hardening`.
5. **Open a PR** into `main` (rc.6 went via PR #7 — same flow). The diff is large because of the prettier drift + the 9 folded-in P2 fixes + the two review-pass batches (4 P2 follow-ups + 8 rate-limit/reliability fixes); reviewer can lean on the per-commit messages and the CHANGELOG.
6. **Tag after merge**: `git tag v1.0.0-rc.7` from main, push tag, the existing release workflow publishes to npm under the `rc` dist-tag.
7. **Note** the prior memory entry about the 24h-soak: that gate is for the 1.0.0 cut, not rc.7 — but if the soak harness is currently running on rc.6 fixtures, stop it before merging since the schema changed (acknowledge_dangerous, bind_host, send.max_body_bytes, runner.secrets, max_concurrent_side_sessions, max_per_token_default, expose_runner_type) and its config will no longer parse.

---

## Breaking config changes since rc.6

**Three hard breaks** that fail config-load on existing rc.6 yaml:

1. **`bots[].runner.acknowledge_dangerous: true`** required for every claude-code bot.
2. **`transport.webhook.secret`** + **`agent_api.tokens[].secret_ref`** must be ≥ 32 chars. Generate with `openssl rand -base64 32`.
3. **`gateway.bind_host`** defaults to `127.0.0.1`. Container / PaaS deployments must set `bind_host: "0.0.0.0"` explicitly.

**Eleven softer breaks** documented in the CHANGELOG upgrade notes:

4. `agent_api.send.max_body_bytes` is new with default 100 MiB.
5. Auth-ordering response-shape change (404→403 for unknown ids).
6. `dashboard.allow_non_loopback_proxy_target` opt-in.
7. DB chmod 0600 best-effort.
8. Marker-injection rejection on send.
9. Webhook 1 MiB cap.
10. Multipart magic-byte validation.
11. **Per-token side-session cap defaults to 8** (raise via `agent_api.tokens[].max_concurrent_side_sessions` or `agent_api.side_sessions.max_per_token_default`).
12. **`runner_type` omitted from `/v1/bots`** unless `agent_api.expose_runner_type: true`.
13. **Agent-API `invalid_body` / `internal_error` `detail` strings are now canonical** (clients string-matching exception text need to switch to the `error` code field).
14. **Polling: a thrown update handler now holds the offset.** A handler that throws on update N stops batch processing AND skips the offset bump — Telegram redelivers from N on the next poll. Pre-fix silently lost the failing update by bumping past it. The new semantic is a strict improvement for transient causes; persistently-failing updates will now block subsequent updates until the cause is fixed (visible immediately in `torana doctor` and the per-bot log file).

---

## P2 deferred items — four remain for rc.8 / 1.0.0

The original deep-review backlog had 15 P2 items. One was dropped on review (per-bot webhook secrets — the threat model didn't apply to torana's single-process architecture). Nine were folded into rc.7 plus 1 follow-up (outbox dup-on-crash, originally listed here, now addressed by `da860e5`). Four remain deferred:

1. **URL bot-token redactor regex requires trailing `/`.** `src/log.ts:50` `URL_BOT_TOKEN_RE`. Telegram file-URL truncations without trailing slash slip through. Belt-and-braces only because `bots[].token` is in `setSecrets`. Make trailing slash optional.

2. **Schema-string size cap.** `loadConfigFromString` (`src/config/load.ts:195`) skips `maxBytes`. No internal route accepts YAML strings from the network today, but if `/admin/config/preview` ever lands it inherits unbounded parse cost. Pass cap through.

3. **`yaml.load` schema pinning.** `src/config/load.ts:204` uses default schema (which is safe in js-yaml v4). Pin explicitly to `yaml.CORE_SCHEMA` so a future dep upgrade can't silently widen the type set.

4. **Recovery from an interpolation result that's > maxBytes.** `loadConfigFromFile` checks file size at `src/config/load.ts:157` but interpolation can expand the string (a single `${VAR}` reference resolving to MB of content). Re-check size after interpolation.

---

## Findings from the focused review pass — all addressed

Four surfaces the original deep review skipped were re-examined post-fold-in across two review-pass batches. All findings are now closed.

### `src/alerts.ts` — addressed by `18d6851`

Two P2: caller-supplied `reason` strings reached Telegram chat unredacted (analogous to the `c8dd3a9` runner-stdout/stderr gap); `sendMessage` swallows Telegram errors so the previous `try/catch` was effectively dead and `"alert sent"` logged on actual failure. Fixed by wrapping `text` in `redactString()` and checking `result.ok` explicitly.

### `src/transport/polling.ts` — addressed by `3dc7ced`

- **P2 — offset advanced after a fully-failed batch.** Now stops processing on the first throw and holds the offset; Telegram redelivers from the failing id on the next poll. **Upgrade note 14** documents the semantic change.
- **P2 — `failureCount` grew unbounded on cyclic failures.** Capped at `FAILURE_COUNT_CAP=16`, well past `nextBackoffMs` saturation.

P3 deleteWebhook-silent-fail and the AbortController listener nit are operational polish, deferred (still appropriate to leave).

### Telegram rate-limit (HTTP 429) handling — addressed by `3dc7ced` + `1624a7b`

This was the highest-leverage finding stack — three P1s composed into a self-DoS lever. All closed.

- **P1 F1 — Outbox dispatcher serialized across all bots/chats.** Now shards per-bot via `processingBots: Set<BotId>` + `Promise.all`; each bot's queue is still serial (intra-chat ordering preserved).
- **P1 F2 — `Retry-After` was never parsed.** `TelegramError.retryAfterMs` populated from HTTP header (preferred) or envelope `parameters.retry_after`. `SendResult` / `EditResult` carry the field. `retry_after: 0` treated as missing.
- **P1 F3 — Streaming `fireAndForgetEdit` bypassed 429.** Returns `EditResult` now; `StreamManager` observes 429 + sets per-bot `rateLimitedUntil`; subsequent flushes during the cooldown skip the edit. Typing pings (F9) gated on the same cooldown.
- **P2 F4 — No HTTP timeout on Telegram requests.** `AbortSignal.timeout(30_000)` on every `api()` call; long-poll-aware timeout on `getUpdates` composed via `AbortSignal.any()`.
- **P2 F5 — `max_attempts × backoff_cap` could dead-letter inside 3 min.** `markOutboxRateLimited` schedules retries at the server-asked time without bumping `attempt_count`; capped at 5 minutes against a malicious upstream.
- **P3 F6 — Polling ignored Retry-After.** Now sleeps `max(backoff, retryAfterMs)` on `TelegramError` with cooldown.
- **P3 F7 — `setWebhook` startup 429 persistently disabled the bot.** Now classifies 429/5xx/network as transient (bot stays enabled, next start retries); only 401/403/other-4xx disable.
- **P3 F8 — Attachment `getFile`/`downloadFile` silent 429.** Implicitly resolved: the `api()` warn log now includes `retry_after_ms`, so ops have visibility. The caller still returns `null` on failure (no scheduled retry path for attachments — that's appropriate for one-shot turn-bound downloads).
- **nit F9 — Typing pings during cooldown.** Gated alongside the streaming-flush cooldown.

### Runner sandbox documentation — addressed by `fa2b92c`

Was 3/5. Now: `docs/security.md` has a top-level `## Runner isolation` section explicitly stating torana doesn't sandbox + `acknowledge_dangerous` is a doc gate, not enforcement. `docs/runners.md` has a "Concrete isolation patterns" subsection (Docker, firejail, unprivileged-UID + chroot, gVisor, sandbox-exec). README "Safety defaults", `docs/configuration.md` callout, and both loader error messages updated with cross-links. Out-of-scope list in `docs/security.md` updated to point at the new section.

---

## Surfaces still NOT covered

Two surfaces remain genuinely unreviewed and are not blockers for rc.7:

- **`src/dashboard/*` — confirmed no such directory exists.** The dashboard surface is the proxy block in `main.ts:459-505` only, which the rc.7 P0 fix (`7f98ed3`) hardened. No additional review needed.
- **Runner sandbox internals at the OS / capability level.** Correctly out of scope for torana — operator's responsibility. The docs (now updated by `fa2b92c`) say this plainly.

---

## Recovery if you re-open this work

`git checkout rc.7/security-hardening` and you're back where this handoff started. Working tree is clean; everything is committed. Start with the "To cut rc.7" steps above. Memory-system entry (separate from this file) points here under the title "rc.7 security hardening".
