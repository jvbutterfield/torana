# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-rc.6] - 2026-04-21

### Changed

- **Renamed `inject` scope to `send`.** The Agent-API scope formerly named
  `inject` is now `send`, affecting:
  - HTTP route: `POST /v1/bots/:id/inject` → `POST /v1/bots/:id/send`
  - CLI command: `torana inject` → `torana send`
  - Token scope value: `scopes: ["inject"]` → `scopes: ["send"]`
  - Config key: `agent_api.inject.*` → `agent_api.send.*`
  - Skill package: `torana-inject` → `torana-send`
  - Marker text visible to the runner: `[system-injected from "<source>"]`
    → `[system-message from "<source>"]`
  - Prometheus labels: `mode="inject"` → `mode="send"` and
    `torana_agent_api_inject_idempotent_replays_total` →
    `torana_agent_api_send_idempotent_replays_total`
  - DB turn `source` column: `agent_api_inject` → `agent_api_send` (new
    turns only; historical rows retain the old value — queries that filter
    by source must update)
  - Client SDK: `client.inject()` → `client.send()`;
    `InjectRequest`/`InjectResponse` → `SendRequest`/`SendResponse`

  This is a breaking change with no alias. Since rc.5 is the only rc
  published to npm (on the `rc` dist-tag, not `latest`), operators
  upgrading must update their `torana.yaml`, any scripts calling the CLI,
  and any Prometheus dashboards. The route/scope/marker are the visible
  changes; the bot's runner now sees `[system-message from …]` prefixes
  instead of `[system-injected from …]`.

## [1.0.0-rc.5] - 2026-04-20

### Upgrade notes

- **Schema migration is required on first boot.** This release ships the
  v1→v2 migration (new `user_chats`, `agent_api_idempotency`,
  `side_sessions` tables + seven nullable columns on `turns`) and a v2→v3
  migration (nullable `codex_thread_id` column on `worker_state`). Run
  `torana migrate --config torana.yaml` before the first `torana start`,
  or pass `--auto-migrate` on start. Skipping migration is a hard fail at
  startup with a clear "schema is not current" message — no silent
  misbehaviour. Existing data is preserved; a snapshot is written to
  `<db>.pre-v2` before the upgrade.
- **No config changes needed.** Existing `torana.yaml` files load as-is.
  The new `agent_api` block is optional and defaults to `enabled: false`.
- **No existing CLI, metric, or HTTP-route behaviour changed.** If your
  deployment does not enable `agent_api`, the only observable difference
  after upgrade is the new DB schema and the existence of additional
  (lazy, zero-cost-when-disabled) agent-api code paths.

### Added

- **Agent API (`/v1/*`).** Opt-in bearer-authenticated HTTP surface that lets
  external processes drive torana-owned bots. `POST /v1/bots/:id/ask` runs a
  synchronous turn in an isolated side-session pool (per-bot + global LRU,
  idle + hard TTL, auto-eviction) with optional multipart attachments; on
  timeout returns `202 + turn_id` and hands off to an orphan listener that
  persists the eventual terminal event. `POST /v1/bots/:id/inject` pushes a
  `[system-injected from "<source>"]`-marker-wrapped message into an existing
  Telegram chat with idempotency-key dedup, ACL re-check, and user/chat
  resolution. `GET /v1/turns/:id`, `/v1/bots`, `/v1/bots/:id/sessions`, and
  `DELETE /v1/bots/:id/sessions/:id` round out the surface. Disabled by
  default — enable via the new `agent_api` config block. See
  [docs/agent-api.md](docs/agent-api.md).
- **Side-session support across all three runners.** The `AgentRunner`
  interface gains `startSideSession` / `sendSideTurn` / `stopSideSession` /
  `onSide` / `supportsSideSessions`. `ClaudeCodeRunner` runs a long-lived
  subprocess per session with its own `--session-id`; `CodexRunner` spawns
  per-turn with `codex exec resume <threadId>`; `CommandRunner` (any of the
  three protocols) spawns one subprocess per session with
  `TORANA_SESSION_ID=<sessionId>` in env so the wrapper can distinguish main
  vs side. `jsonl-text` has no session semantics and throws
  `RunnerDoesNotSupportSideSessions` — use `claude-ndjson` or `codex-jsonl`.
  Events are emitter-isolated per session — no cross-contamination with the
  main Telegram runner. See
  [examples/side-session-runner/](examples/side-session-runner/) for a
  ~60-line reference wrapper.
