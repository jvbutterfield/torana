# Agent API — implementation progress

Branch: `feat/agent-api` (off `main`)
Plan: [impl-agent-api.md](impl-agent-api.md) (2859 lines, 20 user stories)
Approach: **thin end-to-end first** — Claude + Codex ask paths (JSON +
multipart), inject path (with FakeTelegram delivery proof), the four
core CLI subcommands (`ask`, `inject`, `turns get`, `bots list`), and
now the full Phase 7 observability + doctor + docs surface all work
today. Remaining work is breadth/polish: Phase 6b (profile store, `@-`
stdin, skills install, codex plugin) and Phase 2c (CommandRunner
side-sessions, lower priority).

## How to resume

1. `git checkout feat/agent-api` (last phase commit `23abefd` — Phase 7; 22 commits ahead of `main`).
2. Sanity-check before touching anything:
   - `bun test` — expect **691 pass / 4 skip / 0 fail**.
   - `bun x tsc --noEmit` — expect clean (no output).
3. **Pick the next branch (durable note — Phase 7 just landed):**
   - **Phase 6b (CLI polish, RECOMMENDED)** — profile store
     (`~/.config/torana/config.toml`), `--file @-` stdin, `torana skills
     install --host=claude|codex`, codex plugin layout, the
     `torana doctor --profile NAME` resolver (remote R001–R003 already
     land in Phase 7; only the profile-name-to-(server,token) lookup is
     missing — CLI currently exits 2 with a Phase-6b pointer when
     `--profile` is passed). Pure UX; no gateway-side risk; ~1 day.
   - **Phase 2c (CommandRunner side-sessions)** — protocol capability
     descriptors; `claude-ndjson` long-lived + `codex-jsonl` per-turn +
     `jsonl-text` unsupported. Only matters for users with custom
     runners; safe to defer.
   - **Pre-release validation** — after 6b (and optionally 2c),
     `AGENT_API_E2E=1 bun test` against real binaries, a 24h
     `AGENT_API_SOAK=1` run, the impl-plan §12.5 security matrix, and
     impl-plan §12.10 error-path coverage.
4. Every commit on this branch is self-contained — you can run tests
   at any point. If something's red, revert the tip commit; no rebase
   needed.
5. **Commit cadence** (durable — also recorded in auto-memory):
   one phase commit with the `US-xxx` tag in the subject, then a small
   follow-up that pins the new hash into this tracker. **Do not
   `--amend`** — pre-commit hooks may fail and amending would clobber
   prior work.

### Conventions in use on this branch
- One commit per phase, with the exact `US-xxx` tag in the subject line.
- Test files colocated under `test/agent-api/`, `test/runner/`, or
  `test/cli/` — never under `src/`.
- Handlers live in `src/agent-api/handlers/`; CLI subcommands in
  `src/cli/`; client lives at `src/agent-api/client.ts`.
