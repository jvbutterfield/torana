# rc.7 security hardening — handoff

**Branch:** `rc.7/security-hardening` (26 commits ahead of `main` once this tracker update lands — see "What's on the branch")
**Status:** All P0 + P1 + P2 fixes landed plus 4 P2 follow-ups from a focused targeted review. Tests 1229 pass / 0 fail / 13 skip across 119 files. Typecheck + prettier clean.
**Not yet:** version bump, CHANGELOG section move, push, tag, release.

---

## What's on the branch

25 commits already in the table below, plus the tracker update (this commit), oldest first:

| Commit  | Severity | Title                                                                                        |
| ------- | -------- | -------------------------------------------------------------------------------------------- |
| 4696b97 | P1+P2+P3 | Initial 5 fixes (acknowledge_dangerous + enumeration + secret-min-32 + body cap + bind_host) |
| 7f98ed3 | **P0**   | Dashboard proxy: strip sensitive headers + redirect:manual + loopback-only default           |
| 42c31b1 | **P0**   | Webhook 1 MiB body cap (Content-Length precheck + chunked abort)                             |
| 78ac264 | **P1**   | Reject `[system-message from "…"]` marker injection in send text                             |
| 03d22ed | **P1**   | Magic-byte MIME validation on every attachment write                                         |
| e2e2fae | **P1**   | Migration OS file lock with stale-lock recovery                                              |
| eac8703 | **P1**   | Crash recovery skips Telegram notify for agent_api_send / agent_api_ask                      |
| d3a4898 | **P1**   | `gateway.db` + WAL/SHM chmod 0600 + doctor C015                                              |
| c8dd3a9 | **P1**   | `redactString` applied to all 12 runner stdout/stderr log-write sites                        |
| fa0370b | docs     | CHANGELOG update grouping P0 / P1 / initial-rc.7-fixes + upgrade notes                       |
| 57720d7 | docs     | Initial rc.7 handoff tracker                                                                 |
| bbc3098 | **P2**   | O_EXCL + O_NOFOLLOW on attachment writes (overwrite + symlink hardening)                     |
| 86f4226 | **P2**   | Normalize timing on `GET /v1/turns/:turn_id` 404 paths                                       |
| e0544df | **P2**   | Hide `runner_type` from `/v1/bots` by default (`agent_api.expose_runner_type`)               |
| 4c6ae18 | **P2**   | Canonical `detail` strings for agent-API error responses                                     |
| 9d0d4e6 | **P2**   | Validate codex `thread_id` before persisting + replaying as argv                             |
| 2fa31b8 | **P2**   | Rename `GatewayDB.query` → `_unsafeQuery` + typed prod helpers                               |
| 05763f0 | **P2**   | Runtime column allowlist on `GatewayDB.dynamicUpdate`                                        |
| d36498a | **P2**   | `bots[].runner.secrets` map for inlined-secret redaction                                     |
| 54ab67f | **P2**   | Per-token concurrent side-session cap                                                        |
| 88c0d97 | docs     | Fold rc.8 P2 backlog into rc.7 release (CHANGELOG + tracker + format drift)                  |
| 23715e5 | chore    | `.prettierignore` for example torana.yaml files                                              |
| 46affcd | **P2**   | Sanitize remaining agent-API error detail leaks (`body.ts` + `ask.ts`)                       |
| da860e5 | **P2**   | Outbox `in_flight` marker narrows crash-window dup risk                                      |
| 18d6851 | **P2**   | Redact alert text + check `sendMessage` result                                               |

The first commit (`4696b97`) is wide because it bundled `prettier --write` drift across `src/` + `test/` from the rc.6 tree. Logical changes there are confined to the files mentioned in its commit message; the rest is pure formatting. The rc.8 P2 commits (`bbc3098..54ab67f`) were originally authored on nine separate branches off `main`; cherry-picked into this branch with conflict resolution preserving the rc.7 P0/P1 contracts (notably the `attachment_mime_not_allowed` distinct response code from `03d22ed`, and the multi-line prettier-friendly formatting in the 6 conflicted test files where `query` was renamed to `_unsafeQuery`).

The trailing 3 commits (`46affcd..18d6851`) came from a targeted-review pass after the 9-item fold-in landed: an audit of agent-API handlers found two more `err.message` leaks (`body.ts:83` + `ask.ts:247`); the outbox dup-on-crash item from the deferred backlog was upgraded from "documented limitation" to "narrowed window with operator visibility"; and a dedicated review of `src/alerts.ts` (the deep review had skipped this file) surfaced an unredacted-reason gap and a dead-catch operability bug.

