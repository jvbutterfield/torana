# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0-rc.17] - 2026-08-09

### Fixed

- **Desktop-managed Buzz agents now initialize their session host when they are
  registered after the gateway has started.** Their first incoming turn can
  therefore create and advance its worker generation exactly like a configured
  startup agent, instead of dereferencing missing worker state and restarting
  the Telegram gateway. This is a runtime-only fix: no schema migration or
  Desktop re-provisioning is required.

## [2.0.0-rc.16] - 2026-08-09

### Added

- **Desktop-managed Buzz agents.** An agent can now be created, configured, and
  deleted entirely from Buzz Desktop, with its definition living in the gateway
  database rather than in `torana.yaml`. YAML agents are unchanged and the two
  kinds coexist permanently.

  The whole feature is **inert unless the gateway declares a `provisioning:`
  block**. Without one, a deploy that would create an agent is refused with
  `not_configured`, doctor C030–C033 skip, and nothing else behaves
  differently. Existing deployments are unaffected by upgrading.
  - Schema **v8**: `provisioned_agents`, `buzz_tombstone_cursors`, and an
    append-only `provisioning_audit` that is deliberately not foreign-keyed, so
    a purge record outlives the agent it describes.
  - A record plus the operator's harness entry is projected into a complete v2
    agent block and validated by the **unchanged** `ConfigV2Schema` — the
    schema is not relaxed to make provisioned agents expressible.
  - Instruction changes apply to a running agent at the turn boundary: an
    in-flight turn finishes under the instructions it started with, and every
    turn started after the deploy uses the new ones. Each agent carries an
    observable `instruction_version` digest over the applied prompt, model, and
    honored timeouts.
  - Deletion is driven by an owner-signed NIP-09 tombstone against the agent's
    `kind:30177` record, verified client-side and **staged**: drain, presence
    offline, a persisted purge deadline (`delete_grace_hours`, default 72 h),
    and an operator alert. Nothing durable is destroyed until the deadline, the
    deadline survives restart, and the purge audit record is committed before
    anything is removed. There is no TTL, idle timer, or reconcile-driven
    reaping — absence from a reconcile set means nothing.
  - New admin routes: `GET /v1/admin/buzz/agents`,
    `GET|DELETE /v1/admin/buzz/agents/:id`,
    `POST /v1/admin/buzz/agents/:id/restore`, and
    `GET /v1/admin/buzz/reconciliation` (advisory; no write path).
  - New CLI: `torana agents list|report|restore|purge` and
    `torana audit prune`. None of them destroy anything directly — the running
    gateway's sweep owns destruction.
  - `endpoints:admin` tokens may now carry `bot_ids: ["*"]`, legal only when
    that scope is the token's only one.

### Changed

- **`TORANA_PROVISIONING_SECRETS_KEY` accepts a comma-separated key list**,
  primary first, so it can be rotated without downtime or re-provisioning. On
  startup every stored row still sealed under an outgoing key is re-sealed
  under the primary and logged; doctor C029 gained a `warn` tier that reports
  when rows remain on an outgoing key, which is what makes "the old key is safe
  to delete" a check rather than a guess. A single-key value behaves exactly as
  before.

- The pinned Buzz CLI moved from `desktop-v0.5.7` to `desktop-v0.5.8`
  (commit `f3de860574bb3119018b4592353e9761635aeb07`, Apple-silicon release
  asset `506568023`). The default `platforms.buzz.cli_sha256` is now
  `1854298e0a9f7ac8b8a6395b2b7411cb7fbd937a8643cd9c49584f1d9da5351d` and
  doctor C024 names Buzz 0.5.8.

  **Nothing in 0.5.8 reaches Torana's contract surface.** The evidence is
  structural rather than a diff summary: `desktop/src-tauri/src/` has **zero**
  changed files between the two tags. The only `src-tauri` changes are
  `Cargo.toml`, `Cargo.lock`, and `tauri.conf.json`, and the first and third
  are the version string alone. Every source behind the provider-deploy,
  reconcile, access-policy, tombstone, and owner-`!shutdown` paths is therefore
  byte-identical, confirmed by comparing each file's blob SHA at both tags. The
  CLI command surface is unchanged, so no command changed tier.

  0.5.8 is four changes: a React-only "unify add agent flows" reshuffle of the
  agent dialogs, summarizer-reasoning budgeting in the `buzz-agent` harness
  (which Torana does not use — it drives its own runners), binding development
  compose services to loopback, and a revert of the ACP unattended-permission
  rejection.

  That revert is worth naming because it is a security-posture change inside
  the pinned bundle that an unchanged command manifest would not reveal:
  `crates/buzz-acp` re-adds the `bypassPermissions` mode 0.5.6 removed, moves
  the `BUZZ_ACP_PERMISSION_MODE` default from `dont-ask` to
  `bypass-permissions`, and auto-approves `session/request_permission` with
  `allow_once` instead of rejecting it. It does not reach Torana: `buzz-acp` is
  the Desktop-local ACP adapter, and Torana spawns its own harnesses. Torana's
  exposure to the bundle is the `buzz` CLI verb surface, which is unchanged and
  still gated by the broker manifest and policy classification.

  One of the four files cited by
  `spike/buzz-transport/owner-shutdown-contract.json` — `buzz-acp/src/lib.rs` —
  did change, so its assertion was re-read at the new tag rather than carried
  over: the whole delta is two test-module fixture lines, and
  `is_owner_control_command` is byte-identical. Invariant I5 is unaffected.

## [2.0.0-rc.15] - 2026-08-08

### Changed

- The pinned Buzz CLI moved from `desktop-v0.5.6` to `desktop-v0.5.7`
  (commit `f167818d25dd9f03115ab907a16f07daee2ece5c`, Apple-silicon release
  asset `505779314`). The default `platforms.buzz.cli_sha256` is now
  `3c0d8264d8b994c3a19e4d769802e184b74caa8e5688ad432fc5722acc7eb545` and
  doctor C024 names Buzz 0.5.7.

  **Nothing in 0.5.7 reaches Torana's contract surface**, and unlike the 0.5.6
  bump that statement is backed by comparing the blob SHA of each file at both
  tags rather than by a diff summary. `docs/remote-agents.md`, `NIP-OA.md`,
  `NIP-AA.md`, and every source behind the provider-deploy, reconcile,
  access-policy, and owner-`!shutdown` paths are byte-identical. The CLI
  command surface is unchanged, so no command changed tier.

  0.5.7 is seven commits: max-token truncation recovery in the `buzz-agent`
  harness (which Torana does not use — it drives its own runners), the boot
  `<style>` moved to `boot.css` for a Tauri CSP nonce, an onboarding fix for
  imported identities, relay-admission test isolation, and a mobile message
  list fix. The one change on a path Torana reads, `relay.rs`, is test-only;
  `effective_agent_relay_url` is untouched.

