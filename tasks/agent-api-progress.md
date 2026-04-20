# Agent API — implementation progress

Branch: `feat/agent-api` (off `main`)
Plan: [impl-agent-api.md](impl-agent-api.md) (2859 lines, 20 user stories)
PRD: [prd-agent-api.md](prd-agent-api.md)

**Status:** all implementation phases landed. Phases 1 → 7 complete,
plus the Phase-7 gap-fill, plus **Phase 6b** (CLI polish), plus
**Phase 2c** (CommandRunner side-sessions for `claude-ndjson` /
`codex-jsonl` protocols, with `jsonl-text` explicitly left unsupported),
plus a **Phase 2c gap-fill** that closed 7 coverage gaps with 20 more
tests, plus **Phase 8** (§12.10 error-path coverage matrix — 1 gap
closed in `src/server.ts` + 93 new tests including a drift-guard that
enforces the matrix going forward), plus **Phase 9** (§12.5 security
matrix — all 30 matrix files under `test/security/agent-api/` + 151
new tests + a manifest drift-guard). Full suite: **1138 pass / 4 skip
/ 0 fail.** Remaining work is the real-binary E2E + soak + release
mechanics — no more implementation.

## How to resume

1. `git checkout feat/agent-api` — tip commit
   `54b2261` (Phase 9 pin);
   last implementation commit `4ec673f` (Phase 9 — security matrix,
   tests only, no production code changed);
   last test commit `4ec673f` (Phase 9 added 151 tests).
   43 commits ahead of `main`.
2. Sanity-check before touching anything:
   - `bun test` — expect **1138 pass / 4 skip / 0 fail**. Two tests
     (`CodexRunner side-sessions > after startSideSession resolves...`
     and `threadId resume continuity > first turn has no resume...`)
     are mildly flaky under full suite runs due to `queueMicrotask`
     timing; re-run if they trip.
   - `bun x tsc --noEmit` — expect clean (no output).
3. **Remaining work** — only pre-release validation is left:
   - `AGENT_API_E2E=1 bun test` against real `claude` + `codex` binaries.
   - A 24h `AGENT_API_SOAK=1` run.
   - ~~Impl-plan §12.5 security matrix~~ ✅ done in Phase 9.
   - ~~Impl-plan §12.10 error-path coverage matrix~~ ✅ done in Phase 8.
   - Release mechanics: CHANGELOG entry, bump `package.json` version,
     extend `package.json` `files` to include `skills/`,
     `codex-plugin/`, `scripts/install-skills.ts`, and
     `examples/side-session-runner/`; extend [scripts/build.ts](../scripts/build.ts)
     and docker smoke.
4. Every commit on this branch is self-contained — you can run tests
   at any point. If something's red, revert the tip commit; no rebase
   needed.
5. **Commit cadence** (durable — also in auto-memory):
   one phase commit with the `US-xxx` tag in the subject, then a small
   follow-up that pins the new hash into this tracker. **Do not
   `--amend`** — pre-commit hooks may fail and amending would clobber
   prior work.

### Conventions in use on this branch
- One commit per phase, with the exact `US-xxx` tag in the subject line.
- Test files colocated under `test/agent-api/`, `test/runner/`,
  `test/cli/`, `test/docs/`, or `test/metrics/` — never under `src/`.
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
  in auto-memory).
- CLI subcommand bodies return `Rendered { stdout, stderr, exitCode }`
  so tests don't need to mock `process.stdout`.
- **Metrics façade pattern:** handlers + pool + orphan listener call
  helpers in [src/agent-api/metrics.ts](../src/agent-api/metrics.ts),
  never the `Metrics` setters directly. Passing `metrics: undefined`
  is a no-op everywhere. When wiring a new agent-api call site, pass
  `metrics` through explicitly — `metrics?: Metrics` is optional on
  purpose so tests stay lightweight, but the real wiring in
  [src/main.ts](../src/main.ts) must pass it.
