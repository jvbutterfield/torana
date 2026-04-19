# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
