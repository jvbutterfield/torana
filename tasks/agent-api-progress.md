# Agent API — implementation progress

Branch: `feat/agent-api` (off `main`)
Plan: [impl-agent-api.md](impl-agent-api.md) (2859 lines, 20 user stories)
Approach: **thin end-to-end first** — Claude-ask round-trip working, then
widen breadth-wise. Inject, Codex/Command runners, CLI, skills, docs come
after the first ask works against a real binary.

---

## Phase tracker

| Phase | Status | User stories | Notes |
|---|---|---|---|
| 1 — Foundation | ✅ Complete (`c2b7cee`) | US-001 US-002 US-003 US-004 | Config + DB + /v1 routing + auth + runner iface stubs |
| 2a — ClaudeCodeRunner side-sessions | ✅ Complete (`117a9bb`) | US-005 | |
| 3 — Side-session pool | ✅ Complete (`24aec5b`) | US-008 | LRU + idle/hard TTL + orphan listeners |
| 4a — Ask + turns handlers | ✅ Complete (`94445a1`) | US-009 US-010 | Real `handleAsk`, `handleGetTurn`, `awaitSideTurn`, admin session endpoints |
| — End-to-end smoke | ✅ Complete (`94445a1`) | — | `test/agent-api/ask.test.ts` round-trips through mock claude binary |
| 4b — Inject path | ⏳ Next (recommended) | US-011 US-012 | Requires process-update writes to user_chats, marker wrapping |
| 5 — Cross-cutting (full) | ⏳ Pending | US-013 US-014 | Multipart attachments + idempotency + orphan-file sweep |
| 2b — CodexRunner side-sessions | ⏳ Pending | US-006 | Per-turn spawn with `codex exec resume` |
| 2c — CommandRunner side-sessions | ⏳ Pending | US-007 | Protocol capability descriptors |
| 6 — CLI + skills | ⏳ Pending | US-018 US-019 US-020 | `torana ask/inject/turns/bots/config/skills install` + Claude + Codex skill packages |
| 7 — Observability + docs | ⏳ Pending | US-015 US-016 US-017 | Metrics histograms, doctor C009–C014 + R001–R003, docs/agent-api.md + cli.md + README |

---

## What's done (commit `c2b7cee` on feat/agent-api)

### US-001 — Config schema ✅
- [src/config/schema.ts](../src/config/schema.ts): `AgentApiSchema` (tokens, side_sessions, inject, ask)
  added; `AgentApiTokenConfig` + `AgentApiConfig` exported; `SECRET_PATHS`
  extended with `agent_api.tokens[].secret_ref`; superRefine validates unknown
  bot refs, dup token names, TTL/cap inversion.
- [src/config/load.ts](../src/config/load.ts): `ResolvedAgentApiToken` (raw secret + SHA-256 hash),
  `LoadedConfig.agentApiTokens` + `.warnings`; `collectSecrets` includes tokens;
  literal-token warning emitted for non-`${VAR}` secret_refs.

### US-002 — SQLite migration ✅
- [src/db/migrations/0002_agent_api.sql](../src/db/migrations/0002_agent_api.sql): new tables (`user_chats`,
  `agent_api_idempotency`, `side_sessions`) + 7 nullable columns on `turns`
  (`source`, `agent_api_token_name`, `agent_api_source_label`, `final_text`,
  `idempotency_key`, `usage_json`, `duration_ms`) + supporting indexes.
- [src/db/schema.sql](../src/db/schema.sql): fresh-install version includes v2 tables/columns.
- [src/db/migrate.ts](../src/db/migrate.ts): `TARGET_VERSION=2`; `planMigration` emits multi-step
  plans for v0→v2; `snapshotOnAnyUpgrade` helper (back-compat alias for
  `snapshotV0Upgrade`); snapshot path is `<db>.pre-v<target>`.
- [src/db/gateway-db.ts](../src/db/gateway-db.ts):
  - 16 new prepared statements.
  - `transactionImmediate<T>(fn)` helper.
  - `upsertUserChat`, `getLastChatForUser`, `listUserChatsByBot`.
  - `getIdempotencyTurn`, `sweepIdempotency` (threshold in ms since epoch).
  - `upsertSideSession`, `markSideSessionState`, `deleteSideSession`,
    `listSideSessions`, `markAllSideSessionsStopped`.
  - `insertAskTurn` (status='running' from the start — isolates from dispatch loop).
  - `insertInjectTurn` (idempotency check in-transaction, returns `{replay, turnId}`).
  - `setTurnFinalText(turnId, finalText, usageJson, durationMs)`.
  - `getTurnExtended(turnId)` returns the full turn + joined inbound payload.
  - `getTurnText` extended to read `payload.prompt` for inject rows.
  - `allocateSyntheticInbound` private helper using `$bot_id` / `$chat_id` /
    `$from_user_id` / `$payload_json` named binds (bun:sqlite requires `$` prefix).

