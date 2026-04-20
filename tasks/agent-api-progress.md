# Agent API — implementation progress

Branch: `feat/agent-api` (off `main`)
Plan: [impl-agent-api.md](impl-agent-api.md) (2859 lines, 20 user stories)
Approach: **thin end-to-end first** — Claude-ask + inject (JSON and
multipart) round-trips are working and tested, and the four core CLI
subcommands (`ask`, `inject`, `turns get`, `bots list`) ship in Phase 6
core. Remaining work is breadth-wise: Codex/Command runners, Phase 6b
(profile store, `@-` stdin, skills install, codex plugin), Phase 7
(observability + docs).

## How to resume

1. `git checkout feat/agent-api` (tip: `f7aa077`, 11 commits ahead of `main`).
2. `bun test` — expect **530 pass / 4 skip / 0 fail**.
3. **Decision for next session:** pick from the three remaining branches.
   Phase 2b (Codex side-sessions, US-006) unblocks `torana ask` against
   non-Claude bots and is the clearest unblock. Phase 6b adds the
   profile store + `@-` stdin + skills install + codex plugin (the
   pieces deferred from Phase 6 core). Phase 7 finishes the release —
   metrics, doctor checks C009-C014 + R001-R003, docs/agent-api.md +
   docs/cli.md.
4. Every commit on this branch is self-contained — you can run tests
   at any point. If something's red, revert the tip commit; no rebase
   needed.
5. Commit cadence (durable — see memory): one phase commit, then a
   small follow-up that pins the hash into this tracker. Do not
   `--amend`.

Conventions in use on this branch:
- One commit per phase, with the exact US-xxx tag in the subject line.
- Test files colocated under `test/agent-api/` or `test/runner/`.
- Handlers live in `src/agent-api/handlers/`.
- bun:sqlite named-parameter binds use `$name` prefix (see
  `allocateSyntheticInbound` for the pattern).
- Agent-API DB writes use `db.transactionImmediate` (not `db.transaction`)
  so concurrent writers don't race on `MIN(telegram_update_id)`.
- Ask turns insert as `status='running'` so the dispatch loop never
  picks them up; inject turns use `status='queued'`.

---

## Phase tracker

| Phase | Status | User stories | Notes |
|---|---|---|---|
| 1 — Foundation | ✅ Complete (`c2b7cee`) | US-001 US-002 US-003 US-004 | Config + DB + /v1 routing + auth + runner iface stubs |
| 2a — ClaudeCodeRunner side-sessions | ✅ Complete (`117a9bb`) | US-005 | |
| 3 — Side-session pool | ✅ Complete (`24aec5b`) | US-008 | LRU + idle/hard TTL + orphan listeners |
| 4a — Ask + turns handlers | ✅ Complete (`94445a1`) | US-009 US-010 | Real `handleAsk`, `handleGetTurn`, `awaitSideTurn`, admin session endpoints |
| — End-to-end smoke | ✅ Complete (`94445a1`) | — | `test/agent-api/ask.test.ts` round-trips through mock claude binary |
| 4b — Inject path | ✅ Complete (`b09f746`) | US-011 US-012 | `user_chats` writer, chat resolver, marker wrap, `handleInject` + 23 tests |
| 5 — Cross-cutting (full) | ✅ Complete (`35b355d`) | US-013 US-014 | Multipart attachments + orphan-file sweep + `idempotency.ts` helpers + 32 tests |
| 6 — CLI core | ✅ Complete (`f7aa077`) | US-018 (partial) | `AgentApiClient` + `torana ask/inject/turns/bots` + 142 tests |
| 2b — CodexRunner side-sessions | ⏳ Pending | US-006 | Per-turn spawn with `codex exec resume` |
| 2c — CommandRunner side-sessions | ⏳ Pending | US-007 | Protocol capability descriptors |
| 6b — CLI follow-ups + skills | ⏳ Pending | US-018 (rest) US-019 US-020 | Profile store, `@-` stdin, `skills install`, Codex plugin |
| 7 — Observability + docs | ⏳ Pending | US-015 US-016 US-017 | Metrics histograms, doctor C009–C014 + R001–R003, docs/agent-api.md + cli.md + README |

---

## What's done — feat/agent-api branch (11 commits)

Commits (`git log --oneline feat/agent-api ^main`):