## [2.0.0-rc.14] - 2026-08-07

### Changed

- The pinned Buzz CLI moved from `desktop-v0.5.5` to `desktop-v0.5.6`
  (commit `277d98a5cfb6d3b9af8b75122988f7a7df33ed5d`, Apple-silicon release
  asset `505571273`). The default `platforms.buzz.cli_sha256` is now
  `eadcf47ac7ea04f811d8122375fbe2a0b90e121a3e82a529ebca30dee2b784d2` and
  doctor C024 names Buzz 0.5.6. **The 0.5.6 command surface is byte-identical
  to 0.5.5** — the entire manifest diff is the binary checksum — so no command
  changed tier and `DANGEROUS_BUZZ_COMMANDS` is unchanged. The one normative
  spec movement, `BUZZ_ACP_AGENTS` becoming a reserved key carrying effective
  (harness-capped) parallelism, does not reach Torana, which never maps
  `launch.policy_env` and treats `parallelism` as Torana-managed.

- Reviving an endpoint after an owner `!shutdown` is now an explicit,
  reported outcome. A deploy has always cleared the durable `disabled` state,
  but only as a side effect of the no-op guard failing to match, and it was
  silent. Buzz Desktop 0.5.6 makes that matter: `reconcile_on_workspace_apply`
  redeploys every provider-backed agent before each community UI load, so a
  deploy is no longer proof that the owner asked for one — and the protocol
  carries no field distinguishing the two, so Torana cannot tell them apart.
  The revive is still honoured, because refusing it would break Buzz Desktop's
  "Start" for every stopped agent. It now logs
  `Buzz endpoint revived by deploy after an owner shutdown` and the
  provisioning API returns `result: "revived"` instead of `"replaced"`.
  `docs/operations.md` no longer describes the way back up as necessarily
  explicit, and states plainly that opening the Buzz community UI can restart
  an agent stopped with `!shutdown`. What the invariant still guarantees is
  unchanged: no restart, supervisor flap, or reconnect revives a stopped
  endpoint.

### Fixed

- The Buzz Desktop provider sent Torana an access mode Torana rejects. The
  Desktop serializes `respond_to` in kebab-case (`owner-only`); Torana's
  endpoint schema is snake_case (`owner_only`); the provider forwarded the
  payload value verbatim whenever `provider_config` did not override it. The
  two vocabularies are now reconciled at the provider's ingest boundary, and an
  unrecognized mode is refused in band rather than passed through.
- The provider let `provider_config` **widen** access beyond what the Desktop
  projected. From 0.5.6 an owner-only Desktop build clamps `respond_to` in the
  deploy payload precisely so a remote deployment cannot answer a wider
  audience than the locked UI control shows; a `provider_config` of `anyone`
  silently defeated that. The two sources are now composed by taking the
  narrower, so either side may restrict access and neither may widen it.
- The provider sent `allowed_pubkeys` alongside modes that reject one. Torana
  refuses an unused allowlist on `anyone` and `nobody`, and a Desktop record
  readily retains a list from a mode the user has since moved off, so an
  otherwise-valid deploy failed validation. The allowlist is now sent only when
  the effective mode is `allowlist`.

## [2.0.0-rc.13] - 2026-08-07

### Added