- **CLI agent-api client.** `torana ask`, `torana inject`, `torana turns get`,
  `torana bots list` — support `--server` / `--token`, `TORANA_SERVER` /
  `TORANA_TOKEN` env, and named profiles (see below). Stable exit codes
  (0/1/2/3/4/5/6/7) for scripting. See [docs/cli.md](docs/cli.md).
- **CLI profile store.** `torana config init | add-profile | list-profiles |
  remove-profile | show` manages a TOML file at
  `$XDG_CONFIG_HOME/torana/config.toml` (mode 0600). Every agent-api
  subcommand resolves credentials with the precedence
  `flag > env > --profile NAME > default profile`. `torana doctor
  --profile NAME` runs the R001..R003 remote probes against the resolved
  server.
- **`--file @-` on `torana ask` / `torana inject`.** Reads attachment bytes
  from stdin with magic-byte MIME detection (PNG, JPEG, GIF, WebP, PDF;
  unknown → `application/octet-stream`). Mixable with real-path `--file`;
  a second `@-` on the same call is a usage error.
- **Skills + Codex plugin.** `skills/torana-ask/SKILL.md` and
  `skills/torana-inject/SKILL.md` ship with the package. `torana skills
  install --host=claude|codex` copies them into
  `$CLAUDE_CONFIG_DIR/skills` / `$XDG_DATA_HOME/agents/skills` (default
  refuses on divergence; `--force` overwrites). `codex-plugin/` contains
  a manifest + marketplace.json entry for one-line Codex install; a
  `scripts/check-skill-parity.ts` CI gate guarantees byte-identical
  source/plugin skill files.
- **Prometheus metrics for Agent API.** Counters (`torana_agent_api_requests_total`,
  `…_inject_idempotent_replays_total`, `…_side_sessions_started_total`,
  `…_side_session_evictions_total`, `…_side_session_capacity_rejected_total`),
  a gauge (`…_side_sessions_live`), and two histograms
  (`…_request_duration_ms{route=ask|inject}`,
  `…_side_session_acquire_duration_ms{outcome=reuse|spawn|capacity|busy}`).
- **Doctor checks C009..C014 + R001..R003.** `torana doctor` adds six
  local checks (enabled-without-tokens, unknown bot_ids, ask-scope on
  non-side-session runner, empty secret_ref, TTL/cap invariants,
  deployment-posture reminder). `torana doctor --server URL --token TOK`
  runs three remote probes against a running gateway (`GET /v1/health`,
  `GET /v1/bots` with caller auth, TLS validation on `https://`).
  `torana doctor --profile NAME` resolves the (server, token) pair from
  the CLI profile store and runs the same remote probes.
- **SQLite schema v2.** New tables `user_chats`, `agent_api_idempotency`,
  `side_sessions` plus seven nullable columns on `turns`. Migration v1→v2
  is automatic with `torana start --auto-migrate` (snapshot taken at
  `<db>.pre-v2` before upgrade). Shipped as `0002_agent_api.sql`;
  `0003_runner_session_resume.sql` follows with the Codex/resume columns.

### Fixed

- **Claude CLI 2.1 `--session-id` UUID validation.** Claude Code 2.1+
  rejects non-UUID values for `--session-id`, but the side-session pool
  mints IDs matching `^[A-Za-z0-9_-]{1,64}$` (e.g. `eph-<uuid>` or a
  caller-supplied alias). `ClaudeCodeRunner.startSideSession` now mints
  a fresh UUID per entry and passes that to the CLI while keeping the
  pool's original `sessionId` as the public identifier — callers and
  DB rows stay unchanged.

## [1.0.0-rc.4] - 2026-04-19

### Added