- `bun:sqlite` named-parameter binds use `$name` prefix (see
  `allocateSyntheticInbound` for the pattern; `:name` doesn't work).
- Agent-API DB writes use `db.transactionImmediate` (not
  `db.transaction`) so concurrent writers don't race on
  `MIN(telegram_update_id)`.
- Ask turns insert as `status='running'` so the main dispatch loop
  never picks them up; inject turns insert as `status='queued'` so the
  loop does pick them up.
- Side-session id format: `^[A-Za-z0-9_-]{1,64}$`. Ephemeral sessions
  get `eph-<uuid>` prefix (test assertions rely on this — also
  recorded in auto-memory).
- CLI subcommand bodies return `Rendered { stdout, stderr, exitCode }`
  so tests don't need to mock `process.stdout`.

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
| 4b e2e — Inject delivery round-trip | ✅ Complete (`d2c99b0`) | US-011 US-012 | FakeTelegram round-trip: HTTP user_id/chat_id, idempotency replay (no double-send), ACL re-check, scope check, CLI subprocess (6 tests) |
| 5 — Cross-cutting (full) | ✅ Complete (`35b355d`) | US-013 US-014 | Multipart attachments + orphan-file sweep + `idempotency.ts` helpers + 32 tests |
| 6 — CLI core | ✅ Complete (`f7aa077`) | US-018 (partial) | `AgentApiClient` + `torana ask/inject/turns/bots` + 142 tests |
| 2b — CodexRunner side-sessions | ✅ Complete (`7967c93`) | US-006 | Per-turn spawn with `codex exec resume`; per-entry threadId; 26 tests (20 unit + 6 integration) |
| 2c — CommandRunner side-sessions | ⏳ Pending | US-007 | Protocol capability descriptors |
| 6b — CLI follow-ups + skills | ⏳ Pending | US-018 (rest) US-019 US-020 | Profile store, `@-` stdin, `skills install`, Codex plugin, `doctor --profile NAME` resolver |
| 7 — Observability + docs | ✅ Complete (`23abefd`) | US-015 US-016 US-017 | Metrics (counters + gauges + 2 histograms, 1 façade, wired into pool + handlers), doctor C009–C014 + R001–R003 (`runRemoteDoctor`), docs/agent-api.md + cli.md + README + 4 existing docs + CHANGELOG + doc-shape guard tests |

---

## What's done — feat/agent-api branch (22 commits)

Commits (`git log --oneline feat/agent-api ^main`, oldest at bottom):

```
23abefd agent-api phase 7: observability + doctor + docs (US-015, US-016, US-017)
b008991 agent-api: pin gap-fill commit hash in progress tracker
76cab87 agent-api: PRD-gap test pass + invalid_timeout + load.ts warning fix
9aa64c8 agent-api: polish progress tracker for next-session handoff
97dd888 agent-api: pin Phase 2b commit hash in progress tracker
7967c93 agent-api phase 2b: CodexRunner side-sessions (US-006)
d7811c6 agent-api: pin inject e2e commit hash in progress tracker
d2c99b0 agent-api: close inject e2e gap with FakeTelegram round-trip (US-011, US-012)
1ca3cc4 agent-api: pin Phase 6 core commit hash in progress tracker
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

**Full test suite: 691 pass / 4 skip / 0 fail.** Coverage at a glance:

- **Ask round-trip (Claude)** — JSON + multipart through real HTTP →
  bearer auth → `SideSessionPool` → `ClaudeCodeRunner` (mock binary)
  → response in [test/agent-api/ask.test.ts](../test/agent-api/ask.test.ts) +
  [test/agent-api/ask.multipart.test.ts](../test/agent-api/ask.multipart.test.ts).
- **Ask round-trip (Codex)** — full path through `CodexRunner`'s
  per-turn-spawn architecture in
  [test/agent-api/ask.codex.test.ts](../test/agent-api/ask.codex.test.ts);
  threadId-resume continuity verified via per-side log argv.
- **Inject persistence** — JSON + multipart through real HTTP → chat
  resolve → `insertInjectTurn` → queued row + attachment paths in
  [test/agent-api/inject.test.ts](../test/agent-api/inject.test.ts) +
  [test/agent-api/inject.multipart.test.ts](../test/agent-api/inject.multipart.test.ts).
- **Inject delivery** — full chain inject → dispatch → runner →
  streaming → outbox → FakeTelegram in
  [test/integration/agent-api/inject.round-trip.test.ts](../test/integration/agent-api/inject.round-trip.test.ts);
  also covers idempotency replay (no double-send) + ACL re-check + a
  CLI subprocess `torana inject` round-trip.
- **CLI dispatcher** — subprocess round-trips for every subcommand in
  [test/cli/dispatch.test.ts](../test/cli/dispatch.test.ts);
  function-level + fake-client tests in
  [test/cli/{ask,inject,turns,bots}.cmd.test.ts](../test/cli);
  client transport in [test/agent-api/client.test.ts](../test/agent-api/client.test.ts).

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

### Commit `7967c93` — Phase 2b: Codex side-sessions (US-006)

- [src/runner/codex.ts](../src/runner/codex.ts) — flips
  `supportsSideSessions()` to true. New `CodexSideSession` per-id state
  carries `threadId`, status, activeTurn, currentProc, log stream,
  stopPromise, stderrBuffer. `startSideSession` validates id, opens a
  per-side log file, emits ready via `queueMicrotask` — NO subprocess
  spawned (Codex is per-turn). `sendSideTurn` spawns
  `codex exec [resume <threadId>] --json` per call; `runSideTurn` pumps
  stdout/stderr, awaits exit + flush, synthesizes error/fatal(auth) if
  the subprocess exited without a terminal event. `buildSideArgs`
  reads `entry.threadId` so each side session has independent
  continuity from the main runner. `looksLikeAuthFailure` extracted to
  a free function for reuse across the main + side paths.
- [test/runner/fixtures/codex-mock.ts](../test/runner/fixtures/codex-mock.ts)
  — adds `slow-echo` (500ms in-flight window for busy tests) and
  `thread-late` (emits `turn.completed` BEFORE `thread.started` to
  validate that the runner captures threadId via `parser.flush()`).
- [test/runner/codex.side-session.test.ts](../test/runner/codex.side-session.test.ts)
  — 20 tests in two describes: 12 in "side-sessions" (parity with
  Claude's tests: id validation, double-start, ready timing,
  cross-contamination, busy serialization, stop/restart, error
  synthesis, fatal(auth), spawn-failure cleanup) + 8 in "threadId
  resume continuity" (first turn no-resume → second turn passes
  `exec resume <threadId>`, threadId is per-session, late
  `thread.started` still captured, attachment routing, main-runner
  reset doesn't affect side-session continuity).
- [test/agent-api/ask.codex.test.ts](../test/agent-api/ask.codex.test.ts)
  — 6 integration tests parallel to `ask.test.ts`: ephemeral ask
  through Codex per-turn spawn, keyed session reuses threadId across
  turns (verified via per-side log argv), concurrent `[200, 429]`
  busy via slow-echo, turn.failed → 500 runner_error, auth-fail → 503
  runner_fatal, GET /v1/turns/:id after Codex ask returns cached text.
- [test/runner/side-session-stub.test.ts](../test/runner/side-session-stub.test.ts)
  — flips Codex assertion to `supportsSideSessions() === true` and
  asserts `sendSideTurn` for an unknown session returns
  `{accepted:false, reason:"not_ready"}` rather than throwing.

Behavior chosen during implementation (not in plan):
- `dispatchSide` clears `entry.activeTurn`/promotes status to ready on
  `done`/`error` (matching main runner). The "thread.started after
  turn.completed" test inserts a brief `await` between turns so
  `runSideTurn`'s exit-flush completes before the second `sendSideTurn`
  reads `entry.threadId`. Sync back-to-back sends inside a `done`
  handler can theoretically miss thread continuity; not seen in
  practice with realistic event-loop ordering. Acceptable for v1.

---

### Commit `23abefd` — Phase 7: Observability + doctor + docs (US-015, US-016, US-017)

**US-015 — Metrics.**

- [src/metrics.ts](../src/metrics.ts) — adds `AgentApiCounters` +
  `AgentApiGauges` + `HistogramState` types; lazy
  `initAgentApi(botId)` so disabled path stays zero-alloc; new setters
  `incAgentApi`, `setAgentApiGauge`,
  `observeAgentApiRequestDuration(bot, route, ms)`,
  `observeAgentApiAcquireDuration(bot, outcome, ms)`. Bucket sequence
  `[50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]` ms for
  both histograms. `renderPrometheus` emits the new families only when
  `agentApi.size > 0` so pre-feature scrapes stay byte-identical.
  Non-finite + negative observations are dropped before bucket
  placement.
- [src/agent-api/metrics.ts](../src/agent-api/metrics.ts) — thin façade.
  `recordAsk`, `recordInject`, `recordAcquire`, `recordEviction`,
  `setSideSessionsLive`. Every function no-ops on `metrics: undefined`
  so existing pool/handler tests stay green without threading metrics
  through.
- Wiring:
  - [src/agent-api/pool.ts](../src/agent-api/pool.ts): constructor takes
    optional `metrics`; `publishLiveGauge(botId)` recomputes + emits on
    every state change (spawn success, release, `scheduleStop`,
    hard-TTL sweep with inflight>0); `acquire` calls `recordAcquire`
    with `reuse|spawn|capacity|busy` and observed duration; `evict` +
    in-place hard-TTL mark call `recordEviction`.
  - [src/agent-api/handlers/ask.ts](../src/agent-api/handlers/ask.ts):
    outer handler wraps `handleAskInner` + times duration + maps status
    to ask-bucket (200→2xx, 202→2xx+timeout, 4xx/5xx direct).
  - [src/agent-api/handlers/inject.ts](../src/agent-api/handlers/inject.ts):
    same pattern, plus a closure-captured `outcome: {replay: boolean}`
    ref so both the pre-write and in-txn replay paths set it. Replay
    counter increments only on 2xx+replay.
- [src/main.ts](../src/main.ts) — passes `metrics` into
  `SideSessionPool` constructor + `AgentApiDeps`.

**US-016 — Doctor.**

- [src/doctor.ts](../src/doctor.ts) — `DoctorCheck.status` gains
  `"warn"`. Local checks appended after C008 (all skip cleanly when
  `agent_api.enabled=false`):
  - C009 warn: enabled + empty `tokens`.
  - C010 fail: token references unknown bot.
  - C011 fail: ask-scope on a runner whose `runner.type` is in the
    non-side-session set (currently just `command`).
  - C012 fail: `secret_ref` empty/whitespace after interpolation.
  - C013 fail: `idle_ttl_ms > hard_ttl_ms`, `max_per_bot > max_global`,
    or `default_timeout_ms > max_timeout_ms` (defence-in-depth vs.
    schema superRefine).
  - C014 warn: deployment-posture reminder (bearer auth is the only
    thing between callers and the bot — confirm TLS + firewall posture).
  - `runRemoteDoctor({server, token, timeoutMs?, fetchImpl?})` →
    `DoctorResult`. R001 = `GET /v1/health` within 2s. R002 = `GET
    /v1/bots` with token → 200 + non-empty (empty emits `warn`, not
    `fail`). R003 = TLS handshake (re-probe /v1/health on https://;
    skip on http://). Uses a per-call `AbortController` + `signal`
    threaded into `fetchImpl` so timeouts actually fire.
- [src/cli.ts](../src/cli.ts) — `parseArgs` gains `--server`, `--token`,
  `--profile` (both space + equals forms). `doctor` subcommand: when
  `--server` (or `TORANA_SERVER`) is supplied, routes to
  `runRemoteDoctor` and skips the local config load entirely. `--token`
  or `TORANA_TOKEN` required; missing → exit 2. `--profile` exits 2
  with a Phase-6b pointer until the profile store lands. Output adds a
  `[warn]` badge for the new severity.

**US-017 — Docs.**

- [docs/agent-api.md](../docs/agent-api.md) — ~2100 words. Enable it,
  architecture diagram, authentication (SHA-256 + timingSafeEqual,
  no-enumeration contract), every endpoint with status code table,
  rate-limit + concurrency model, full metrics table with bucket
  sequence, security model, session-id sharing caveat, CLI quick tour,
  three worked examples, "What's not in v1" pointer at Phase 2c + 6b.
- [docs/cli.md](../docs/cli.md) — exhaustive CLI reference. Gateway
  commands (start/doctor/validate/migrate/version) with the new
  C009–C014 + R001–R003 tables; agent-api client commands
  (ask/inject/turns get/bots list) with every flag + every exit code
  + the stable 0/1/2/3/4/5/6/7 taxonomy.
- [docs/security.md](../docs/security.md) — new "Agent API auth"
  subsection on bearer-only model, per-bot + per-scope scoping, inject
  ACL re-check, no-enumeration, attachment hardening, idempotency as a
  safety feature.
- [docs/configuration.md](../docs/configuration.md) — full `agent_api`
  block with defaults + schema-enforced invariants table.
- [docs/runners.md](../docs/runners.md) — side-session support
  per-runner (claude-code yes, codex yes, command no v1).
- [docs/writing-a-runner.md](../docs/writing-a-runner.md) — interface
  addition covering `supportsSideSessions`, `startSideSession`,
  `sendSideTurn`, `stopSideSession`, `onSide`; per-runner support
  matrix.
- [README.md](../README.md) — removes the "Agent-to-agent messaging"
  non-goal; new `## Agent API` section after Runners; mermaid diagram
  updated to include an "Agent API" node + a side-session pool box
  connected to the runners; `docs/agent-api.md` + `docs/cli.md` added
  to the docs list; test badge bumped 255 → 675+.
- [CHANGELOG.md](../CHANGELOG.md) — `## [Unreleased]` entry detailing
  the full agent-api surface, side-session runners (Claude + Codex),
  CLI client commands, Prometheus metrics, doctor checks, and the v2
  schema with auto-migrate snapshot.
- [test/docs/agent-api.test.ts](../test/docs/agent-api.test.ts) — 16
  guard tests. Most importantly: walks every shipped markdown file
  (excludes `tasks/`, `test/`, `node_modules/`, `dist/`) and asserts
  no occurrence of "Agent-to-agent messaging". Also pins down the
  required headings in `docs/agent-api.md`, the metric-name list
  documented, the required flag + R00x coverage in `docs/cli.md`,
  the per-runner side-session row in `runners.md`, and the CHANGELOG
  Unreleased content.

**Tests added (+78 net, 613 → 691):**

- [test/metrics/agent-api.test.ts](../test/metrics/agent-api.test.ts)
  (+17) — counter init semantics, per-bot isolation, gauge overwrite
  including explicit zero, deep-copy snapshot, histogram bucket
  monotonicity, cross-route/outcome isolation, non-finite observation
  drop, above-top-bucket +Inf handling, full Prometheus body shape
  (HELP + TYPE + all counter lines for a populated multi-bot state).
- [test/agent-api/metrics.test.ts](../test/agent-api/metrics.test.ts)
  (+19) — façade entrypoints: ask 200 / 202 / 4xx / 5xx buckets,
  inject 202 no-replay / 202 replay / 4xx / 5xx, acquire spawn /
  capacity / reuse / busy (only spawn + capacity touch counters),
  eviction reason routing, `setSideSessionsLive`, undefined-metrics
  no-op across every entrypoint.
- [test/agent-api/pool.metrics.test.ts](../test/agent-api/pool.metrics.test.ts)
  (+9) — drives the real `SideSessionPool` through spawn / reuse /
  busy / capacity / LRU / idle-TTL sweep / hard-TTL sweep at
  inflight=0 / hard-TTL sweep at inflight>0 + live-gauge publish
  after each transition. Uses a fake runner (no real subprocesses)
  plus a fake clock so TTL sweeps are deterministic. A "no metrics"
  variant asserts the pool still works when `metrics` is omitted.
- [test/agent-api/handlers.metrics.test.ts](../test/agent-api/handlers.metrics.test.ts)
  (+6) — real HTTP round-trip with a real `ClaudeCodeRunner` (mock
  binary). Ask 200 increments `ask_requests_2xx` + duration histogram;
  ask 400 bumps `ask_requests_4xx`; inject fresh 202 bumps
  `inject_requests_2xx` + leaves replay counter at 0; inject replay
  bumps `inject_idempotent_replays_total`; inject missing_target (400)
  bumps `inject_requests_4xx`; inject 403 scope-denied is rejected by
  the `authed()` wrapper before the handler, so counters stay zero.
- [test/cli/doctor.agent-api.test.ts](../test/cli/doctor.agent-api.test.ts)
  (+15) — every state for C009..C014, including the `command`-runner
  ask-scope fail path and the `claude-code` ok path; R001 ok / 503 fail;
  R002 ok (non-empty) / 401 fail / warn (empty); R003 ok on https / skip
  on http / fail when fetch throws `self-signed certificate`; R001
  timeout test drives the AbortController path end-to-end with a
  50ms `timeoutMs` override.
- [test/cli/cli.test.ts](../test/cli/cli.test.ts) (+5) — `parseArgs`
  cases for `--server`/`--token`/`--profile` (space + equals);
  subprocess tests confirming `doctor --profile` exits 2 with the
  Phase-6b message and `doctor --server URL` without a token exits 2.
- [test/docs/agent-api.test.ts](../test/docs/agent-api.test.ts) (+16)
  — the doc-shape guards listed above.

**Durable notes for the next session:**

- The `agent_api_enabled=false` branch of `renderPrometheus` is
  exercised by `test/metrics/metrics.test.ts` (existing tests); the
  agent-api line emission is gated on `agentApi.size > 0` (the map
  lazy-initializes on first `initAgentApi`/`incAgentApi` call). Don't
  add a size check to `agentApiGauges` — a bot can register a live
  gauge without any counter bumps if the pool emits before a handler.
- Handler metrics wrap the inner function rather than intercepting
  every return site — less churn and cleanly handles the finally
  block + the orphan-listener handoff on the 202 ask timeout path.
- Doctor `C011` derives runner-supports-side-sessions statically from
  `runner.type` rather than instantiating runners. Keep that list
  (`claude-code`, `codex`) in sync with any new runner that flips
  `supportsSideSessions()` to true.
- Remote `R003` re-probes `/v1/health` rather than doing a separate
  TLS handshake because Bun's fetch validates the chain by default on
  https URLs; a bad chain shows up as a fetch throw during the retry.
- `torana doctor --profile NAME` is intentionally left as an exit-2
  stub in Phase 7. Phase 6b implements the resolver that feeds
  `--server` + `--token` from the profile store; the remote runner
  code doesn't change.

---

### Test-coverage gap-fill pass (`76cab87`)

Audit of completed user stories vs PRD acceptance criteria surfaced
several gaps. Filled in this pass (+51 tests, 562 → 613):

- **invalid_timeout error code (US-009 spec divergence).** Added
  `invalid_timeout` to [src/agent-api/errors.ts](../src/agent-api/errors.ts);
  ask handler now emits it (rather than `invalid_body`) when the rejected
  zod issue path is `timeout_ms`. Threaded through
  [src/cli/shared/exit.ts](../src/cli/shared/exit.ts) (→ exit code 2).
- **load.ts dead-code warning fix.** `enabled=true` with empty `tokens` was
  a dead-code branch behind an early return; warning now fires. Aligns with
  PRD US-016 C009 doctor check (which we'll wire in Phase 7).
- **[test/agent-api/ask.gaps.test.ts](../test/agent-api/ask.gaps.test.ts)
  (+9 tests).** invalid_timeout (over/under), `X-Torana-Retriable: false`
  header on 500 runner_error, 202 in_progress timeout-then-poll
  round-trip via slow-echo + orphan listener, 501 unsupported runner via
  fake runner with `supportsSideSessions=false`, 429
  `side_session_capacity` via per-bot+global=1 cap, runner_fatal teardown
  → no zombie entry blocks next acquire, server-side persistence assert
  for `source='agent_api_ask'` + token name + duration_ms.
- **[test/agent-api/router.gaps.test.ts](../test/agent-api/router.gaps.test.ts)
  (+14 tests).** CORS no-headers (Origin echo-back gets no
  `Access-Control-*`), `mapAuthFailure` body fields (bot_id on 403
  bot_not_permitted; scope on 403 scope_not_permitted), 410
  `turn_result_expired` via injected fake clock at 25h, 23h59m boundary
  still serves `done`, completed inject turn body has NO text field, 200
  `failed` + error_text, 200 `failed` with `interrupted_by_gateway_restart`
  fallback (NULL error_text via raw SQL), `GET /v1/bots/:id/sessions`
  documented snapshot shape with state/inflight/ephemeral/timestamps,
  `GET /sessions` requires ask scope (inject-only token → 403),
  `DELETE /sessions/:id` 204 success then GET no longer lists it, 404
  session_not_found body code.
- **[test/config/load.agent-api.test.ts](../test/config/load.agent-api.test.ts)
  (+15 tests).** SHA-256 hash computed at load + redaction set membership,
  literal-token warning, `enabled=true`-no-tokens warning,
  `enabled=false`-with-tokens warning, all `superRefine` failure paths
  (duplicate name, unknown bot, empty scopes, unknown scope, empty
  bot_ids, idle>hard, max_per_bot>max_global, default>max timeout),
  multi-token redaction set integration.
- **[test/agent-api/pool.test.ts](../test/agent-api/pool.test.ts) (+2
  tests).** Global-LRU eviction across bots (the `total >= globalMax`
  branch that per-bot LRU never reached), global cap with no
  evictable entries → capacity.
- **[test/runner/claude-code.side-session.test.ts](../test/runner/claude-code.side-session.test.ts)
  (+1 test).** Side-session log file lands at
  `<data_dir>/<bot_id>.side.<sessionId>.log` and contains the runner
  stdio (Codex had 6 such assertions; Claude had none).
- **[test/core/process-update.user-chats.test.ts](../test/core/process-update.user-chats.test.ts)
  (+1 test).** Transaction atomicity: monkey-patches
  `db.createTurn` to throw, asserts `user_chats` row was rolled back —
  proves `upsertUserChat` is genuinely inside the same transaction.
- **[test/agent-api/inject.source-regex.test.ts](../test/agent-api/inject.source-regex.test.ts)
  (+8 tests).** Regex itself (lowercase/digit/_/- ok, uppercase/space/dot
  rejected, 64 ok / 65 rejected) and HTTP-layer assertions: 64-char
  source accepted at the cap, 65-char rejected, uppercase rejected
  (PRD: lowercase only), dot rejected, empty rejected.
- **[test/cli/exit.test.ts](../test/cli/exit.test.ts) (+1 test).**
  `invalid_timeout → badUsage` exit code mapping.

**Notes for the next session — confirmed-but-untested gaps left as
follow-ups:**
- Timing-safe constant-time token comparison: a meaningful microbench
  test is fragile; trust the `crypto.timingSafeEqual` invocation in
  [src/agent-api/auth.ts](../src/agent-api/auth.ts) and lock it in via
  Phase 7 doctor check + a code review checklist instead.
- Ask-side optional Idempotency-Key (PRD US-014) is not implemented —
  the ask handler never reads the header. PRD says "optional on ask";
  current behavior is "ignored on ask." Decide in Phase 7 whether to
  implement or document the divergence.
- Codex back-to-back send race in `done` handler (acknowledged in
  Phase 2b commit): not regression-tested, intentional v1 limitation.

---

## What's left

Phases 1, 2a, 2b, 3, 4a, 4b (incl. e2e), 5, 6 core, **and 7** all done.
Two branches remain — sized + ranked for next session:

### Phase 6b — CLI follow-ups + skills (~1 day, pure UX polish)

[impl plan §8](impl-agent-api.md) — the pieces deferred from Phase 6
core. No gateway-side risk; all changes live under `src/cli/`,
`skills/`, `scripts/`, and `codex-plugin/`.

- **Profile store** at `~/.config/torana/config.toml` (Bun.TOML, file
  mode 0600). Resolve precedence becomes `flag > env > profile > error`.
  Phase 6 core's `resolveCredentials` already has the trace plumbing —
  add a third source.
- **`torana doctor --profile NAME` resolver.** Phase 7 already ships
  the remote check runner (`runRemoteDoctor`) + the `--profile` flag
  (CLI exits 2 with a pointer). Phase 6b just needs the
  profile-name-to-(server, token) lookup that feeds into the existing
  code path.
- **`@-` stdin file support** for `torana ask --file @-` /
  `torana inject --file @-`. Magic-byte MIME detection.
- **`torana skills install --host=claude|codex`** — implements
  [scripts/install-skills.ts](../scripts/install-skills.ts).
  Targets: `~/.claude/skills/` (or `$CLAUDE_CONFIG_DIR/skills`),
  `~/.agents/skills/` (or `$XDG_DATA_HOME/agents/skills`).
- **Skill files**:
  [skills/torana-ask/SKILL.md](../skills/torana-ask/SKILL.md) +
  [skills/torana-inject/SKILL.md](../skills/torana-inject/SKILL.md)
  with `allow_implicit_invocation: true` frontmatter (Codex-specific;
  Claude ignores).
- **Codex plugin scaffold**: [codex-plugin/](../codex-plugin/) +
  `marketplace.json`. Build script copies skills in (no symlinks so
  the published tarball survives systems that don't preserve them).
  [scripts/check-skill-parity.ts](../scripts/check-skill-parity.ts)
  enforced via a top-level test.

### Phase 2c — CommandRunner side-sessions (lower priority, defer)

[impl plan §4.3](impl-agent-api.md). Only matters for users with
custom runners speaking `claude-ndjson` or `codex-jsonl` protocols.

- Protocol capability descriptors (`{sideSessions: boolean}` per
  protocol). `jsonl-text` returns false; the other two return true.
- `claude-ndjson` envelope gains a `session` field for multiplexing
  (default `"main"` for backward compat).
- `codex-jsonl` reuses Phase 2b machinery (per-entry threadId).
- Example runner at `examples/side-session-runner/`.

### Pre-release validation (after the three phases above)

- `AGENT_API_E2E=1 bun test` against real `claude` + `codex` binaries.
- `AGENT_API_SOAK=1 bun test` — 24h run.
- Security matrix ([impl plan §12.5](impl-agent-api.md)) — 25+ tests
  across auth, authz, input validation, resource exhaustion,
  injection, disclosure.
- Error-path coverage matrix ([impl plan §12.10](impl-agent-api.md)) —
  every error code in [src/agent-api/errors.ts](../src/agent-api/errors.ts)
  exercised by at least one test.

### Release mechanics

- CHANGELOG entry; bump version in [package.json](../package.json);
  extend `package.json` `files` to include `skills/`, `codex-plugin/`,
  `scripts/install-skills.ts`.
- Extend [scripts/build.ts](../scripts/build.ts) to copy skills into
  `codex-plugin/` and render `plugin.json` with the version.
- Extend docker smoke test to probe skill files.

---

## Deferred decisions / open questions

Items still unresolved that the next session should be aware of.
Resolved items have been scrubbed.

- **Session-id sharing across tokens** ([impl plan §13 risk 12](impl-agent-api.md))
  — key is `(bot_id, session_id)`. If two callers use the same
  `session_id` they share context. Doc-only fix in v1 (call out in
  `docs/agent-api.md` during Phase 7); may key by
  `(bot_id, token_name, session_id)` in a future version.
- **Bun.TOML availability** ([impl plan §15 q2](impl-agent-api.md))
  — confirm during Phase 6b before writing the profile-store loader;
  add `@iarna/toml` only if the Bun version we target doesn't ship it.
- **Per-session concurrency=1** ([impl plan §5 rule 2](impl-agent-api.md))
  — fixed at 1 for v1; revisit if users hit 429 `side_session_busy`
  in practice.
- **Codex back-to-back send + threadId capture race** (Phase 2b
  implementation note — see commit `7967c93` summary above) — sync
  `sendSideTurn` inside a `done` handler can theoretically miss
  thread continuity. Not seen in practice with realistic event-loop
  ordering; revisit only if a real test surfaces it.