```
f7aa077 agent-api phase 6 (core): CLI ask/inject/turns/bots + AgentApiClient (US-018)
092046e agent-api: record Phase 6 scoping decision in progress tracker
dae65ea agent-api: pin Phase 5 commit hash in progress tracker
35b355d agent-api phase 5: multipart + orphan sweep (US-013, US-014)
bd2583c agent-api: pin Phase 4b commit hash in progress tracker
b09f746 agent-api phase 4b: inject path (US-011, US-012)
a8d3aa8 agent-api: rewrite progress tracker for session handoff
9c4a7e1 agent-api: update progress tracker — Phase 1–4a complete
94445a1 agent-api phase 4a: ask + turns handlers (US-009, US-010)
24aec5b agent-api phase 3: SideSessionPool (US-008)
117a9bb agent-api phase 2a: ClaudeCodeRunner side-sessions (US-005)
46b3ade agent-api: add progress tracker
c2b7cee agent-api phase 1: config + db + auth + runner iface stubs
```

**Full test suite: 530 pass / 4 skip / 0 fail.** End-to-end round-trips:
ask (JSON + multipart) through real HTTP → bearer auth →
SideSessionPool → ClaudeCodeRunner (mock binary) → response body in
[test/agent-api/ask.test.ts](../test/agent-api/ask.test.ts) +
[test/agent-api/ask.multipart.test.ts](../test/agent-api/ask.multipart.test.ts);
inject (JSON + multipart) through real HTTP → bearer auth → chat
resolve → `insertInjectTurn` → queued row + attachment paths persisted
in [test/agent-api/inject.test.ts](../test/agent-api/inject.test.ts) +
[test/agent-api/inject.multipart.test.ts](../test/agent-api/inject.multipart.test.ts).

---

### Commit `c2b7cee` — Phase 1 Foundation (US-001..US-004)

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

### Phase 1 tests

- [test/db/gateway-db.agent-api.test.ts](../test/db/gateway-db.agent-api.test.ts) — 13 tests
- [test/agent-api/auth.test.ts](../test/agent-api/auth.test.ts) — 8 tests
- [test/agent-api/router.test.ts](../test/agent-api/router.test.ts) — 13 tests (live server, now carries pool+orphans stubs after Phase 4a)
- [test/runner/side-session-stub.test.ts](../test/runner/side-session-stub.test.ts) — 6 tests
- [test/db/migrate.test.ts](../test/db/migrate.test.ts) extended with v1→v2 path
- Fixture updates (`test/fixtures/bots.ts` + 2 integration configs) for the new `agent_api` block.

---

### Commit `117a9bb` — Phase 2a: ClaudeCodeRunner side-sessions (US-005)

- [src/runner/claude-code.ts](../src/runner/claude-code.ts) — real side-session
  implementation. `sideSessions: Map<string, ClaudeSideSession>`; each
  entry owns a dedicated `RunnerEventEmitter`, `ClaudeNdjsonParser`, log
  file, subprocess. Key design points:
  - spawn argv = `[cli_path, ...protocolFlags, ...args, "--session-id", id]`.
  - `pumpSideStdout` / `pumpSideStderr` / `watchSideExit` run per-session;
    events dispatched by `dispatchSide(entry, ev)` go ONLY to that entry's
    emitter — never to the main `this.emitter`.
  - Ready gate: either the parser fires `{kind:"ready"}` or a `startupMs`
    setTimeout fallback fires. Either resolves `entry.readyPromise`.
  - `sendSideTurn` checks busy BEFORE readiness (so callers see "busy"
    rather than "not_ready" mid-turn). Sets `activeTurn` + `status="busy"`;
    `dispatchSide` clears both on done/error.
  - Unexpected subprocess exit → `fatal` on side emitter only; rejects a
    pending readyPromise; clears activeTurn.
  - `stopSideSession` coalesces concurrent calls via `stopPromise`;
    SIGTERM → (graceMs) → SIGKILL.
  - Spawn failure scrubs the map entry so retries don't see phantom state.
- [test/runner/claude-code.side-session.test.ts](../test/runner/claude-code.side-session.test.ts)
  — 10 cases. Invariants tested: id validation, double-start, onSide
  before start, main-vs-side event isolation, two concurrent sessions
  disjoint, busy serialization, stop/restart cycle, mid-turn crash
  isolation (main runner stays ready), spawn-failure cleanup.
- [test/runner/side-session-stub.test.ts](../test/runner/side-session-stub.test.ts)
  updated — ClaudeCodeRunner now reports `supportsSideSessions() === true`.