- **Runner → side-session capability** lives in one helper:
  `runnerSupportsSideSessions(runner)` in
  [src/runner/types.ts](../src/runner/types.ts). Takes a structural
  `{type, protocol?}` shape so the command-runner answer can depend on
  the configured protocol (Phase 2c). Doctor C011 reads it; a
  drift-guard test in
  [test/runner/side-session-stub.test.ts](../test/runner/side-session-stub.test.ts)
  pins each concrete runner's runtime `supportsSideSessions()` to the
  static answer for every protocol variant. Change both together or
  the test fails.
- **CommandRunner side-sessions** (Phase 2c) — each side-session runs
  the user's `cmd` as its own long-lived subprocess with
  `TORANA_SESSION_ID=<sessionId>` in env so the wrapper can distinguish
  main vs side. Main subprocess has no `TORANA_SESSION_ID` set. Event
  routing is per-subprocess (each side-session owns its own emitter).
  Supported for `claude-ndjson` + `codex-jsonl`; `jsonl-text` has no
  session semantics in its envelope and throws
  `RunnerDoesNotSupportSideSessions` from all side-session methods.
  Protocol capability descriptors live in
  [src/runner/protocols/*.ts](../src/runner/protocols) so adding a new
  protocol means one edit, not three.
- **Histogram bucket sequence** is exported as `DURATION_BUCKETS_MS`
  from [src/metrics.ts](../src/metrics.ts). The doc-shape test parses
  the "Bucket sequence" line in [docs/agent-api.md](../docs/agent-api.md)
  and asserts the list matches the runtime constant — change buckets
  in both places.
- **Profile store** lives at `$XDG_CONFIG_HOME/torana/config.toml` (or
  `~/.config/torana/config.toml`) with mode 0600. Written via
  `saveProfiles` (atomic rename + chmod); read via `loadProfiles`. The
  schema is a flat `[profile.NAME]` table per entry plus a top-level
  `default = "name"`. See [src/cli/shared/profile.ts](../src/cli/shared/profile.ts).
- **Skill parity** — `codex-plugin/skills/*/SKILL.md` are build-copies
  of `skills/*/SKILL.md`. Don't edit the copies directly; run
  `bun scripts/check-skill-parity.ts` or `bun run build` to re-sync.
  Parity is enforced by [test/cli/skills.parity.test.ts](../test/cli/skills.parity.test.ts).
- **`--file @-`** may be given at most once per `ask` / `inject` call
  (stdin is not repeatable). MIME is sniffed from magic bytes
  (PNG/JPEG/GIF/WEBP/PDF); unknown → `application/octet-stream`.
  Empty stdin is a usage error.

### Surprises / gotchas worth remembering
- `AskBodySchema` enforces `timeout_ms >= 1000`. For 202-timeout tests
  you can't use `slow-echo` (500ms) — use the `very-slow` (2s)
  claude-mock mode added in the gap-fill pass. `error-turn` mode emits
  `is_error: true` so the NDJSON parser raises `{kind: "error"}`.
- `insertInjectTurn` has two replay paths: pre-write (caught by
  `getIdempotencyTurn`) and in-transaction (caught inside the
  `BEGIN IMMEDIATE` on a unique-constraint collision). Both set
  `outcome.replay = true` in the handler. The in-txn path is
  exercised by `test/agent-api/handlers.metrics.test.ts >
  "in-txn replay"` — two concurrent POSTs with the same key.
- `agentApiSnapshot()` lazy-inits per bot — snapshot returns `{}` if
  nothing ever recorded. Tests checking "no metrics were touched"
  should assert the bot key is absent, not that counters are 0.
- `ask_orphan_resolutions_total{outcome="backstop"}` is the distinctive
  signal for the 1h force-release path. It is NOT an `error` — if it
  spikes in prod, the runner isn't emitting terminal events. Shutdown
  force-releases are deliberately not counted (they're not runner
  outcomes).
- `torana doctor --profile NAME` now resolves the profile to
  `(server, token)` and feeds `runRemoteDoctor`. Flag/env still win
  over the profile per standard precedence; `--server` without
  `--token` (and vice-versa) errors with exit 2.

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
| 2c — CommandRunner side-sessions | ✅ Complete (`b7ab18f`) | US-007 | Protocol capability descriptors (`claudeNdjsonCapabilities`/`codexJsonlCapabilities`/`jsonlTextCapabilities`); per-session subprocess spawn with `TORANA_SESSION_ID=<id>` env var; `runnerSupportsSideSessions` now protocol-aware; doctor C011 labels offender as `command/<protocol>`; `examples/side-session-runner/` (~60 lines Bun) demonstrates the pattern; **31 new tests** across `command.side-session.test.ts` (26), `example-side-session-runner.test.ts` (1), `side-session-stub.test.ts` (+3 cases), `doctor.agent-api.test.ts` (+2 C011 cases) |
| 2c gap-fill | ✅ Complete (`c2d96af`) | US-007 | Critical quality-review pass closed 7 gaps: end-to-end `POST /v1/bots/:id/ask` via `CommandRunner(claude-ndjson)` + `(codex-jsonl)` + `jsonl-text`→501 (10 tests in new `ask.command.test.ts`); `stopSideSession` unknown-id silent + concurrent coalescence; `startSideSession` rejects on exit-before-ready (new `crash-on-start` mock mode); `sideStartupMs` fallback verified; side-turn attachments for both protocols; explicit `TORANA_SESSION_ID` env var contract (new `reply-env` mock mode). **20 new tests** (10 ask.command + 10 command.side-session additions). No production code changed. |
| 6b — CLI follow-ups + skills | ✅ Complete (`7b62e1c`) | US-018 (rest) US-019 US-020 | Profile store (TOML, mode 0600) + `torana config` (5 subcommands) + `resolveCredentials` precedence (flag > env > named > default); `--file @-` stdin for ask/inject with magic-byte MIME; `torana skills install --host=claude\|codex` + parity gate; codex-plugin scaffold (plugin.json + marketplace.json + README); `torana doctor --profile NAME` resolver wired to `runRemoteDoctor`; **125 new tests** across 10 files (profile, precedence, config.cmd, skills.install, skills.parity, skills.codex-manifest, files.stdin, stdin.file, dispatch.profile, help-snapshots); CHANGELOG + docs/cli.md updates |
| 7 — Observability + docs | ✅ Complete (`23abefd`) | US-015 US-016 US-017 | Metrics (counters + gauges + 2 histograms, 1 façade, wired into pool + handlers), doctor C009–C014 + R001–R003 (`runRemoteDoctor`), docs/agent-api.md + cli.md + README + 4 existing docs + CHANGELOG + doc-shape guard tests |
| 7 gap-fill | ✅ Complete (`adfbcc4`) | US-015 US-016 | Handler failure-path metrics (ask 202/500/503/501/429x2; inject in-txn replay), new `ask_orphan_resolutions_total` counter + orphan-listener wiring + 7 tests, `/metrics` scrape integration (3 tests), subprocess doctor round-trip (5 tests), `runnerTypeSupportsSideSessions` helper + drift-guard test, `DURATION_BUCKETS_MS` exported + doc-sync test |
| 8 — §12.10 error-path coverage matrix | ✅ Complete (`799caad`) | US-015 | Closed the one gap in §12.10: `method_not_allowed` had zero emission sites + zero test assertions. Fix in `src/server.ts` — `/v1/*` paths now return canonical JSON `{error, message}` on 405 (non-`/v1/*` paths keep the plain-text 405 for backwards compat — no agent-api coupling at the transport layer). **93 new tests**: 6 in `test/server/router.method.test.ts` (PUT/PATCH against /v1/*, unregistered /v1 path, non-/v1 plain-text preserved, statusFor drift-guard, GET 200 no-regression) + 87 in `test/agent-api/errors.coverage.test.ts` (the matrix drift-guard itself: 29 codes × 3 invariants — `statusFor` returns a valid 4xx/5xx, emitted from ≥1 src file, asserted by ≥1 test). The coverage test parses `STATUS_MAP` out of `errors.ts` so new codes are auto-included; `method_not_allowed` is whitelisted to `src/server.ts` since its emission site is at the transport layer. Full suite: **987 pass / 4 skip / 0 fail**. |
| 9 — §12.5 security matrix | ✅ Complete (`4ec673f`) | US-015 | All 30 matrix files under `test/security/agent-api/`, backed by a shared `_harness.ts` (spins up a real HTTP server + GatewayDB + stubbed pool/orphans/registry). **151 new tests across 31 files** (30 matrix + 1 manifest drift-guard): auth (no-header / wrong-scheme / wrong-token / timing / case-mutation / log-redaction — 6 files), authz (wrong-bot / wrong-scope / enumeration-resistance / admin-scope — 4), input validation (huge-body / zip-bomb / path-traversal / null-byte / source-label / idempotency-key-injection / yaml-bomb / marker-injection — 8), resource exhaustion (side-session-flood against real pool / disk-fill via `computeDiskUsage` injection / slow-loris behavioural pin / idempotency-store-bloat with 10k seeded rows + sweep timing — 4), injection class (chat-forgery / acl-bypass / cross-bot / idempotency-reuse-different-content / runner-prompt-injection — 5), disclosure (error-body / metrics-labels — verifies scrape output has only `bot_id/status/result/reason/outcome/replay/route/mode/le` labels / logs — end-to-end log capture with secret + URL-pattern redaction — 3). `_manifest.test.ts` pins the file list against the matrix in impl-plan §12.5; new rows must add both a test file and a manifest entry. No production code changed. Full suite: **1138 pass / 4 skip / 0 fail**. |

---

## What's done — feat/agent-api branch (39 commits)

Commits (`git log --oneline feat/agent-api ^main`, oldest at bottom):

```
ffa709f agent-api: pin Phase 2c gap-fill commit hash
c2d96af agent-api phase 2c gap-fill: end-to-end ask + startup/stop/attachment edges (US-007)
e47d210 agent-api: replace count-fix placeholder with 65550f6
65550f6 agent-api: correct Phase 2c branch count (33 → 36)
86959e0 agent-api: correct Phase 2c branch count (32 → 33) + log fbe1be0
fbe1be0 agent-api: replace pin-commit placeholder with afc7850
afc7850 agent-api: pin Phase 2c commit hash in progress tracker
b7ab18f agent-api phase 2c: CommandRunner side-sessions (US-007)
c8f262d agent-api: correct branch commit count in tracker (28 → 30)
cd44c83 agent-api: replace pin-commit placeholder with 73a043d
73a043d agent-api: pin Phase 6b commit hash in progress tracker
7b62e1c agent-api phase 6b: profile store + @- stdin + skills + codex plugin (US-018, US-019, US-020)
b3536ac agent-api: polish progress tracker for next-session handoff
26236cd agent-api: pin Phase 7 gap-fill commit hash in progress tracker
adfbcc4 agent-api phase 7 gap-fill: handler failure paths + orphan metrics + scrape integration (US-015, US-016)
88eaf3d agent-api: pin Phase 7 commit hash in progress tracker
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

**Full test suite: 894 pass / 4 skip / 0 fail.** Coverage at a glance:

- **Ask round-trip (Claude)** — JSON + multipart through real HTTP →
  bearer auth → `SideSessionPool` → `ClaudeCodeRunner` (mock binary)
  → response in [test/agent-api/ask.test.ts](../test/agent-api/ask.test.ts) +
  [test/agent-api/ask.multipart.test.ts](../test/agent-api/ask.multipart.test.ts).
- **Ask round-trip (Codex)** — full path through `CodexRunner`'s
  per-turn-spawn architecture in
  [test/agent-api/ask.codex.test.ts](../test/agent-api/ask.codex.test.ts);
  threadId-resume continuity verified via per-side log argv.
- **Ask round-trip (Command)** — end-to-end HTTP → pool →
  `CommandRunner(claude-ndjson)` and `CommandRunner(codex-jsonl)` with
  full happy + failure-path coverage (ephemeral, keyed reuse, 429,
  crash-on-turn, jsonl-text→501) in
  [test/agent-api/ask.command.test.ts](../test/agent-api/ask.command.test.ts);
  parallel to the Claude + Codex suites, parametrized over both
  side-session-capable protocols.
- **Side-session runner contract (Command)** —
  [test/runner/command.side-session.test.ts](../test/runner/command.side-session.test.ts)
  exercises every non-trivial edge: id validation, double-start,
  cross-session isolation, busy serialization, startSideSession ready
  gate + fallback + scrub-on-exit, stopSideSession unknown-id-silent +
  concurrent coalescence, attachment forwarding (both protocols),
  explicit `TORANA_SESSION_ID` env contract. Example runner e2e in
  [test/runner/example-side-session-runner.test.ts](../test/runner/example-side-session-runner.test.ts).
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

### Commit `adfbcc4` — Phase 7 gap-fill (quality-review pass)

Post-Phase-7 audit surfaced several untested failure paths + one real
observability hole. All addressed in this commit.

- **Handler failure-path metrics** ([test/agent-api/handlers.metrics.test.ts](../test/agent-api/handlers.metrics.test.ts) +7).
  Ask 202 timeout via new `very-slow` claude-mock mode (2s delay) +
  timeout_ms=1000 — asserts ask_requests_2xx AND ask_timeouts_total
  bump at handoff, then ask_orphan_resolutions_done bumps after the
  runner's eventual reply (two counter states in one test). Ask 500
  runner_error via new `error-turn` mock mode. Ask 503 runner_fatal
  via `crash-on-turn`. Ask 501 via a Proxy wrapper that flips
  `supportsSideSessions()` without reimplementing the runner. Ask 429
  side_session_capacity (max_per_bot=1 + slow-echo hold). Ask 429
  side_session_busy (concurrent on same session_id; [200, 429]
  ordering asserted). Inject in-txn replay (two concurrent POSTs
  with the same key before either commits — exercises the
  `insertInjectTurn {replay:true}` branch the pre-write dedup path
  doesn't reach).

- **Orphan-listener metrics emission — new counter family**.
  The 202-handoff-then-eventual-outcome was an observability hole:
  operators couldn't see "of asks that timed out, how many finished
  cleanly vs. force-released at the 1h backstop?" Added
  `ask_orphan_resolutions_{done,error,fatal,backstop}` →
  `torana_agent_api_ask_orphan_resolutions_total{outcome=...}`.
  [src/agent-api/orphan-listeners.ts](../src/agent-api/orphan-listeners.ts)
  constructor gains optional `metrics` arg; terminal handler routes
  each outcome to the matching counter; backstop timer gets its own
  `backstop` outcome so it doesn't conflate with `error`. Shutdown
  force-releases are deliberately NOT counted.
  [test/agent-api/orphan-listeners.test.ts](../test/agent-api/orphan-listeners.test.ts)
  (+7) uses a fake SideRunner event emitter + fake pool + real DB to
  drive each of the four outcomes plus the double-terminal guard +
  shutdown-release-doesn't-count invariant + undefined-metrics no-op.

- **`/metrics` endpoint integration**
  ([test/agent-api/metrics.scrape.test.ts](../test/agent-api/metrics.scrape.test.ts) +3).
  The missing link: unit tests cover `renderPrometheus()` output but
  nothing verified main.ts actually wires the same Metrics instance
  into the `/metrics` route. New test stands up a gateway with the
  same wiring as main.ts, fires real HTTP ask + inject, scrapes
  `/metrics`, and asserts: HELP + TYPE comments present for every
  family; no duplicate HELP lines (Prometheus rejects those);
  Content-Type header is `text/plain; version=0.0.4`; pre-traffic
  scrape correctly omits agent-api lines (empty-state gating works);
  every expected metric family has non-zero samples after traffic.

- **Subprocess doctor round-trip** ([test/cli/doctor.agent-api.test.ts](../test/cli/doctor.agent-api.test.ts) +5).
  `runRemoteDoctor` was only tested against mock fetchImpl directly —
  so argv parsing, credential resolution, JSON output, and the
  dispatcher's integration with the check runner were all unproven
  end-to-end. New tests spin up a `Bun.serve` mock gateway with
  minimal /v1/health + /v1/bots and run the real CLI via
  `Bun.spawn`. Covers: happy path (R001/R002 ok, R003 skips on
  http://); R001 fail (503 → exit 1 with 503 in detail);
  TORANA_SERVER + TORANA_TOKEN env var substitution; --format json
  output parseability with all three R-ids; R002 401 detail
  surfaces in text output.

- **Maintainability fixes**:
  - `runnerTypeSupportsSideSessions(type)` exported from
    [src/runner/types.ts](../src/runner/types.ts). Replaces the
    hard-coded `{claude-code: true, codex: true, command: false}`
    literal in [src/doctor.ts](../src/doctor.ts) C011. New drift-guard
    test in [test/runner/side-session-stub.test.ts](../test/runner/side-session-stub.test.ts)
    (+3) pins the runtime `supportsSideSessions()` of each concrete
    runner to the static helper's answer — if they diverge, C011
    would lie and this test fails.
  - `DURATION_BUCKETS_MS` now `export`ed from
    [src/metrics.ts](../src/metrics.ts). The existing doc guard test
    parses the "Bucket sequence" sentence in docs/agent-api.md and
    asserts the list matches the runtime constant — changing buckets
    without updating docs fails CI.

- **New claude-mock modes** for these tests:
  - `very-slow` — 2s delay; 202-timeout test needs > min timeout_ms
    (1000ms).
  - `error-turn` — emits a `result` with `is_error=true` so the
    NDJSON parser maps it to a `{kind:"error"}` event.

**Tests added (+28, 691 → 719):**
- 7 handler-failure tests (handlers.metrics.test.ts)
- 7 orphan-listener tests (new orphan-listeners.test.ts)
- 3 /metrics integration tests (new metrics.scrape.test.ts)
- 5 subprocess doctor tests (doctor.agent-api.test.ts)
- 3 runnerTypeSupportsSideSessions tests + drift guard (side-session-stub.test.ts)
- 1 orphan-counter rendering test (metrics/agent-api.test.ts)
- 1 recordOrphanResolution façade test (agent-api/metrics.test.ts)
- 1 bucket-sync guard (docs/agent-api.test.ts)
- 1 orphan-metric documented guard (docs/agent-api.test.ts)

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

### Commit `b7ab18f` — Phase 2c: CommandRunner side-sessions (US-007)

- [src/runner/protocols/shared.ts](../src/runner/protocols/shared.ts)
  — new `ProtocolCapabilities` interface (just `{ sideSessions: bool }`
  for v1; room to grow).
- [src/runner/protocols/claude-ndjson.ts](../src/runner/protocols/claude-ndjson.ts),
  [src/runner/protocols/codex-jsonl.ts](../src/runner/protocols/codex-jsonl.ts),
  [src/runner/protocols/jsonl-text.ts](../src/runner/protocols/jsonl-text.ts)
  — each exports its own capability constant
  (`claudeNdjsonCapabilities`, `codexJsonlCapabilities`,
  `jsonlTextCapabilities`). Single source of truth; adding a new
  protocol means one edit, not three.
- [src/runner/types.ts](../src/runner/types.ts) — renamed
  `runnerTypeSupportsSideSessions(type: string)` →
  `runnerSupportsSideSessions(runner: RunnerSideSessionShape)`.
  Accepts `{ type, protocol? }` so the command-runner answer can depend
  on protocol (`claude-ndjson` / `codex-jsonl` → true; `jsonl-text` →
  false). `claude-code` and `codex` remain unconditional true.
- [src/runner/command.ts](../src/runner/command.ts) — real side-session
  impl. Each side-session is its own long-lived subprocess running the
  user's `cmd` with `TORANA_SESSION_ID=<id>` in env. Per-entry state
  (`CommandSideSession`) carries its own emitter, proc, logStream,
  status, activeTurn, stopPromise, readyPromise. Parser chosen per
  protocol: `claude-ndjson` → `createClaudeNdjsonParser`; `codex-jsonl`
  → `createCodexJsonlParser`. Ready gate: parser's startup signal OR
  `sideStartupMs` fallback. `jsonl-text` throws
  `RunnerDoesNotSupportSideSessions` via new
  `requireSideSessionSupport()` guard at the head of every side method.
  Spawn failure path scrubs the entry from `sideSessions` so pool
  retry works cleanly. Unexpected subprocess exit → fatal on side
  emitter only; main emitter is never signalled.
- [src/doctor.ts](../src/doctor.ts) — C011 now maps `botId → runner`
  (full config, not just type) and passes the runner through
  `runnerSupportsSideSessions`. Offender label surfaces the protocol
  for command runners: `command/jsonl-text` vs `command/claude-ndjson`.
- [test/runner/fixtures/command-ndjson-mock.ts](../test/runner/fixtures/command-ndjson-mock.ts)
  + [test/runner/fixtures/command-codex-mock.ts](../test/runner/fixtures/command-codex-mock.ts)
  — new behavior-configurable mocks (modes: `normal`, `slow-echo`,
  `crash-on-turn`, `no-ready`). Both stamp `TORANA_SESSION_ID` onto
  replies so tests can see routing worked end-to-end.
- [test/runner/command.side-session.test.ts](../test/runner/command.side-session.test.ts)
  — 26 tests. `jsonl-text` block (2 tests): supports-false + all four
  methods throw. Shared block iterated over both `claude-ndjson` and
  `codex-jsonl` (12 tests × 2 = 24): supports-true, id validation,
  double-start, onSide-before-start, happy path with disjoint-events
  assertion, two-concurrent-sessions isolation, busy → 429, unknown
  session → not_ready, stop+restart same id, fatal on crash, per-side
  log file lands at `<data_dir>/<bot_id>.side.<sessionId>.log`,
  spawn-failure scrubs phantom entry.
- [examples/side-session-runner/](../examples/side-session-runner/)
  — new example. `session-runner.ts` (~60 lines Bun) speaks
  `claude-ndjson`, reads `TORANA_SESSION_ID`, stamps
  `[<session>#<n>]` onto each reply. `torana.yaml` wires it up with an
  agent-API `ask`-scope token. `README.md` includes a curl demo.
- [test/runner/example-side-session-runner.test.ts](../test/runner/example-side-session-runner.test.ts)
  — one e2e test: spawns the shipped example under `CommandRunner`,
  drives one main-session turn + one side-session turn, asserts
  disjoint event streams and correct `[main#…]` / `[demo#…]` tags.
  Guards against drift between the published example and what the
  protocol parser expects.
- [test/runner/side-session-stub.test.ts](../test/runner/side-session-stub.test.ts)
  — updated to the new `runnerSupportsSideSessions(config)` signature,
  expanded drift guard iterates across all three command-runner
  protocol variants, new cases confirm `command/claude-ndjson` and
  `command/codex-jsonl` both report supported and return
  `{accepted:false, reason:"not_ready"}` on unknown-session sends.
- [test/cli/doctor.agent-api.test.ts](../test/cli/doctor.agent-api.test.ts)
  — C011 test cases refreshed: fail message now asserts
  `command/jsonl-text` shows in the offender label; two new tests
  confirm `command/claude-ndjson` and `command/codex-jsonl` PASS C011.

**Behavior chosen during implementation (not in plan):**
- **No wire-format change.** Plan §4.3 mentioned adding a `session`
  field to the `claude-ndjson` outbound envelope for multiplexing.
  Skipped because the impl uses per-session subprocesses (Claude-style)
  — the session tag would be unused. If a future user wants to
  multiplex many sessions through a single subprocess, the capability
  descriptor already says they can; the wire-format extension can
  land incrementally without breaking existing wrappers.
- **`TORANA_SESSION_ID` env var** is the handshake — simpler than
  argv injection, no cmd parsing, works uniformly for both protocols.
  Main subprocess doesn't set it; side subprocesses set it to the
  session id. Wrappers can use it to tag state, database paths, etc.

**Phase 2c tests**: 31 new expectations (26 command.side-session + 1
example-runner + 2 new C011 + 3 expanded drift-guard + 1 new C011
label assertion). Full suite 843 → **874 pass** / 4 skip / 0 fail.

---

### Commit `c2d96af` — Phase 2c gap-fill (quality-review pass)

A critical re-audit of Phase 2c coverage identified 7 gaps — 2 critical,
5 important — and filled them all. No production code changed; only
tests and mock fixtures.

**Critical end-to-end coverage (the central v1 promise — ask through a
custom runner):**

- [test/agent-api/ask.command.test.ts](../test/agent-api/ask.command.test.ts)
  (new) — 10 tests paralleling `ask.test.ts` (Claude) and
  `ask.codex.test.ts` (Codex). For each of `claude-ndjson` and
  `codex-jsonl`: ephemeral ask returns runner text (with
  `TORANA_SESSION_ID` stamp verifying routing), keyed session reuses
  pool entry across two turns, concurrent asks → `[200, 429]`
  side_session_busy, `GET /v1/turns/:id` returns cached text. Plus
  `jsonl-text` → 501 `runner_does_not_support_side_sessions` and a
  claude-ndjson crash-on-turn → 503 runner_fatal.

**Important unit-test coverage (edge cases a wrapper author will hit):**

- [test/runner/command.side-session.test.ts](../test/runner/command.side-session.test.ts)
  (expanded, +10 tests):
  - `stopSideSession` on unknown id is silent no-op (called from
    handler `finally` blocks after pool has scrubbed the entry).
  - `stopSideSession` concurrent second call coalesces — both calls
    resolve, entry fully scrubbed, third post-stop call also silent.
    (Async wrapper prevents reference equality, so the assertion is
    behavioral, not object-identity.)
  - Subprocess exits before emitting ready → `startSideSession`
    rejects with `/exited before ready/` and scrubs the entry. New
    `crash-on-start` mock mode.
  - `sideStartupMs` fallback — when the parser never emits a ready
    event (the `no-ready` mode that previously existed but was
    untested), the runner promotes to ready after the timeout and
    the session handles turns normally. Wait-time assertion pins
    the fallback actually ran.
  - Attachments on side turns: `claude-ndjson` (inline
    `[Attached file: <path>]` in content), `codex-jsonl` (top-level
    `attachments[]` in the jsonl-text envelope). Mocks surface the
    paths in replies so both protocols' wire-format paths are
    verified end-to-end.
  - Explicit `TORANA_SESSION_ID` env var contract: new `reply-env`
    mock mode stamps the raw env value. Side subprocess receives
    `env=<sessionId>`; main subprocess receives `env=unset` (absent).
    Previously only asserted implicitly via session-label tags.

- [test/runner/fixtures/command-ndjson-mock.ts](../test/runner/fixtures/command-ndjson-mock.ts)
  + [test/runner/fixtures/command-codex-mock.ts](../test/runner/fixtures/command-codex-mock.ts)
  — 2 new modes (`crash-on-start`, `reply-env`) + codex mock parses
  outbound `attachments[]` so it can surface paths in replies.

**Phase 2c gap-fill tests**: 20 new expectations (10 ask.command + 10
unit). Full suite 874 → **894 pass** / 4 skip / 0 fail.

---

## What's left

All implementation phases landed — only pre-release validation remains.

### Pre-release validation

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
