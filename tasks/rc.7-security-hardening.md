# rc.7 security hardening — handoff

**Branch:** `rc.7/security-hardening` (20 commits ahead of `main`, head pending — see "What's on the branch")
**Status:** All P0 + P1 + P2 fixes landed. Tests 1224 pass / 0 fail / 13 skip across 119 files. Typecheck clean.
**Not yet:** version bump, CHANGELOG section move, push, tag, release.

---

## What's on the branch

20 commits, oldest first:

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

The first commit (`4696b97`) is wide because it bundled `prettier --write` drift across `src/` + `test/` from the rc.6 tree. Logical changes there are confined to the files mentioned in its commit message; the rest is pure formatting. The rc.8 P2 commits (`bbc3098..54ab67f`) were originally authored on nine separate branches off `main`; cherry-picked into this branch with conflict resolution preserving the rc.7 P0/P1 contracts (notably the `attachment_mime_not_allowed` distinct response code from `03d22ed`, and the multi-line prettier-friendly formatting in the 6 conflicted test files where `query` was renamed to `_unsafeQuery`).

A final commit (pending) folds in prettier drift across `docs/` + scripts that surfaced after the cherry-picks, plus this tracker rewrite + the CHANGELOG P2 subsection.

---

## To cut rc.7 from this branch

1. **Bump version** in `package.json`: `1.0.0-rc.6` → `1.0.0-rc.7`.
2. **Move `## [Unreleased]`** in `CHANGELOG.md` to `## [1.0.0-rc.7] - <today>`.
3. **Commit** these two as a single "rc.7: cut" commit.
4. **Push** the branch: `git push -u origin rc.7/security-hardening`.
5. **Open a PR** into `main` (rc.6 went via PR #7 — same flow). The diff is large because of the prettier drift + the 9 folded-in P2 fixes; reviewer can lean on the per-commit messages and the CHANGELOG.
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

## P2 deferred items — five remain for rc.8 / 1.0.0

The original deep-review backlog had 15 P2 items. One was dropped on review (per-bot webhook secrets — the threat model didn't apply to torana's single-process architecture). Nine were folded into rc.7 (commits above). Five remain deferred:

1. **Outbox retry semantics under crash.** `src/outbox.ts:170-179` calls `markOutboxSent` AFTER the Telegram POST succeeds. A crash between success and bump replays the send → duplicate Telegram message. Inherent to at-least-once delivery without server-side idempotency, but worth mitigating: mark `in_flight` BEFORE send; on crash recovery, dedupe by tracking message-content hash.

2. **URL bot-token redactor regex requires trailing `/`.** `src/log.ts:50` `URL_BOT_TOKEN_RE`. Telegram file-URL truncations without trailing slash slip through. Belt-and-braces only because `bots[].token` is in `setSecrets`. Make trailing slash optional.

3. **Schema-string size cap.** `loadConfigFromString` (`src/config/load.ts:195`) skips `maxBytes`. No internal route accepts YAML strings from the network today, but if `/admin/config/preview` ever lands it inherits unbounded parse cost. Pass cap through.

4. **`yaml.load` schema pinning.** `src/config/load.ts:204` uses default schema (which is safe in js-yaml v4). Pin explicitly to `yaml.CORE_SCHEMA` so a future dep upgrade can't silently widen the type set.

5. **Recovery from an interpolation result that's > maxBytes.** `loadConfigFromFile` checks file size at `src/config/load.ts:157` but interpolation can expand the string (a single `${VAR}` reference resolving to MB of content). Re-check size after interpolation.

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