---

### Commit `24aec5b` — Phase 3: SideSessionPool (US-008)

- [src/agent-api/pool.ts](../src/agent-api/pool.ts) — per-gateway pool.
  - `acquire(botId, sessionId|null)` returns
    `ok | capacity | busy | runner_error | gateway_shutting_down |
    runner_does_not_support_side_sessions`.
  - Ephemeral path mints `eph-<uuid>`, auto-stops on release when inflight=0.
  - Keyed reuse: inflight=1 max; second acquire on same id while in-flight
    returns `busy`.
  - Keyed miss: per-bot + global cap check; LRU eviction of idle entries
    (bot-local preferred); pre-registers entry with inflight=1 BEFORE
    `await runner.startSideSession` so a concurrent same-id acquire can't
    double-spawn; scrubs + deletes DB row on spawn failure.
  - `release` is a no-op on missing entries (crash-safe during shutdown
    races); drops inflight; ephemeral+idle schedules stop; stopping+idle
    completes deferred hard-TTL teardown.
  - `startSweeper` / `stopSweeper` — 60s cadence; idle TTL reaps entries
    past `idle_ttl_ms` with inflight=0; hard TTL marks `stopping`
    regardless (drain inflight via release → scheduleStop).
  - `shutdown(graceMs)` parallel-stops all entries AND awaits
    `pendingBackgroundStops` so ephemeral auto-teardown can't escape the
    drain window. Post-shutdown acquires return `gateway_shutting_down`.
  - Startup reconciliation via `db.markAllSideSessionsStopped()`.
  - `listForBot(botId)` snapshot for the admin GET endpoint.
- [src/main.ts](../src/main.ts) — constructs pool when `agent_api.enabled`;
  wires `pool.startSweeper()` and `pool.shutdown(runnerGraceMs)` into the
  startup/shutdown sequence (before main runner stopAll).
- [test/agent-api/pool.test.ts](../test/agent-api/pool.test.ts) — 14 tests
  with a FakeRunner (no real subprocesses): acquire (ephemeral, reuse,
  busy, unsupported, spawn-failure), caps + LRU, idle + hard TTL sweeps
  with fake clock, release crash-safety, shutdown ordering.

---

### Commit `94445a1` — Phase 4a: Ask + turns handlers (US-009, US-010)

- [src/agent-api/schemas.ts](../src/agent-api/schemas.ts) — zod
  `AskBodySchema`, `InjectBodySchema` + regex consts (`SESSION_ID_RE`,
  `SOURCE_LABEL_RE`, `IDEMPOTENCY_KEY_RE`), `validateIdempotencyKey`.
- [src/agent-api/handlers/ask.ts](../src/agent-api/handlers/ask.ts) —
  full handler. Flow: parse body → zod validate → runner supports
  check → clamp timeout_ms → `pool.acquire` (maps result to 429/500/
  501/503) → `db.insertAskTurn` (status='running' from start) →
  `awaitSideTurn` subscribes to `onSide(done|error|fatal|text_delta)`
  with timeout → on done: `setTurnFinalText` + 200 body; on timeout:
  `orphans.attach` + 202 (transfers pool-release ownership); on error:
  `completeTurn(err)` + 500 with `X-Torana-Retriable` header; on fatal:
  `pool.stop` + 503 + `completeTurn(err)`. Exactly one of
  (handler-finally, orphan-listener-terminal) calls `pool.release`.
- [src/agent-api/orphan-listeners.ts](../src/agent-api/orphan-listeners.ts)
  — `OrphanListenerManager`. `attach(runner, botId, sessionId, turnId,
  backstopMs?)` subscribes to terminal events; applies them to the
  `turns` row; calls `pool.release`. 1h backstop timer. `shutdown()`
  force-releases all pending registrations so `pool.shutdown` can drain.
- [src/agent-api/handlers/turns.ts](../src/agent-api/handlers/turns.ts) —
  timing-safe `handleGetTurn`: auth runs BEFORE db lookup; missing /
  cross-caller / telegram-origin turns all return identical 404
  `turn_not_found`. Body by status: queued/running → `in_progress`;
  completed → `done` with text/usage/duration, or 410 if older than
  24h; failed/dead → `failed` + error_text; interrupted → `failed` +
  "interrupted_by_gateway_restart".