- **Codex runner.** New `runner.type: codex` wraps the OpenAI Codex CLI (`codex exec [resume <id>] --json --skip-git-repo-check …`). Captures `thread_id` from `thread.started` and resumes via `codex exec resume <id>` on subsequent turns (`pass_resume_flag: true` by default). Approval mode (`untrusted`/`on-request`/`never`/`full-auto`/`yolo`) maps to `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`, or `-c approval_policy=<mode>` depending on the value (the top-level `--ask-for-approval` flag is rejected by `exec`). `--sandbox` is auto-omitted on resume turns (the original session's sandbox is inherited and `exec resume` rejects the flag). `--skip-git-repo-check` is auto-applied so bot data dirs don't need to be git repos. `yolo` requires `acknowledge_dangerous: true` and emits a startup warning. Image attachments forward via `--image`; non-image attachments are skipped with a warning. Streaming is one edit per turn at completion (Codex doesn't emit token-level deltas) — accepted limitation, documented in `docs/runners.md`. Hybrid configs (e.g. one Claude Code bot + one Codex bot) work out of the box; the dispatcher is per-bot. Verified end-to-end against codex-cli 0.121.0 (gated behind `CODEX_E2E=1` so CI doesn't burn API quota).
- **`codex-jsonl` protocol** added to the `command` runner for wrappers that emit Codex-style state-change events. Long-lived wrappers can emit `{"type":"ready"}` on startup to promote the runner to ready before the first turn.
- **`examples/codex-bot/`** end-to-end example mirroring `examples/echo-bot/`.

### Changed

- **README rewrite.** New hero section, runner comparison table, mermaid architecture diagram, hybrid-config example, operational-guarantees section, and a working quickstart that points at `examples/echo-bot/` (the previous quickstart referenced an `echo.js` that didn't exist). Confidence and clarity pass for v1 polish.

## [1.0.0-rc.3] - 2026-04-18

### Added

- Startup WARN when `access_control.allowed_user_ids` is empty — the default-deny behavior is still correct (empty list rejects all traffic), but operators who forget to populate the list now get a signal instead of a silently-dropping gateway. Emitted per-bot when only some bots are affected by an empty override. (#1)
- `workflow_dispatch` trigger on the release workflow with a `dry_run` input. Lets maintainers exercise the pack/typecheck/test/verify pipeline without cutting a real tag; on dry runs the tarball is uploaded as a build artifact and `npm publish` is skipped. (#2)
- New `docker-install-smoke` CI job: packs the tarball, installs it inside `oven/bun:latest`, and runs `torana version`/`validate`/`migrate --dry-run` against a minimal fixture. Catches bin-shim, shebang, ESM/CJS interop, and permission-bit regressions that the pack-manifest guard can't see. (#4)

### Changed

- Docs and the `examples/echo-bot/` config now recommend `port: ${PORT:-3000}` with a callout on the silent-502 failure mode on PaaS platforms (Railway/Heroku/Fly/Render) that assign `$PORT`. (#5)

## [1.0.0-rc.2] - 2026-04-18

### Fixed

- **Published tarball now includes migration SQL.** rc.1 built only `dist/cli.js`; `torana start --auto-migrate` then failed at runtime with `0001_persona_to_bot_id.sql not found`. `bun run build` now runs `scripts/build.ts`, which bundles and copies `src/db/schema.sql` + `src/db/migrations/*.sql` into `dist/db/`. A new `scripts/verify-pack.ts` runs in CI and before `npm publish` to fail the pipeline if the required SQL paths are absent from the tarball manifest.
- **Config interpolator no longer treats `${VAR}` inside YAML comments as a reference.** Prose in a `#` comment that happened to contain the literal `${VAR}` form caused `env var ${VAR} is not set and has no default` with no file offset. The interpolator now masks YAML comments (quote-aware) before scanning, and missing-var errors include `line` and `column`.

## [1.0.0-rc.1] - 2026-04-18

### Added

- Initial v1 release candidate.
- Configuration-driven multi-bot gateway — YAML config replaces hard-coded env-per-persona wiring.
- Two transports: webhook and polling, with per-bot overrides.
- Two built-in runners: `claude-code` and `command` (with `jsonl-text` + `claude-ndjson` protocols).
- Slash-command dispatcher with `builtin:reset`, `builtin:status`, `builtin:health`.
- SQLite state with WAL, crash recovery, outbox.
- Streaming message edits, safe attachment handling, default-deny ACL.
- Zod-validated strict config, `${VAR}` + `${VAR:-default}` env interpolation.
- Secret-redacting logger (both value-based and `/bot<TOKEN>/` URL-path redaction).
- `torana start|doctor|validate|migrate|version` CLI.
- Prometheus `/metrics` endpoint (opt-in).
- `examples/echo-bot/` smoke test.