---

## To cut rc.7 from this branch

1. **Bump version** in `package.json`: `1.0.0-rc.6` → `1.0.0-rc.7`.
2. **Move `## [Unreleased]`** in `CHANGELOG.md` to `## [1.0.0-rc.7] - <today>`.
3. **Commit** these two as a single "rc.7: cut" commit.
4. **Push** the branch: `git push -u origin rc.7/security-hardening`.
5. **Open a PR** into `main` (rc.6 went via PR #7 — same flow). The diff is large because of the prettier drift + the 9 folded-in P2 fixes + the 3 follow-ups; reviewer can lean on the per-commit messages and the CHANGELOG.
6. **Tag after merge**: `git tag v1.0.0-rc.7` from main, push tag, the existing release workflow publishes to npm under the `rc` dist-tag.
7. **Note** the prior memory entry about the 24h-soak: that gate is for the 1.0.0 cut, not rc.7 — but if the soak harness is currently running on rc.6 fixtures, stop it before merging since the schema changed (acknowledge_dangerous, bind_host, send.max_body_bytes, runner.secrets, max_concurrent_side_sessions, max_per_token_default, expose_runner_type) and its config will no longer parse.

---

## Breaking config changes since rc.6

**Three hard breaks** that fail config-load on existing rc.6 yaml:

1. **`bots[].runner.acknowledge_dangerous: true`** required for every claude-code bot.
2. **`transport.webhook.secret`** + **`agent_api.tokens[].secret_ref`** must be ≥ 32 chars. Generate with `openssl rand -base64 32`.
3. **`gateway.bind_host`** defaults to `127.0.0.1`. Container / PaaS deployments must set `bind_host: "0.0.0.0"` explicitly.

**Ten softer breaks** documented in the CHANGELOG upgrade notes:

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

---

## P2 deferred items — four remain for rc.8 / 1.0.0

The original deep-review backlog had 15 P2 items. One was dropped on review (per-bot webhook secrets — the threat model didn't apply to torana's single-process architecture). Nine were folded into rc.7 plus 1 follow-up (outbox dup-on-crash, originally listed here, now addressed by `da860e5`). Four remain deferred:

1. **URL bot-token redactor regex requires trailing `/`.** `src/log.ts:50` `URL_BOT_TOKEN_RE`. Telegram file-URL truncations without trailing slash slip through. Belt-and-braces only because `bots[].token` is in `setSecrets`. Make trailing slash optional.

2. **Schema-string size cap.** `loadConfigFromString` (`src/config/load.ts:195`) skips `maxBytes`. No internal route accepts YAML strings from the network today, but if `/admin/config/preview` ever lands it inherits unbounded parse cost. Pass cap through.

3. **`yaml.load` schema pinning.** `src/config/load.ts:204` uses default schema (which is safe in js-yaml v4). Pin explicitly to `yaml.CORE_SCHEMA` so a future dep upgrade can't silently widen the type set.

4. **Recovery from an interpolation result that's > maxBytes.** `loadConfigFromFile` checks file size at `src/config/load.ts:157` but interpolation can expand the string (a single `${VAR}` reference resolving to MB of content). Re-check size after interpolation.

---

## Findings from the focused review pass — items for 1.0.0

Four surfaces the original deep review skipped were re-examined post-fold-in. `alerts.ts` was addressed in `18d6851`; the other three produced findings worth tracking before 1.0.0. None blocks rc.7.

### `src/transport/polling.ts` — backpressure review

The polling loop is structurally sound: `for (const update of batch) await onUpdate(update)` provides natural backpressure (Telegram queue holds the overflow), per-bot `BotPoller` + `AbortController` give real isolation, attachment caps are layered. Two findings worth a 1.0.0 pass:

- **P2 — offset advances after a fully-failed batch.** `polling.ts:100-115` runs `setBotLastUpdateId(maxId)` unconditionally after the for-loop. A transient DB error (sqlite locked, disk full) silently loses every update in that batch — `inbound_updates` was never written, so the dedup ledger won't redeliver. Fix: track whether any update threw and only advance to the highest _successfully-processed_ `update_id`.

- **P2 — `failureCount` grows without bound on cyclic failures.** `polling.ts:123-128` only resets on a fully successful poll. A bot stuck in "every Nth poll throws" grows the counter toward `MAX_SAFE_INTEGER`; `nextBackoffMs` already caps the wait but the counter itself never decays. Fix: cap at the saturation point or decay after N successful polls.

Other findings from the review (P3 deleteWebhook silent-fail at startup; nit AbortController listener growth) are operational polish, not security.

### Telegram rate-limit (HTTP 429) handling — end-to-end review

This was the most consequential review. **`Retry-After` is never read or honored anywhere**, and three P1 findings stack into a real self-DoS lever for an attacker who can induce per-chat throttling on a target bot. Worth addressing before 1.0.0:

- **P1 — Outbox dispatcher is globally serial.** `src/outbox.ts:128-139` pulls all eligible rows ordered by `id ASC` and processes sequentially under a single mutex. A 429 on chat A blocks every later row across every chat. Fix: shard the dispatcher per-bot (or per-chat).
- **P1 — `Retry-After` header is never parsed.** `src/telegram/client.ts:84-119` ignores both the HTTP `Retry-After` header and the Telegram error envelope's `parameters.retry_after`. Retries fire on a fixed exponential schedule capped at 30s (polling) / 60s (outbox), so when Telegram says "wait 60s" we hammer it 2-3× before the cooldown expires, _extending_ the throttle. Fix: parse on 429 in `client.api()`, surface on `TelegramError`, callers wait at least that long.
- **P1 — Streaming `fireAndForgetEdit` bypasses the outbox and has zero 429 awareness.** `src/streaming.ts:234-252` flushes every `edit_cadence_ms` (default 1500ms) and swallows errors with `.catch(() => undefined)`. A runner producing fast edits gets stuck pinging Telegram during cooldown. Fix: stretch cadence / pause flushes when 429 is observed.
- **P2 — No HTTP timeout on Telegram requests.** `src/telegram/client.ts:91-95` calls `fetch()` with no `signal` / `AbortController`. A stuck TCP connection hangs the entire dispatcher. Fix: `AbortSignal.timeout(30_000)`.
- **P2 — `max_attempts: 5` + 60s cap dead-letters within ~3 minutes.** A cooperative attacker who keeps a chat throttled longer than that permanently dead-letters legitimate replies, and the operator alert fires on a permanent failure that wasn't actually torana's fault. Fix: don't count `Retry-After`-respected waits against `attempt_count`.
- **P3 findings** (polling 429 ignores Retry-After; setWebhook startup 429 disables bot persistently; attachment 429 silently fails) are smaller variants of the same root cause and largely close once F2 lands.

The combination F1+F2+F3 is the wedge: yes, an attacker who can induce per-chat throttling has a workable self-DoS lever today. None of it loops infinitely-without-bound (every retry is bounded), but the user-visible wedge is real. **This is the single highest-leverage fix for 1.0.0.**

### Runner sandbox documentation review

Overall doc rating 3 / 5. Nothing actively misleading (no P1) but several gaps would let a hurried operator skip the isolation step. Two highest-leverage doc additions for 1.0.0:

- Add a top-level `## Runner isolation` section to `docs/security.md` stating _"torana does not sandbox runner subprocesses; the operator owns the boundary; `acknowledge_dangerous` is a documentation gate, not enforcement."_
- Add a "Concrete isolation patterns" sub-section to `docs/runners.md`: Docker with read-only bind mount + `--cap-drop=ALL`; firejail with profile; dedicated unprivileged UID + chroot; gVisor / Kata; on macOS `sandbox-exec`.

Smaller wording fixes in 4 other places (README "Safety defaults" omits the topic; `docs/runners.md` doesn't say `acknowledge_dangerous` is _non-enforcing_; `docs/configuration.md` could append "It does not change any runtime behavior"; the loader error message could append a doc link). These are all easy 1-line additions.

---

## Surfaces still NOT covered

The four-agent post-review covered alerts, polling, rate-limit, and sandbox-docs. Two surfaces from the original tracker remain unreviewed and are not blockers for rc.7:

- **`src/dashboard/*` — confirmed no such directory exists.** The dashboard surface is the proxy block in `main.ts:459-505` only, which the rc.7 P0 fix (`7f98ed3`) hardened. No additional review needed.
- **Runner sandbox internals at the OS / capability level.** This is correctly out of scope for torana — it's the runner's job, and the docs (once F4 + F5 land) will say so plainly.

---

## Recovery if you re-open this work

`git checkout rc.7/security-hardening` and you're back where this handoff started. Working tree is clean; everything is committed. Start with the "To cut rc.7" steps above. Memory-system entry (separate from this file) points here under the title "rc.7 security hardening".