- [src/agent-api/handlers/sessions.ts](../src/agent-api/handlers/sessions.ts)
  — `handleListSessions` (live pool snapshot), `handleDeleteSession`
  (`pool.stop` + 204, or 404 if session not in pool).
- [src/agent-api/router.ts](../src/agent-api/router.ts) — wires real
  handlers; `AgentApiRouterDeps` extends `AgentApiDeps` with `pool` and
  `orphans`.
- [src/main.ts](../src/main.ts) — constructs `SideSessionPool` +
  `OrphanListenerManager` when enabled; starts pool sweeper +
  idempotency sweeper (hourly); shutdown order: idempotency timer →
  unregister routes → transports → outbox → streaming → **orphans.shutdown()**
  → **pool.shutdown()** → registry.stopAll → server → db.
- [test/runner/fixtures/claude-mock.ts](../test/runner/fixtures/claude-mock.ts)
  gained a `slow-echo` mode (500ms delay before `result`) so concurrency
  tests are deterministic.
- [test/agent-api/ask.test.ts](../test/agent-api/ask.test.ts) — 7 real
  HTTP + real runner round-trip tests. Happy path returns "echo: hello";
  keyed session reuses one subprocess; invalid body → 400; bad
  session_id regex → 400; `crash-on-turn` mock → 503 runner_fatal; two
  concurrent asks on same session_id → [200, 429] side_session_busy;
  GET /v1/turns/:id after done returns the cached text.

---

### Phase 4b: Inject path (US-011, US-012)

- [src/core/process-update.ts](../src/core/process-update.ts) — after
  `insertUpdate` succeeds on an authorized message, call
  `db.upsertUserChat(botId, String(fromUserId), chatId)` inside the
  same transaction. Unauthorized senders are not recorded.
- [src/agent-api/chat-resolve.ts](../src/agent-api/chat-resolve.ts) —
  `resolveChatId(db, botId, {user_id?, chat_id?})`. Errors: `missing_target`,
  `user_not_opened_bot`, `chat_not_permitted`. `chat_id` is checked
  first against `listUserChatsByBot(botId)` so caller-supplied chats
  must be known to this bot.
- [src/agent-api/marker.ts](../src/agent-api/marker.ts) —
  `wrapInjected(text, source)` → `[system-injected from "<source>"]\n\n<text>`.
  Framing only — no sanitization (inject callers are trusted via bearer token).
- [src/agent-api/handlers/inject.ts](../src/agent-api/handlers/inject.ts)
  — full handler. Ordering: key validate → idempotency replay (early
  return before body parse — spec §6.4 says the body is ignored on
  replay) → zod body parse (refine message mapped to typed
  `missing_target`) → chat resolve → ACL re-check (`isAuthorized`) →
  `marker.wrap` → `db.insertInjectTurn` (handles in-txn dedup; returns
  `{replay, turnId}`) → `registry.dispatchFor(botId)` → 202 with
  `status: queued | in_progress` (re-reads row after dispatch). When
  the caller passes `chat_id` only, ACL lookup walks `user_chats`
  backwards to find the user associated with that chat.
- [src/agent-api/router.ts](../src/agent-api/router.ts) — inject route
  wired to real handler (replacing the 501 stub).
- [test/core/process-update.user-chats.test.ts](../test/core/process-update.user-chats.test.ts)
  — 3 tests (first DM, chat-id migration, unauthorized sender not
  recorded).
- [test/agent-api/chat-resolve.test.ts](../test/agent-api/chat-resolve.test.ts)
  — 7 unit tests covering all err codes + both resolution modes.
- [test/agent-api/inject.test.ts](../test/agent-api/inject.test.ts)
  — 13 HTTP integration tests. Happy paths: `user_id` + `chat_id`
  pass-through. Validation: missing/malformed Idempotency-Key,
  missing_target, bad source regex, malformed JSON. Resolution:
  user_not_opened_bot, chat_forgery (403 chat_not_permitted),
  acl_bypass (403 target_not_authorized). Idempotency: body-ignored
  replay returns same turn_id, different key creates new turn.
  Scope enforcement: ask-only token → 403 scope_not_permitted.

---

### Phase 5: Multipart + idempotency full (US-013, US-014)