- `torana buzz keygen` and `torana buzz auth-tag`. Obtaining Buzz credentials
  was the one step of Buzz setup with no first-party path: Torana could verify
  an owner attestation but never mint one, so the `auth_tag` every Buzz
  endpoint requires had to come from somewhere the docs didn't name. `keygen`
  prints a fresh identity keypair; `auth-tag` signs a NIP-OA owner attestation
  for an endpoint public key. Neither reads a config, opens the database, or
  touches the network. The owner secret is read from `BUZZ_OWNER_PRIVATE_KEY`
  rather than a flag so it stays out of `argv` and shell history, and no error
  path echoes key material. See
  [`docs/platforms/buzz.md`](docs/platforms/buzz.md#getting-buzz-credentials).

### Documentation

- `docs/configuration.md` documented v1's shape as its "Full reference" while
  the project had moved to v2: `platforms`, `sessions`, `retention`,
  `agents[]`, `agents[].endpoints[]`, `publishers[]`, and `publisher_api` had
  no reference entry at all. The doc even stated that `sessions.*` is
  authoritative and then never listed its fields. All seven are now documented
  key by key, and the v1-only blocks are labelled as such.
- Added `docs/README.md` (documentation index and reading order) and
  `docs/troubleshooting.md` (symptoms → causes → fixes, anchored on the real
  doctor checks and API error codes).
- Removed the design plans, phase findings, and release-readiness records from
  the repository. They were engineering history rather than reference material
  — three of the four were unlinked while making up the bulk of `docs/` — and
  they described a specific deployment: memory ceilings and baselines for a
  named single-replica service, the production edge's exposed-path inventory,
  fleet composition and traffic counts. Everything under `docs/` is now
  reference material that describes the software.
- Corrected stale README claims: the status section advertised
  `v1.0.0-rc.10` and schema v6, and the doctor range stopped at `C014`.
  Added the six operator commands missing from the command table, and
  documented `torana publish` in `docs/cli.md`.

### Security

- **Breaking:** the operator routes under `/v1/admin/*` now require a new
  `admin` scope instead of `ask`. They enumerate every conversation, session,
  and outbox row for the token's agents, and three of them destroy durable
  state — draining an endpoint, rotating a session, and dead-lettering rows
  with acknowledged data loss. `ask` is the scope handed to agents and scripts
  for ordinary conversation, so gating those operations behind it made every
  messaging token an operator token by default.

  **Migration:** add `admin` to the `scopes` array of any `agent_api.tokens`
  entry that calls `/v1/admin/*`. It may be combined with `ask`/`send` (these
  routes are not reachable from the public edge), so `scopes: ["ask", "send"]`
  becomes `scopes: ["ask", "send", "admin"]` for a token that does both.
  Without it those routes return `403 scope_not_permitted`. The separate
  `endpoints:admin` scope for Buzz provisioning is unchanged and still cannot
  be combined with any other scope.

- Buzz endpoints provisioned at runtime never entered the log redaction set.
  `setSecrets()` runs once from the config load, which only knows about
  secrets declared in YAML, so a provisioned endpoint's private key and owner
  auth tag were exempt from the guarantee `docs/security.md` makes for every
  other secret. Both are now registered at the two points they enter the
  process — when a deploy is accepted, and when a stored row is decrypted at
  startup. No leak path was identified; this closes the gap rather than
  fixing a known disclosure.

### Fixed

- Config validation accepted an endpoint id reserved by a _different_ agent.
  The reserved-name check compared each endpoint id only against its own
  agent's `<agent>-agent-api`, and the duplicate check compared only against
  its own agent's id, so an endpoint declared under agent A could claim agent
  B's reserved name. `normalizeV2` then synthesized B's Agent API endpoint
  anyway, producing two entries with one id; `syncNormalizedConfig` resolved
  the collision silently, dropping A's endpoint and handing the id to B with
  no error or warning. Both checks now run against every agent in the config.
  Reachable from YAML, and through the provisioning API by a token scoped only
  to A. A `publishers[].endpoint.id` could claim a reserved name the same way —
  its uniqueness check compares against agent and endpoint ids, and the
  synthesized Agent API ids are in neither set — so it is now checked too.

## [2.0.0-rc.12] - 2026-08-07

### Fixed

- `torana doctor` reported `C004 … getMe failed (404)` for a Buzz-only agent.
  A v2 agent with no Telegram endpoint is projected into the legacy bot shape
  with a `disabled-buzz-only:<id>` sentinel in place of a token — explicitly
  not a credential, and the runtime never builds a TelegramClient from it. The
  check did, so every correctly configured Buzz-only agent produced a standing
  doctor failure that a deployment gate cannot distinguish from a real one.
  C004 now reports `skip` for those agents and makes no Telegram request. The
  sentinel is exported as `isBuzzOnlyBotToken` so the projection and its
  consumers cannot drift apart again.

## [2.0.0-rc.11] - 2026-08-07

### Fixed

- An outbound-only publisher's presence was inconsistent across the three sites
  that publish it. The heartbeat announced `online`, but the connect-time path
  and the stop/drain path were both gated on the endpoint being a
  conversational agent. A publisher therefore sat dark for a full heartbeat
  interval after every connect and reconnect, and — worse — a stopped publisher
  kept showing `online` until the relay's 180 s presence TTL lapsed, because
  nothing ever announced its `offline`.

  Publishers are on the presence feed on the same terms as conversational
  endpoints: the dot reports that the identity's connection is live and its
  feed is flowing, not that it will answer a message. All three sites now
  agree.

  This inconsistency predates the presence-heartbeat work, but that work made
  the heartbeat half fully effective: the rate limiter had been masking it into
  an intermittent announcement.

## [2.0.0-rc.10] - 2026-08-06

### Added

- `buzz-backend-torana`, a Buzz Desktop remote-agent provider that deploys an
  agent onto a Torana gateway, so an operator can move an agent's runtime off
  their Desktop from the Desktop's own UI. It implements the L2
  `info`/`deploy` protocol at `protocol_version: 1` and ships as a compiled
  single-file executable for darwin-arm64 and linux-x64, checksummed in the
  release, because it runs on a machine that may have no Bun.

  It creates endpoints, never agents or runners: the target agent must already
  exist in the gateway's config. Deploy is one `PUT` followed by polling —
  never a second create attempt inside the same call — and it refuses a null
  auth tag, a relay-mesh or desktop-loopback relay, a plaintext gateway URL,
  and reserved identity env vars, each with a message that says why. Knobs
  Torana owns (system prompt, model, timeouts, parallelism) are reported back
  as unapplied rather than silently dropped.

  The gateway bearer lives in the provider's own `~/.config/torana/provider.json`
  (mode 0600), never in the Desktop-persisted provider config. Secrets are held
  in memory only, sent over TLS only, and scrubbed from every error the binary
  emits — the Desktop redacts provider output as well, but this does not rely
  on that. There is no stop path: Desktop "Stop" publishes `!shutdown`, which
  the endpoint honours. Windows is unsupported pending an upstream discovery
  fix. See `src/provider/README.md`.

- Buzz endpoints can be created at runtime instead of only in `torana.yaml`:
  `PUT|GET|DELETE /v1/admin/buzz/endpoints/<id>`, the surface a Buzz Desktop
  provider deploys against. A provisioned endpoint is stored in the gateway
  database and re-validated through the same config schema as a YAML one, so
  identity checks, auth-tag authorization, unique endpoint ids, and
  shared-identity rules apply unchanged. `BuzzTransport` gained runtime
  add/replace/remove of endpoint supervisors, so a deploy needs no restart.

  The routes require a new dedicated `endpoints:admin` scope — config
  validation rejects a token that combines it with `ask` or `send`, because
  these are the only `/v1/*` routes meant to be reachable from outside the
  deployment. Bodies are capped at 64 KiB, and a token's `bot_ids` still bound
  which agents it may attach endpoints to.

  Every deploy names an `agent_id` that already exists in YAML with a runner:
  provisioning creates endpoints, never agents or runners. `PUT` is idempotent
  and keyed on the pubkey derived from the submitted key, so an identical
  deploy against a live endpoint is a strict no-op, one against a disabled
  endpoint replaces and restarts it, and a second live endpoint for one
  identity is refused. A YAML endpoint always wins a collision, by id or by
  identity.

  Secrets are sealed at rest with AES-256-GCM under a new required
  `TORANA_PROVISIONING_SECRETS_KEY`, bound to the endpoint id. The key is not
  in the database: a volume restored without it yields rows that fail closed,
  and startup refuses rather than running an endpoint nobody can account for.
  **Back the key up separately from the volume.** Doctor check `C029` reports
  whether every stored row decrypts, and `torana endpoints status` now labels
  each endpoint `yaml` or `provisioned`.

- Failed presence refreshes are now a health signal instead of a silent
  no-op. After `limits.presence_failure_threshold` (new, default 2)
  consecutive failures the endpoint reports `unhealthy` with
  `last_error: presence_stale` and fires one `workerDegraded` alert per
  episode, cleared by the next successful publish. `/health` gains
  `endpoints[].presence`, and `/metrics` gains
  `torana_endpoint_presence_publishes_total` (by outcome) and
  `torana_endpoint_presence_stale`.

- Config validation rejects `platforms.buzz.subscription.heartbeat_secs` of
  90 s or more while Buzz is enabled: at that cadence a single failed presence
  publish outlives the relay's 180 s TTL, which no rate-limit exemption can
  rescue.

### Fixed

- A healthy Buzz endpoint could show offline to other community members
  because of Torana's own rate limiter. The supervisor republishes presence
  every `platforms.buzz.subscription.heartbeat_secs` (default 30 s) while
  `limits.presence_min_interval_ms` (default 30 000 ms) suppressed any
  presence publish inside its window — the heartbeat sat exactly on its own
  rate-limit boundary, so publish-latency jitter or an interleaved
  conversation-driven presence signal dropped refreshes and stretched the
  effective cadence toward 60 s against the relay's 180 s presence TTL. The
  supervisor's lifecycle presence (connect and heartbeat) is now exempt from
  that limit, exactly as the clean-stop `offline` publish already was.
  Conversation- and runner-driven presence stays rate-limited.

- Buzz Desktop's remote-agent "Stop" was answered instead of obeyed. Stop
  publishes a stream message whose content is exactly `!shutdown`, mentioning
  the agent and signed by the owner; Torana routed it into an ordinary
  conversation turn, so the agent replied to its own stop command and kept
  running — the failure the remote-agents specification calls out as
  invariant I5. Such a message is now a control command: intake stops, the
  endpoint goes `draining`, in-flight turns finish (up to the new
  `limits.owner_shutdown_drain_ms`, default 30000), presence `offline` is
  published, and the endpoint is disabled durably. It stays down across a
  process restart; `torana endpoints resume` is the way back. Only the
  configured `owner_pubkey` can do this — on every `respond_to` setting,
  including `anyone` — and a message that merely contains `!shutdown` remains
  an ordinary prompt. Opt out per endpoint with `owner_shutdown: disabled`.

### Changed

- The pinned Buzz CLI moved from `desktop-v0.5.4` to `desktop-v0.5.5`
  (commit `8342dfcc5890b81a269a8ec3db73a8a56f76ce79`, Apple-silicon release
  asset `502011159`). The default `platforms.buzz.cli_sha256` is now
  `8f59ea1a877fce972ce1d0165b9deda457085c21ee2c36ef497b8038812fdac9` and
  doctor C024 names Buzz 0.5.5. The 0.5.5 command surface is identical to
  0.5.4 — the regenerated `cli-manifest.json` differs only in the binary
  checksum — so no broker policy classification changed. Deployments must
  rebuild their Linux `buzz` from the new tag in the same change that takes
  this Torana version; a new CLI with an older broker manifest, or the
  reverse, is not a supported pair.

### Migration

- Schema v7 adds the `provisioned_endpoints` table. Run
  `torana migrate --to 7` (or start with `--auto-migrate`). The upgrade is
  additive — no existing table changes — and a v6 database keeps working with a
  v6 binary if you need to roll back before any endpoint is provisioned.

## [2.0.0-rc.9] - 2026-08-05

Supersedes the 2.0.0-rc.8 tag, whose release run failed on the very bug fixed
below and published nothing.

### Fixed

- Opening the gateway database could fail outright with `database is locked`
  instead of waiting. `applyMigrations` leaves a fresh database in `delete`
  journal mode, so the first `GatewayDB` open changes the mode to WAL — a
  change that needs exclusive access — and `busy_timeout` was set _after_ that
  pragma, leaving it to run with SQLite's default timeout of zero. Any
  concurrent reader, including a second short-lived `torana` CLI invocation,
  made the open fail immediately. The timeout is now established first, so the
  open waits its full three seconds as intended.

- An `ask`-free `POST /v1/bots/:bot_id/send` targeting a Buzz `conversation`
  published the agent's answer as a reply to its own synthetic inbound. That
  inbound is recorded against the `<bot>-agent-api` endpoint and its external
  id (`agentapi:<n>`) names no event on the relay, so the emitted
  `["e", "agentapi:<n>", "", "reply"]` tag pointed at a parent that does not
  exist — the message was signed and delivered but never appeared in the
  channel feed, and could only be found by search. The answer is now published
  as a channel root when the source event does not belong to the
  conversation's own endpoint. Turns started by a real inbound still thread as
  before, and the forum path falls back to its thread root.

## [2.0.0-rc.7] - 2026-08-04

### Added

- `agent_api.tokens[].buzz_tools` (default `false`) grants a token's `ask`
  turns a session-scoped Buzz capability, so an agent reached through
  `POST /v1/bots/:bot_id/ask` can drive the pinned Buzz CLI through the
  credential broker during its turn. Previously only managed conversation
  turns received one, and `torana buzz` failed inside an `ask` turn with
  `no Buzz capability is available for this runner session`. The capability
  is minted per turn against the agent's `tools.buzz.default_endpoint_id`,
  expires with the turn's own timeout, and is revoked when the turn ends —
  including turns still running behind a `202`. Config load rejects the flag
  when the target agent has no `tools.buzz` block or sets no
  `default_endpoint_id`. `POST /v1/bots/:bot_id/send` was never affected.

  Note that the grant carries the agent's entire `tools.buzz` policy profile;
  it does not narrow it per token or per channel.

## [2.0.0-rc.6] - 2026-08-03

### Fixed

- Keep Buzz outbound delivery connected while shutdown drains accepted turns
  and their durable outbox operations.
- Recover conversational Buzz replies rejected for stale timestamps by
  atomically re-signing only after an explicit non-acceptance response;
  ambiguous retries and publisher event identities remain unchanged.

## [2.0.0-rc.5] - 2026-08-03

### Changed

- Upgrade the pinned Buzz CLI and broker command manifest from Desktop 0.5.3
  to 0.5.4, including read-only project discovery and maintainer project
  mutations.
- Add a repeatable, provenance-first Buzz CLI upgrade and deployment runbook.

### Security

- Treat project deletion as a dangerous custom-only broker operation requiring
  explicit acknowledgement. Unknown upstream commands continue to fail closed.
- Consume Buzz 0.5.4's patched Nostr dependency graph when downstream images
  rebuild the pinned CLI from the released tag and locked Cargo graph.

## [2.0.0-rc.4] - 2026-08-03

### Fixed

- Explicit publisher doctor probes now run safely beside a live gateway: they
  skip the unrelated single-writer intake lock and avoid authenticating any
  unselected Buzz endpoint.

## [2.0.0-rc.3] - 2026-08-03

### Added

- An explicit disabled publisher doctor probe that authenticates transiently,
  confirms exact configured destination membership, and never publishes.

### Security

- Publisher activation now fails closed when the requested publisher is
  unknown, relay authentication fails, or the pinned destination is absent.

## [2.0.0-rc.2] - 2026-08-03

### Added

- Outbound-only service publishers with no runner or inbound subscription,
  scoped publisher authentication, strict publish/status HTTP routes, and a
  content-safe CLI.
- Atomic idempotent Buzz enqueue, immutable signed-event retries, bounded
  publisher backlog/retention/metrics, and SQLite schema v6.

### Security

- Publisher identities and destinations are server-pinned; key derivation,
  owner authorization, membership health, scope separation, redaction, request
  deadlines, and logical database caps fail closed.

### Migration

- Run `torana migrate --to 6` under the documented snapshot and rollback gate
  before configuring publishers. Do not run a v5-only binary after accepting a
  publisher request.

## [2.0.0-rc.1] - 2026-08-02

### Added

- Config v2 multi-platform agents with Telegram, Buzz-only, and combined
  endpoint layouts; durable isolated conversation sessions and explicit aliases.
- Authenticated Buzz relay intake, signed exact-event outbox delivery, native
  edits/deletes/reactions/forums/workflows, hardened media, endpoint lifecycle,
  metrics, operator APIs/CLI, and an endpoint-scoped credential broker.
- Disabled-by-default Buzz and agent-team examples, a gated 24-hour mixed
  platform soak, fault injection, and the Phase 11 security/release review.

### Changed

- Package positioning and documentation now describe a multi-platform gateway.
- Config v1 remains accepted. `bots[].id` is exposed as the `agent_id` alias
  during the compatibility window; `agent_api.side_sessions` and Claude
  `pass_continue_flag` are deprecated in favor of `sessions.*` and managed
  conversation continuity.

### Migration

- Config v2 requires schema v5. Use the rc.10 compatibility bridge to migrate
  and retain that tested binary/config pair as the lossless rollback target.
- The stable 2.0.0 tag and package publication remain blocked on the real-relay,
  restart-continuity, 24-hour soak, canary, and rollback gates.

## [1.0.0-rc.10] - 2026-08-01

### Added

- Config v2 with normalized agents, endpoints, sessions, alert targets, and a
  read-only `torana config upgrade --from v1 --to v2` conversion command.
- Schema v5 normalized persistence, sanitized migration dry-runs, automatic
  pre-v5 snapshots, incremental auto-vacuum, and rehearsed emergency restore.

### Changed

- Telegram and Agent API now dual-write legacy and normalized state so the
  compatibility bridge can run v1 config on schema v3 or v5 and remain the
  lossless rollback target for the 2.0 rollout.
- Conversation and outbox delivery now preserve platform string identifiers;
  v1 behavior and Telegram request compatibility remain unchanged.

### Fixed

- Clean CI and release installs now include the pinned Phase 0 Buzz transport
  dependencies. The installed-Buzz CLI golden test remains mandatory when the
  binary is present and skips on generic runners; protocol, cryptographic, and
  relay tests remain mandatory everywhere.
- The release dependency audit is clean: `js-yaml` is upgraded past its
  quadratic merge-key advisory and vulnerable transitive `brace-expansion`
  releases are overridden with the compatible patched version.

## [1.0.0-rc.9] - 2026-05-07

### Changed

- **Lazy first sendMessage so Telegram pushes a notification on each
  reply.** The streaming UX previously sent an eager `👀 thinking...`
  placeholder immediately on every turn and edited the response into it
  as the runner produced text. Telegram doesn't push notifications for
  edits, so users got no ping when the response was actually ready —
  they had to keep checking the chat. The placeholder is gone. The
  user-visible message is now sent fresh: on the first streamed
  text_delta, or (for non-streaming runners) at finalize time. That
  fresh `sendMessage` is what triggers the device notification. While
  the runner is still thinking, the existing 4-second `sendChatAction`
  typing indicator is the "received your message" feedback. Side
  benefits: an empty response no longer leaves an orphan `thinking...`
  in the chat, a turn cancelled before any output is silent (no orphan
  placeholder), and we drop a redundant `editMessageText` per turn when
  the initial send already carried the final text.

### Fixed

- **Dashboard proxy wedge after multi-hour uptime**
  ([#16](https://github.com/jvbutterfield/torana/issues/16)). `/dashboard/*`
  would stop responding after multi-hour uptime while every other torana
  route stayed healthy. Two leaks fed it: (1) bun's HTTP client parked each
  torana → upstream connection in its keepalive pool with no idle eviction,
  so the pool grew monotonically until it hit an upstream cap and blocked
  all new dashboard requests; (2) when a browser disconnected from a
  long-lived response (the dashboard's SSE `EventSource`), the inbound
  abort was not propagated to the upstream `fetch`, so the upstream socket
  was held open until the upstream itself timed out. The proxy now sets
  `Connection: close` on the upstream request (bounds pool growth on a
  per-request basis — the proxy target is loopback by default, so the
  per-request TCP setup is ~free) and threads `req.signal` into the
  upstream `fetch` so client disconnects abort the upstream call. No
  config change required.

## [1.0.0-rc.8] - 2026-04-27

### Added

- **`dashboard.forward_full_request` opt-in passthrough.** Dashboards that own
  their own auth (login forms, session cookies, mutating actions) can set
  `dashboard.forward_full_request: true` to (a) forward all standard methods
  (GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD) instead of GET-only and (b) preserve
  `Authorization` and `Cookie` on the inbound request so the upstream can
  validate bearers and session cookies. Default remains `false` — the safe
  GET-only header-stripping mode for dashboards with no auth of their own.
  `Proxy-Authorization`, `Idempotency-Key`, `X-Telegram-Bot-Api-Secret-Token`,
  and `Host` are still stripped regardless, and `redirect: "manual"` still
  blocks SSRF-via-302. Combining the new flag with
  `allow_non_loopback_proxy_target: true` emits a load-time warning since
  client credentials then cross a network boundary; document the upstream
  trust assertion before enabling. Closes [#14](https://github.com/jvbutterfield/torana/issues/14).

### Fixed

- **Dashboard proxy was GET-only and stripped Authorization/Cookie
  unconditionally** ([#14](https://github.com/jvbutterfield/torana/issues/14)),
  blocking dashboards that authenticate their own users — login `POST` was
  rejected before reaching the upstream and session cookies never round-tripped.
  Default behaviour is unchanged; opt in via `dashboard.forward_full_request`
  (see Added).

## [1.0.0-rc.7] - 2026-04-25

### Security

Thirty-five security and reliability fixes landed together ahead of
the 1.0.0 cut, in three batches: thirteen items from the original
rc.7 review (two P0, six P1, and the five P1/P2/P3 hardening items
already in flight when the deep review kicked off), nine P2 from the
follow-up deep review, and thirteen more from a targeted post-review
pass (sanitization gaps in two more handlers, outbox crash-window
narrowing, alerts redaction, and the Telegram rate-limit / polling
reliability stack). Three items are hard-breaking config changes and
eleven more are softer behavior shifts — see **Upgrade notes** below
before deploying.

#### P0 fixes

- **Dashboard proxy hardening.** The dashboard was forwarding every
  request header verbatim to `proxy_target` (Authorization, cookies,
  Idempotency-Key, X-Telegram-Bot-Api-Secret-Token), had no auth on the
  mount, and followed backend redirects. A caller reaching the gateway
  port could use it as an open credential-exfil + SSRF gadget. Now:
  sensitive headers are stripped before forwarding; `redirect: "manual"`
  disables redirect-following; the new `dashboard.allow_non_loopback_proxy_target`
  flag refuses non-loopback `proxy_target` by default.

- **Webhook body size cap.** The Telegram webhook handler called
  `req.json()` after the secret check with no size limit. Anyone who
  obtained the shared webhook secret could force the gateway to buffer
  arbitrarily-large chunked bodies into memory. Capped at 1 MiB via a
  Content-Length precheck + streaming reader with abort-on-overflow; 413
  on both paths.

#### P1 fixes

- **Marker-injection rejected in send text.** `wrapSystemMessage` produces
  `[system-message from "<source>"]\n\n<text>` as the framing the runner
  uses to distinguish operator-initiated turns from user-initiated ones.
  Caller-supplied `text` that contained a second line-starting
  `[system-message from "forged"]\n\n…` could spoof a second envelope
  attributing subsequent content to any source label the caller chose.
  `SendBodySchema` now rejects any text matching the marker-injection
  regex (anchored on line boundaries so inline prose mentioning the
  syntax is still allowed); `wrapSystemMessage` re-asserts.

- **Multipart magic-byte MIME validation.** Agent-API multipart and
  Telegram document uploads trusted the caller's declared Content-Type.
  A caller could upload arbitrary bytes with a declared allowlisted MIME
  and the gateway would write them as `<uuid>.png` (or .pdf, etc.) and
  hand the on-disk path to a runner. Now every attachment's actual bytes
  are sniffed (PNG/JPEG/WEBP/GIF/PDF magic) and must match the declared
  MIME; mismatches return `attachment_mime_not_allowed`.

- **Migration serialization.** Two concurrently-started torana processes
  that both saw `user_version < TARGET` could race each other's migration
  apply. Added an OS file lock (`<dbPath>.migrate.lock`) with PID +
  timestamp; stale locks older than 10 minutes are stolen, fresh locks
  cause the second process to fail with a clear error.

- **Crash recovery skips Telegram notify for agent-API turns.**
  `runCrashRecovery` was sending a "⚠️ Gateway restarted …" message into
  the user's DM for any interrupted running turn. For Agent-API
  `ask`/`send` turns that no end user had initiated, this leaked the
  existence of a backend job into the user's chat. Now Agent-API turns
  are interrupted silently; external callers see the outcome via
  `GET /v1/turns/:id` as before.

- **DB file permissions locked to 0600.** `gateway.db` + its WAL / SHM
  sidecars contain every bot token, every inbound Telegram payload
  (text + PII), and every agent-API turn row. They inherited the process
  umask (typically 0644). Now chmod'd to 0600 on every open (best-effort
  — logs and carries on under non-POSIX filesystems). New doctor check
  **C015** warns on pre-existing group/world-readable DB files so
  operators on upgrade notice any deployment that was created before this
  release.

- **Runner stdout/stderr redacted in per-bot log files.** The structured
  logger applied secret redaction; the per-bot log file (written via
  `logStream.write(chunk)`) bypassed it. A runner that leaked an API key
  on stderr — or a user that asked a runner to echo a secret back on
  stdout — ended up with the raw value in plaintext on disk. All 12
  subprocess-output write sites across the three runners now go through
  `redactString()`.

#### rc.7 initial fixes (the five that landed earlier in this branch)

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

#### P2 fixes (deep-review backlog folded in pre-cut)

Nine items the deep review surfaced as exploitable only by an authenticated
bearer (or strictly internal foot-guns) were originally deferred to rc.8.
They are now in rc.7 to land the full review on a single tag. None requires
config changes beyond the optional new fields below.

- **Telegram attachment write hardened against overwrite + symlink races
  (P2).** `src/core/attachments.ts` now opens the destination with
  `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW`. On `EEXIST` (rare
  `update_id` collision across restarts/replays, or anything staged by
  a less-trusted process), the write retries under
  `<update_id>-<index>-<uuid><ext>` for up to 3 attempts. A symlink
  staged at the destination is rejected with the new
  `ATTACHMENT_SYMLINK_REJECTED` error and never followed.

- **`/v1/turns/:turn_id` timing oracle closed (P2).** Both the
  malformed-id branch and the valid-but-not-yours branch now go through
  the DB lookup, so an authenticated probe can no longer distinguish
  "id was malformed" from "id is valid but you don't own it" via
  response timing. Both still return `404 turn_not_found`.

- **`/v1/bots` no longer leaks `runner_type` by default (P2).** A
  bearer-token holder used to learn each bot's runner backend
  (`claude-code` / `codex` / `command`) — useful intel for an attacker
  picking which side-channel (prompt-injection vs tool-use vs shell)
  to probe. Set the new `agent_api.expose_runner_type: true` if your
  callers depend on the field.

- **Agent-API `invalid_body` / `internal_error` responses now use
  canonical `detail` strings (P2).** Exception text from
  `req.formData()`, `JSON.parse`, and `insertSendTurn` (raw multipart
  parser internals, SQLite column / constraint detail, file-path
  errnos) is logged server-side at warn / error level but never echoed
  into the response body.

- **Codex `thread_id` validated before persisting + replaying as argv
  (P2).** The codex JSONL parser was forwarding `thread.started.thread_id`
  verbatim. Bun's argv-element separation prevented shell-metacharacter
  injection at the flag boundary, but a control-char-bearing id (newline
  / NUL / ANSI escape) still landed in argv, on disk in `worker_state`,
  and in `ps` output. The parser now rejects ids that fail an anchored
  `^[A-Za-z0-9_-]{1,128}$` regex; the offending event is dropped (the
  side-session is abandoned, which is the safe failure mode).

- **`GatewayDB.query()` renamed to `_unsafeQuery()` (P2 footgun).** The
  public method that returned a raw `prepare()` handle is now
  underscore-prefixed and renamed in every callsite. The new name makes
  the SQL-injection surface obvious so a future contributor cannot
  reach for it innocently. Internal API only — no external-caller
  impact.

- **`GatewayDB.dynamicUpdate` enforces a runtime column allowlist
  (P2).** The function built `UPDATE ${table} SET ${k} = ?` strings
  from caller-supplied object keys; static `Partial<RowShape>` typing
  was erased at runtime, so a future caller spreading untrusted JSON
  into the patch could have allowed attacker-controlled keys to become
  SQL identifiers. A static `UPDATABLE_COLUMNS` map per table now
  rejects unknown keys before any query is built.

- **`runner.secrets` map for inlined-secret redaction (P2).** Operators
  who can't easily indirect via `${VAR}` (Docker secrets, sealed
  configs, etc.) needed a way to mark inlined values as secret. A new
  `bots[].runner.secrets: { KEY: VALUE }` map registers each value
  with the log redactor at config-load time. `runner.env` and
  `runner.secrets` cannot share keys (config-load fails with a clear
  error). `${VAR}` indirection remains the recommended pattern; this
  is the explicit fallback.

- **Per-token Agent-API side-session cap (P2).** The pool already
  enforced `max_per_bot` and `max_global`, but a token whose `bot_ids`
  spanned many bots could hold `max_per_bot * len(bot_ids)`
  concurrent side-sessions and starve other tokens that shared any of
  those bots. Two new optional knobs close the gap:
  `agent_api.tokens[].max_concurrent_side_sessions` (per-token
  override) and `agent_api.side_sessions.max_per_token_default`
  (default `8` — applies when the per-token override is unset). A
  token at its cap returns 429 with the new `token_concurrency_limit`
  code (distinct from `side_session_capacity`).

#### Followup hardening from rc.7 review pass

Found by a focused review after the initial nine-item P2 fold-in
landed. Each is small individually; together they remove the self-DoS
lever an attacker could induce by causing per-chat throttling, narrow
the outbox crash-window dup risk, close two more agent-API
sanitization gaps, and surface alerts hardening + polling reliability
issues that the original deep review skipped.

- **Two more agent-API error-detail leaks closed.** `body.ts:83`
  (stream-reader exception text echoed in `invalid_body` detail) and
  `ask.ts:247` (catch-all `internal_error` echoed exception text).
  Both now log the raw cause server-side and return canonical detail
  strings — same pattern as `send.ts` from the rc.7 P2 cherry-pick.
- **Outbox `in_flight` marker narrows the crash-window dup risk.** A
  crash between Telegram POST success and `markOutboxSent` previously
  left the row in `pending`/`retrying` and re-sent on restart —
  duplicate Telegram message with no operator visibility. The row is
  now marked `in_flight` with a 60s grace window before the POST; on
  restart the new `OutboxProcessor.recoverInFlight()` logs a warn per
  affected row with explicit dup-risk caveat, and the grace window
  auto-recovers via `getPendingOutbox`. Telegram has no message-history
  readback so true zero-dup isn't reachable, but the window narrows
  from "any crash" to "crash + restart inside 60s".
- **Alert text now goes through the log redactor.** `webhookSetFailed`
  forwards `err.message` from `setWebhook`, which can echo URL
  fragments (and `getWebhookInfo` URLs include the bot token). The
  `emit()` helper in `src/alerts.ts` now applies `redactString()`
  before `sendMessage`, mirroring `c8dd3a9`'s rule for runner stdout/
  stderr. Same fix also wires the dead catch path: `sendMessage`
  swallows Telegram errors and returns `{ok:false,...}`, so a failed
  alert was being logged as `"alert sent"` — now `result.ok` is
  checked explicitly with a warn on false.
- **`TelegramError` parses `Retry-After` (rc.7 review F2).** The HTTP
  `Retry-After` header (RFC 9110, seconds) and the Telegram error
  envelope's `parameters.retry_after` are now both parsed into
  `TelegramError.retryAfterMs`. Header takes precedence — some
  intermediaries override the envelope at the CDN edge.
  `retry_after: 0` is treated as missing so we don't skip natural
  backoff on flaky 5xx. `SendResult` and `EditResult` surface
  `retryAfterMs` to callers.
- **Telegram requests have a 30s default timeout (rc.7 review F4).**
  `api()` now passes `AbortSignal.timeout(30_000)` to every fetch.
  `getUpdates` uses a long-poll-aware timeout (`timeout_secs * 1000 +
5s buffer`) composed via `AbortSignal.any()` with the caller's
  shutdown signal. Closes the wedge where a stuck TCP connection
  could pin the entire dispatcher.
- **Polling honors Retry-After (rc.7 review F6).** `BotPoller.loop`
  now sleeps `max(backoff, retryAfterMs)` when a TelegramError
  carries a server-asked cooldown. Hammering before the cooldown
  expires extends the throttle.
- **Webhook setup classifies transient vs permanent (rc.7 review F7).**
  `setWebhook` failures at startup were previously persistent —
  any failure marked the bot disabled until manual re-enable. Now
  429 / 5xx / network errors are logged as transient and the bot
  stays enabled (the next gateway start retries). 401 / 403 / other
  4xx still disable the bot for operator attention.
- **Polling offset advances only on success (rc.7 review C-1).**
  Previously the offset bumped to `max(update_id)` even when handlers
  threw — silently losing updates because the dedup ledger never
  wrote a row. Now the loop stops processing on the first throw and
  holds the offset; Telegram redelivers from the failing id on the
  next poll, so a transient cause (sqlite-locked, disk-full, etc.)
  gets a real retry. **See upgrade note 14** — this is a behavior
  change for any deployment that was relying on the lossy semantics.
- **Polling failureCount is capped (rc.7 review C-2).** Previously
  the counter ticked up forever on cyclic failures (every Nth poll
  throws). Cap at 16 — well past the saturation point of
  `nextBackoffMs` — so it stays informative in logs and metrics.
- **Outbox shards per-bot (rc.7 review F1).** The previous global
  mutex serialized all rows across all bots; a 429 on chat A blocked
  every later row regardless of bot. Now `processPending` groups
  rows by `bot_id` and runs the per-bot loops via `Promise.all`,
  while keeping each bot's queue serial (intra-chat ordering
  preserved).
- **Outbox respects Retry-After without burning the retry budget
  (rc.7 review F5).** New `markOutboxRateLimited` schedules a retry
  at the server-asked time without bumping `attempt_count`. A
  cooperative attacker who keeps a chat throttled longer than
  (max_attempts × backoff_cap) used to dead-letter legitimate
  replies and trigger the `outboxFailures` operator alert; now the
  retry budget is reserved for genuine deliverability failures.
  Capped at 5 minutes against a malicious upstream.
- **Streaming pauses edits during a 429 (rc.7 review F3 + F9).**
  `fireAndForgetEdit` now returns the `EditResult`. `StreamManager`
  observes 429 + `Retry-After` and sets a per-bot
  `rateLimitedUntil` timestamp; subsequent flushes during the
  cooldown skip the `editMessageText` call (the buffer accumulates,
  next non-rate-limited flush picks up the latest text). Typing
  pings (`sendChatAction`) are also gated on the cooldown — they
  count against per-bot 429 limits and produce no user-visible
  benefit while edits are paused.
- **Runner sandbox boundary documented explicitly.** `docs/security.md`
  gains a `## Runner isolation` section stating plainly that torana
  does not sandbox runners; `acknowledge_dangerous: true` is a
  documentation gate, not enforcement; the operator owns the
  isolation boundary. `docs/runners.md` gains a "Concrete isolation
  patterns" subsection (Docker / firejail / unprivileged-UID + chroot
  / gVisor / `sandbox-exec`). Loader error messages now link to the
  patterns subsection.

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

6. **`dashboard.proxy_target` is now loopback-only by default.** If you
   proxy the dashboard to an upstream on a non-loopback IP, add
   `dashboard.allow_non_loopback_proxy_target: true` alongside
   `proxy_target`. The gateway will otherwise refuse to start. The
   proxy also now strips Authorization / Cookie / Idempotency-Key /
   X-Telegram-Bot-Api-Secret-Token / Host / Proxy-Authorization before
   forwarding, and sets `redirect: "manual"` — no config change needed
   for those.

7. **DB file permissions tighten to 0600 on open.** Pre-existing
   deployments with a group/world-readable `gateway.db` (default umask
   on many Linux hosts creates these as 0644) will have their DB
   chmod'd to 0600 the next time torana opens it. Run `torana doctor`
   to confirm — the new C015 check reports the on-disk mode and fails
   if it's still loose (e.g. on filesystems that don't support POSIX
   perms).

8. **Send callers: text containing a line-leading `[system-message from
"…"]` will now be rejected with `400 invalid_body`.** Incidental
   prose mentioning the marker syntax inline is still accepted. Only
   line-anchored matches are refused. If you have legitimate tooling
   that forwards other bots' log output verbatim, strip leading
   whitespace + the marker prefix before sending.

9. **Webhook body size is capped at 1 MiB.** Telegram updates are
   typically < 64 KiB so this is a wide margin; no action needed
   unless your integration routes unusually-large payloads through the
   webhook endpoint.

10. **Multipart attachments must match magic bytes for their declared
    MIME.** A caller uploading a JPEG with `Content-Type: image/png` now
    gets `attachment_mime_not_allowed`. Fix by sending the correct MIME.
    The same check applies to Telegram documents (photos are always
    JPEG by Telegram's API convention, so this only affects documents).

11. **Per-token Agent-API side-session cap defaults to `8`.** Any
    bearer token without an explicit `max_concurrent_side_sessions`
    inherits `agent_api.side_sessions.max_per_token_default` (default
    `8`). Tokens that were genuinely holding more than 8 concurrent
    side-sessions in rc.6 will start receiving 429
    `token_concurrency_limit` once the (8+1)th acquisition happens —
    raise the per-token field, or raise the default, before deploying.
    `max_per_bot` and `max_global` still apply; this is a third
    dimension on top of them.

12. **`/v1/bots` omits `runner_type` by default.** Callers that
    consumed the `runner_type` field on bot listings (e.g., to render
    runner-specific UI, to skip codex-only features against a
    claude-code bot, etc.) need to set
    `agent_api.expose_runner_type: true` to restore the field.
    `torana bots list` and the in-tree CLI no longer rely on it; only
    custom integrations are affected.

13. **Agent-API error response `detail` strings are now canonical.**
    Clients that string-matched the previous exception-derived
    `detail` text (e.g., looking for `"Failed to parse FormData"` to
    distinguish parser errors from other 400s) will now see fixed
    canonical strings like `"malformed multipart body"` and
    `"internal error"`. Match on the `error` code field instead — the
    set of codes is stable.

14. **Polling: a thrown update handler now holds the offset.** A
    handler that throws on update N causes the polling loop to stop
    processing that batch (updates N+1..M in the same batch are NOT
    processed) AND skip the offset bump — Telegram will redeliver
    from N on the next poll. Pre-fix: the loop continued to process
    later updates and bumped the offset to `max(update_id)`,
    silently losing the failing update because `inbound_updates`
    never recorded its row. The new semantic is a strict improvement
    for transient failures (sqlite-locked, disk-full) but means a
    persistently-failing update will now block subsequent updates
    until the underlying cause is fixed. If a handler is throwing
    for non-transient reasons (a malformed payload your code can't
    parse, an unrecoverable schema error, etc.), `torana doctor` and
    the per-bot log file will surface it immediately — investigate
    the throw rather than relying on the old lossy fast-forward.

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