### US-003 — /v1 router + bearer auth ✅
- [src/transport/types.ts](../src/transport/types.ts): `HttpMethod = "GET" | "POST" | "DELETE"`,
  `HttpRouter.route` accepts the widened type.
- [src/server.ts](../src/server.ts): dispatcher recognizes DELETE.
- [src/agent-api/types.ts](../src/agent-api/types.ts): `AgentApiDeps`, `AuthedHandler`, `Scope`,
  `AuthSuccess`, `AuthFailure`.
- [src/agent-api/errors.ts](../src/agent-api/errors.ts): 27 canonical error codes → HTTP status map;
  `errorResponse(code, message?, extra?)`, `jsonResponse(status, body, headers?)`,
  `mapAuthFailure(a)`.
- [src/agent-api/auth.ts](../src/agent-api/auth.ts): `authenticate(tokens, header)` — SHA-256 +
  `timingSafeEqual`; `authorize(token, botId, scope)`.
- [src/agent-api/router.ts](../src/agent-api/router.ts):
  - `registerAgentApiHealthRoute(router, deps)` — `/v1/health` public.
  - `registerAgentApiRoutes(router, deps)` — `/v1/bots/:bot_id/{ask,inject}`,
    `/v1/turns/:turn_id`, `/v1/bots`, `/v1/bots/:bot_id/sessions`,
    `DELETE /v1/bots/:bot_id/sessions/:session_id`.
  - `authed(deps, scope, handler)` runs `unknown_bot → authenticate → authorize`
    before handler.
  - Turn-read handler returns identical 404 for (nonexistent / telegram-origin /
    other caller's) turn to prevent enumeration.
  - Bot-list handler filters to token's `bot_ids`.
  - Phase 1 handlers are stubs; real bodies in Phase 4.
- [src/main.ts](../src/main.ts): `registerAgentApiHealthRoute` always; `registerAgentApiRoutes`
  only when `config.agent_api.enabled`; routes unregistered first during shutdown.
- [src/cli.ts](../src/cli.ts): `start` subcommand threads `agentApiTokens` + `warnings`
  through to `startGateway`.

### US-004 — Runner side-session interface ✅
- [src/runner/types.ts](../src/runner/types.ts): `AgentRunner` gains `supportsSideSessions()`,
  `startSideSession(id)`, `sendSideTurn(id, turnId, text, attachments)`,
  `stopSideSession(id, graceMs?)`, `onSide(id, event, handler)`. Typed errors:
  `RunnerDoesNotSupportSideSessions`, `SideSessionAlreadyExists`,
  `SideSessionNotFound`, `InvalidSideSessionId`. `SIDE_SESSION_ID_REGEX` +
  `validateSideSessionId(id)`.
- All three concrete runners (Claude, Codex, Command) stub everything to
  unsupported. Phase 2 replaces per runner.

### Tests ✅ — 40 new, full suite 292 pass / 0 fail

- [test/db/gateway-db.agent-api.test.ts](../test/db/gateway-db.agent-api.test.ts) — 13 tests
- [test/agent-api/auth.test.ts](../test/agent-api/auth.test.ts) — 8 tests
- [test/agent-api/router.test.ts](../test/agent-api/router.test.ts) — 13 tests (live server)
- [test/runner/side-session-stub.test.ts](../test/runner/side-session-stub.test.ts) — 6 tests
- [test/db/migrate.test.ts](../test/db/migrate.test.ts) extended with v1→v2 path
- Fixture updates (`test/fixtures/bots.ts` + 2 integration configs) for the new `agent_api` block.

---

## What's left

### Immediate next chunk (thin end-to-end for Claude-ask)

1. **Phase 2a — ClaudeCodeRunner side-sessions** ([impl plan §4.1](impl-agent-api.md))
   - [src/runner/claude-code.ts](../src/runner/claude-code.ts) — add `ClaudeSideSession` map, pump per-session
     stdout/stderr via `createClaudeNdjsonParser` per session, per-session
     `RunnerEventEmitter`, crash isolation from main runner, SIGTERM→SIGKILL
     stopSideSession path, `--session-id <id>` argv extension.
   - Tests: main+side event isolation, two concurrent side sessions disjoint,
     spawn-failure cleanup, unexpected exit → fatal on side only, invalid id,
     double-start rejection.

2. **Phase 3 — SideSessionPool** ([impl plan §5](impl-agent-api.md))
   - [src/agent-api/pool.ts](../src/agent-api/pool.ts) — `acquire(botId, sessionId | null)`, ephemeral
     UUID path, keyed reuse with `inflight=1` serialization, per-bot + global
     caps with LRU eviction, idle + hard TTL sweepers, pre-register-then-rollback
     on spawn failure, `shutdown(graceMs)` awaits all `stopPromise`s, startup
     reconciliation via `db.markAllSideSessionsStopped()`.
   - [src/main.ts](../src/main.ts) — construct pool when enabled; wire into shutdown before
     runner.stopAll.
   - Tests: acquire/reuse/miss, caps+LRU, TTL sweeps with fake clock, release
     bookkeeping, shutdown race, spawn-failure cleanup.

3. **Phase 4a — Ask handler** ([impl plan §6.1 §6.2](impl-agent-api.md))
   - [src/agent-api/handlers/ask.ts](../src/agent-api/handlers/ask.ts) — real body: zod `AskBodySchema`, clamp
     `timeout_ms`, `pool.acquire`, `db.insertAskTurn`, `awaitSideTurn` subscriber,
     `setTurnFinalText` on done, orphan-listener on timeout, `pool.release` in
     finally, 202 on timeout, 500/503 on error/fatal, 429 capacity/busy.
   - [src/agent-api/orphan-listeners.ts](../src/agent-api/orphan-listeners.ts) — detached completion tracker;
     1h backstop; shutdown releases all.
   - [src/agent-api/handlers/turns.ts](../src/agent-api/handlers/turns.ts) — real `handleGetTurn` body by status
     (in_progress / done / failed / expired-410 / interrupted-as-failed).
   - [src/agent-api/schemas.ts](../src/agent-api/schemas.ts) — `AskBodySchema`, regex consts,
     `validateIdempotencyKey`.
   - Extend router to wire handlers + real `handleListSessions` from pool.
   - Tests: sync happy path, slow→timeout→poll→done, runner_error, runner_fatal
     tears down session, capacity-429, session-busy-429,
     runner_does_not_support_side_sessions, turn-read expired-410, turn-read
     timing-safe 404.

4. **End-to-end smoke** — manual: start gateway with `agent_api.enabled=true`,
   curl `POST /v1/bots/:id/ask`, verify response. Automate as
   [test/integration/agent-api/ask.round-trip.test.ts](../test/integration/agent-api/ask.round-trip.test.ts) against a fake claude binary
   fixture that already exists in the test suite.

### After end-to-end works (widen)

5. **Phase 4b — Inject path** ([impl plan §6.3 §6.4](impl-agent-api.md))
   - [src/core/process-update.ts](../src/core/process-update.ts) — `db.upsertUserChat(botId, userId, chatId)`
     after authorized inbound insertUpdate.
   - [src/agent-api/chat-resolve.ts](../src/agent-api/chat-resolve.ts) — resolve `user_id | chat_id` against
     `user_chats` + ACL re-check.
   - [src/agent-api/marker.ts](../src/agent-api/marker.ts) — `wrap(text, source)` →
     `[system-injected from "<source>"]\n\n<text>`.
   - [src/agent-api/handlers/inject.ts](../src/agent-api/handlers/inject.ts) — real body: Idempotency-Key required,
     idempotency replay short-circuits before file writes, chat resolve, ACL,
     `db.insertInjectTurn`, `registry.dispatchFor(botId)`.
   - Registry exposes `dispatchFor(botId)`; Bot gains `enqueueProgrammaticTurn`
     thin wrapper if tests need it. Tests in `test/agent-api/inject.*`.

6. **Phase 5 — Multipart + idempotency full** ([impl plan §7](impl-agent-api.md))
   - [src/agent-api/attachments.ts](../src/agent-api/attachments.ts) — `parseMultipartRequest` with
     per-file + aggregate + count caps + MIME allowlist + disk-usage cap;
     gateway-controlled on-disk filenames under
     `<data_dir>/attachments/<botId>/agentapi-<uuid>-<idx><ext>`; rollback on
     DB failure OR idempotent replay (files were written optimistically);
     orphan-file sweep (unreferenced >24h).
   - [src/agent-api/idempotency.ts](../src/agent-api/idempotency.ts) — key format validator; the actual
     dedup write is already in-transaction in `insertInjectTurn`; sweeper
     timer wired into `main.ts`.

7. **Phase 2b — CodexRunner side-sessions** ([impl plan §4.2](impl-agent-api.md))
   - Per-turn spawn of `codex exec [resume <threadId>] --json`; capture
     `thread.started` event; reuse `threadId` on subsequent turns.

8. **Phase 2c — CommandRunner side-sessions** ([impl plan §4.3](impl-agent-api.md))
   - Protocol capability descriptors; `claude-ndjson` → long-lived side session
     with `session` envelope field; `codex-jsonl` → per-turn spawn; `jsonl-text`
     → unsupported. Wire envelope tagging through the parser.
   - Example runner at `examples/side-session-runner/`.

9. **Phase 6 — CLI + skills** ([impl plan §8](impl-agent-api.md))
   - Rewrite `src/cli.ts` as a dispatcher; split subcommands into `src/cli/`:
     `ask.ts`, `inject.ts`, `turns.ts`, `bots.ts`, `config.ts`, `skills.ts`,
     plus `shared/{args,output,exit}.ts`.
   - [src/agent-api/client.ts](../src/agent-api/client.ts) — typed `AgentApiClient` (listBots, ask, inject,
     getTurn, listSessions, deleteSession); re-export from package entry so
     external TS code can import.
   - `~/.config/torana/config.toml` profile store (Bun.TOML, mode 0600).
   - `@-` stdin file support; auto-generated `--idempotency-key` for inject.
   - [skills/torana-ask/SKILL.md](../skills/torana-ask/SKILL.md), [skills/torana-inject/SKILL.md](../skills/torana-inject/SKILL.md) — frontmatter
     with `allow_implicit_invocation: true` (Codex-specific; Claude ignores).
   - [codex-plugin/](../codex-plugin/) layout + `marketplace.json`; [scripts/install-skills.ts](../scripts/install-skills.ts);
     [scripts/check-skill-parity.ts](../scripts/check-skill-parity.ts) enforced in CI.

10. **Phase 7 — Observability + doctor + docs** ([impl plan §9](impl-agent-api.md))
    - [src/metrics.ts](../src/metrics.ts) — `AgentApiCounters` + `AgentApiGauges` + minimal
      `HistogramState` primitive; `incAgentApi`, `setAgentApiGauge`,
      `observeAgentApiRequestDuration`, `observeAgentApiAcquireDuration`.
      `renderPrometheus` extended.
    - [src/doctor.ts](../src/doctor.ts) — C009 (enabled-but-no-tokens, warn), C010 (unknown
      bot_ids, fail), C011 (ask-scope on non-side-session-capable runner, fail),
      C012 (empty secret_ref after interpolation, fail), C013 (TTL/cap
      defence-in-depth, fail), C014 (localhost binding warning, warn);
      R001–R003 (remote health / bots / TLS) under `torana doctor --profile`.
    - [docs/agent-api.md](../docs/agent-api.md) ~2000 words; [docs/cli.md](../docs/cli.md) reference; update
      `docs/security.md`, `docs/configuration.md`, `docs/runners.md`,
      `docs/writing-a-runner.md`; [README.md](../README.md) non-goal removal + feature
      list + Mermaid diagram.
    - Link-check CI step; `grep -rn "Agent-to-agent messaging"` → 0 matches.

### Soak + security (pre-release)

- `AGENT_API_E2E=1 bun test` against real claude + codex binaries.
- `AGENT_API_SOAK=1 bun test` — 24h run.
- Security matrix ([impl plan §12.5](impl-agent-api.md)) — 25+ tests across
  auth, authz, input validation, resource exhaustion, injection, disclosure.
- Error-path coverage matrix ([impl plan §12.10](impl-agent-api.md)) — every
  error code in `src/agent-api/errors.ts` exercised by at least one test.

### Release

- CHANGELOG entry; bump version; extend `package.json` `files` to include
  `skills/`, `codex-plugin/`, `scripts/install-skills.ts`.
- Extend [scripts/build.ts](../scripts/build.ts) to copy skills into `codex-plugin/` and render
  `plugin.json` with version.
- Extend docker smoke test to probe skill files.

---

## Deferred decisions / open questions

These surfaced during Phase 1 and want resolution before the related
phase lands. Listed here so they don't get lost.

- **Session-id sharing across tokens** ([impl plan §13 risk 12](impl-agent-api.md)) —
  key is `(bot_id, session_id)`. If two callers use the same session_id they
  share context. Doc-only fix in v1; may key by `(bot_id, token_name,
  session_id)` in a future version.
- **Claude CLI flag name** ([impl plan §13 risk 1](impl-agent-api.md)) — verify
  `--session-id` vs `--session <id>` on the current `claude` binary during
  Phase 2a; fall back to `CLAUDE_CONFIG_DIR` if needed.
- **Bun.TOML availability** ([impl plan §15 q2](impl-agent-api.md)) — confirm
  during Phase 6; add `@iarna/toml` only if the Bun version we target
  doesn't ship it.
- **Per-session concurrency=1** ([impl plan §5 rule 2](impl-agent-api.md)) —
  fixed at 1 for v1; revisit if users hit 429 side_session_busy in practice.