- [src/agent-api/attachments.ts](../src/agent-api/attachments.ts) —
  `parseMultipartRequest` (per-file cap, aggregate cap via
  Content-Length + summed sizes, count cap, MIME allowlist, disk-usage
  cap, gateway-controlled filenames under
  `<data_dir>/attachments/<botId>/agentapi-<uuid>-<idx><ext>`);
  `cleanupFiles` best-effort unlink; `sweepUnreferencedAgentApiFiles`
  orphan-file sweep (skips non-`agentapi-*` files; age-gated to avoid
  reaping in-flight writes).
- [src/agent-api/idempotency.ts](../src/agent-api/idempotency.ts) —
  re-exports the key validator from schemas for call-site clarity;
  `sweepIdempotencyRows` wrapper that swallows transient DB errors.
- [src/agent-api/handlers/inject.ts](../src/agent-api/handlers/inject.ts)
  + [src/agent-api/handlers/ask.ts](../src/agent-api/handlers/ask.ts)
  — both detect `multipart/form-data` and route through
  `parseMultipartRequest`. File-lifecycle discipline: writes happen
  BEFORE the DB transaction; any failure (zod validation, chat resolve,
  ACL re-check, runner precheck, pool failure, DB throw, in-txn
  replay) triggers `cleanupFiles` before return.
- [src/main.ts](../src/main.ts) — `sweepUnreferencedAgentApiFiles`
  wired onto the hourly timer (agent-api-gated); cleared on shutdown.
- Tests (32 new):
  - [test/agent-api/attachments.test.ts](../test/agent-api/attachments.test.ts)
    — 14 tests: multipart happy paths, all rejection paths
    (wrong content-type, count cap, per-file cap, content-length cap,
    aggregate cap without Content-Length, bad MIME, disk cap), path
    safety (`../../etc/passwd` ignored), `cleanupFiles` tolerates
    missing files, orphan sweep (referenced/young/old matrix, missing
    root).
  - [test/agent-api/inject.multipart.test.ts](../test/agent-api/inject.multipart.test.ts)
    — 7 integration tests: PDF happy path, file cleanup on bad-MIME /
    missing-target / ACL-bypass / too-many-files, idempotent replay
    disposes of second-call's new file, key NOT consumed by pre-commit
    errors.
  - [test/agent-api/ask.multipart.test.ts](../test/agent-api/ask.multipart.test.ts)
    — 3 integration tests with real runner: PNG happy path (attachment
    path on turn row, file on disk, runner sees `[Attached file: ...]`
    suffix), bad MIME rejection cleanup, zod-after-parse cleanup.
  - [test/agent-api/idempotency.test.ts](../test/agent-api/idempotency.test.ts)
    — 8 tests: validator boundary cases, sweep deletes old / keeps
    fresh, swallow-error wrapper.

**Known gap:** multipart ask path with a happy-path attachment is
wired but only lightly tested — the mock claude binary echoes its
input rather than opening the file, so "runner actually reads the
bytes" remains unverified. Real-claude E2E covers this in soak.

---

### Commit `f7aa077` — Phase 6 core: CLI + AgentApiClient (US-018)

- [src/agent-api/client.ts](../src/agent-api/client.ts) — typed
  `AgentApiClient` with `listBots`/`ask`/`inject`/`getTurn`/
  `listSessions`/`deleteSession`. Constructs JSON or multipart bodies
  based on file presence; maps every non-2xx into a typed
  `AgentApiError` whose `.code` mirrors `errors.ts`. `network` and
  `malformed_response` codes added for transport-level failures.
  `fetchImpl` injectable for tests.
- [src/cli/shared/args.ts](../src/cli/shared/args.ts) — `extractChain`
  + `parseFlags` (two-pass), `resolveCredentials` (flag > env),
  `COMMON_FLAGS`. `CliUsageError` propagates to dispatch loop for
  exit-2 mapping.
- [src/cli/shared/exit.ts](../src/cli/shared/exit.ts) — `ExitCode`
  enum (success/internal/badUsage/authFailed/notFound/serverError/
  timeout/capacity) + `exitCodeFor(code, status?)` covering every
  current `AgentApiErrorCode` plus an HTTP-status-class fallback for
  unknown future codes.
- [src/cli/shared/output.ts](../src/cli/shared/output.ts) — `Rendered`
  shape + `renderJson`/`renderText`/`formatTable`/`emit` so subcommand
  bodies are testable without `process.stdout` mocking.
- [src/cli/shared/files.ts](../src/cli/shared/files.ts) — `readFileForUpload`
  used by both `ask` and `inject` for `--file PATH` (extension-based
  MIME guess; relies on the gateway allowlist for the actual reject).
