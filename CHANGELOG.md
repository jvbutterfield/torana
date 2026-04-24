# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

Five security fixes landed together ahead of the 1.0.0 cut. Three of them
are breaking config changes — see **Upgrade notes** below before deploying.

- **(P1) claude-code runner now requires `acknowledge_dangerous: true`.**
  The runner has always passed `--dangerously-skip-permissions` to the
  Claude CLI (required for torana's NDJSON protocol to work) — every turn
  has therefore run unsandboxed with host-level access in `cwd`. That was
  implicit; it is now explicit. The config loader rejects any claude-code
  bot without `acknowledge_dangerous: true`, with a message pointing at
  the container/VM isolation guidance in
  [docs/runners.md](docs/runners.md). Mirrors the existing Codex
  `approval_mode: yolo` acknowledgement pattern.

- **(P2) Agent API auth ordering is now enumeration-resistant.** `/v1/bots/:id/*`
  previously checked `registry.bot(botId)` BEFORE authenticating the bearer
  token, so an unauthenticated caller could distinguish valid bot ids
  (`401`) from invalid ones (`404 unknown_bot`). The wrapper now runs
  authenticate → authorize (token→bot+scope) → registry lookup in that
  order. An unauthenticated caller gets the same `401` whether or not the
  bot exists; a token-for-A probing bot B gets `403 bot_not_permitted`
  with no signal about bot B's existence. `404 unknown_bot` is reachable
  only when the caller's own token is legitimately authorized for that id
  — a misconfiguration indicator, not an enumeration primitive.

- **(P2) Webhook and Agent API secrets must be at least 32 characters.**
  `transport.webhook.secret` and `agent_api.tokens[].secret_ref` previously
  accepted any non-empty string; they now fail schema validation at load
  time if shorter than 32 chars. At 32 chars a random base64/hex value
  provides ~192 bits of entropy — overwhelmingly above any realistic
  brute-force threshold. The redaction collector in `src/log.ts` /
  `collectSecrets` also loses its old `length >= 6` filter: every
  configured secret is redacted regardless of length, so operators cannot
  accidentally bypass redaction.

- **(P2) Request bodies on `/v1/*` writes now get a streaming size cap.**
  Both ask and send previously called `req.json()` / `req.formData()`
  directly, trusting Content-Length when present. A caller with a valid
  token could send a chunked (no Content-Length) or lying Content-Length
  body and force memory buffering before any cap fired. Added
  `agent_api.send.max_body_bytes` to match `agent_api.ask.max_body_bytes`;
  both handlers now:
  - precheck Content-Length against the applicable cap and return
    `413 body_too_large` before reading the body, and
  - stream `req.body` chunk-by-chunk when no (or a missing) Content-Length
    is present, aborting the reader the moment accumulated bytes exceed
    the cap.

  Multipart aggregate accounting now also includes the UTF-8 byte sizes
  of every string field (including `text`). A text-only multipart payload
  is bound by the same cap as a file payload — you cannot bypass
  `max_body_bytes` by sending 100 MB of `text=` with zero files.

- **(P3) Gateway now binds to `127.0.0.1` by default.** New
  `gateway.bind_host` setting (default `127.0.0.1`). `/health`, `/metrics`,
  `/dashboard`, and the Agent API are no longer exposed on non-loopback
  interfaces unless the operator opts in. Container and PaaS deployments
  that need external reachability must explicitly set
  `bind_host: "0.0.0.0"` (or a specific interface IP).

### Upgrade notes

This release contains **three breaking config changes**. A pre-existing
config that loaded on rc.6 may refuse to load on rc.7 if any of these
apply:

1. **`bots[].runner.acknowledge_dangerous` is required for every
   claude-code bot.** Add `acknowledge_dangerous: true` under each
   claude-code runner block. The loader will print a clear error telling
   you which bot needs it. If you are running outside a container / VM,
   re-read [docs/runners.md](docs/runners.md) before acknowledging.

2. **`transport.webhook.secret` and `agent_api.tokens[].secret_ref` must
   be ≥ 32 chars.** Rotate any shorter secret. Generate replacements with
   `openssl rand -base64 32`. Telegram webhook secrets can be rotated
   with `torana webhook set` on the next start (torana re-registers the
   webhook with the new value automatically).

3. **`gateway.bind_host` defaults to `127.0.0.1`.** If your deployment
   reaches torana from outside the host (Docker bridge, LAN, a PaaS
   health check on a non-loopback IP, a reverse proxy on a different
   container), set `gateway.bind_host: "0.0.0.0"` explicitly — existing
   deployments that relied on the old `0.0.0.0` behaviour will start
   refusing remote connections otherwise. PaaS users in particular
   should double-check: the existing Railway/Heroku/Fly/Render note in
   [docs/configuration.md](docs/configuration.md) now covers this
   alongside the `PORT` gotcha.

4. **New field `agent_api.send.max_body_bytes`** (default 100 MiB). No
   action required — existing configs pick up the default. Lower it if
   you want a tighter cap on `/v1/bots/:id/send` requests.

5. **Enumeration-resistant auth ordering.** Clients that relied on
   `/v1/bots/:id/*` returning `404 unknown_bot` for typos against a bot
   the caller's token does not cover will now see `403 bot_not_permitted`
   instead. `404 unknown_bot` still fires, but only when the caller's
   token lists the unknown id in its `bot_ids` — i.e., the misconfigured
   deployment case.

## [1.0.0-rc.6] - 2026-04-21

### Changed

- **Agent API: renamed the `inject` scope to `send`.** The side-session
  architecture and every other Agent API surface are unchanged; this is a
  pure rename. The scope formerly named `inject` is now `send`, affecting:
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