- [src/cli/{ask,inject,turns,bots}.ts](../src/cli) — the four
  subcommands. Each returns a `Rendered`. Inject auto-generates an
  Idempotency-Key when omitted (printed to stderr as a `# comment`
  so callers can reuse it on retry; the auto-key notice is preserved
  even when the API call errors). Ask uses **exit 6 (timeout)** when
  the server returns 202 and prints the `turn_id` on stdout for
  piping into `torana turns get`.
- [src/cli.ts](../src/cli.ts) — dispatcher peeks at argv[0]; routes
  ask/inject/turns/bots to the new modules. Legacy `parseArgs` export
  is unmodified so existing test imports (`test/cli/cli.test.ts`)
  keep working. `--help` short-circuits BEFORE credential resolution
  so users can read help without env vars set.

**Tests added (142):**
- [test/cli/args.test.ts](../test/cli/args.test.ts) — 24 tests:
  extractChain coverage, parseFlags bool/value/values + short + `--`
  + every error path, resolveCredentials precedence + missing-flag.
- [test/cli/exit.test.ts](../test/cli/exit.test.ts) — 28 tests:
  every code mapped + status fallback for unknown future codes.
- [test/cli/output.test.ts](../test/cli/output.test.ts) — 8 tests:
  padRight, renderJson, renderText, formatTable.
- [test/agent-api/client.test.ts](../test/agent-api/client.test.ts)
  — 22 tests: URL normalization, Authorization header, listBots
  happy + 401, ask JSON/multipart/202/503, network failure, malformed
  JSON, non-JSON 5xx, inject Idempotency-Key forwarding (JSON +
  multipart) + 403, getTurn in_progress/done/failed/410,
  listSessions/deleteSession + 404, bot_id slash percent-encoding.
- [test/cli/{ask,inject,turns,bots}.cmd.test.ts](../test/cli) — 40
  function-level tests with a fake AgentApiClient: happy paths,
  --json, all usage errors, all exit-code-mapped server errors,
  --help short-circuit.
- [test/cli/dispatch.test.ts](../test/cli/dispatch.test.ts) — 15
  subprocess round-trip tests: `bun run src/cli.ts <subcmd>` against
  a real in-process gateway with the claude-mock runner. Exit-code
  mapping verified end-to-end (success, badUsage, authFailed,
  notFound, capacity), TORANA_SERVER + TORANA_TOKEN env path, --help
  works without credentials, legacy `version` subcommand still works.

**Phase 6 core deliberately excludes** (deferred to Phase 6b):
profile store (`~/.config/torana/config.toml`), `--file @-` stdin
support, `torana skills install`, codex plugin layout, `torana doctor
--profile X` remote checks. The progress tracker §how-to-resume
calls these out so the next session can pick up cleanly.

---

## What's left

### Immediate next chunk — two options

**Option A — close the inject e2e gap** (~1 day)
Add `test/integration/agent-api/inject.round-trip.test.ts` modeled on
`test/integration/round-trip.test.ts`: seed user_chats, issue inject,
verify main-runner dispatch → streaming → outbox → FakeTelegram
delivery. Raises confidence on inject delivery from ~40% to ~80%
without waiting for the CLI.

**Option B — keep breadth momentum** (Phase 2b or Phase 6)
Phase 2b (Codex side-sessions) unblocks `torana ask` against non-
claude bots. Phase 6 (CLI + skills) is what most users interact with
and also provides a natural e2e harness.

### Remaining phases

1. **Phase 2b — CodexRunner side-sessions** ([impl plan §4.2](impl-agent-api.md))
   - Per-turn spawn of `codex exec [resume <threadId>] --json`; capture
     `thread.started` event; reuse `threadId` on subsequent turns.

2. **Phase 2c — CommandRunner side-sessions** ([impl plan §4.3](impl-agent-api.md))
   - Protocol capability descriptors; `claude-ndjson` → long-lived side session
     with `session` envelope field; `codex-jsonl` → per-turn spawn; `jsonl-text`
     → unsupported. Wire envelope tagging through the parser.
   - Example runner at `examples/side-session-runner/`.

3. **Phase 6 — CLI + skills** ([impl plan §8](impl-agent-api.md))
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

4. **Phase 7 — Observability + doctor + docs** ([impl plan §9](impl-agent-api.md))
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
