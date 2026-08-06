# Buzz remote-agents conformance and provider plan

**Status:** Implemented. Phases 1–5 are complete and gated; Phase 6 is complete
for everything a repository can produce, and its live-environment steps (release
cut, image pin, migration, deploy-and-observe, record conversion, shutdown
drill, manual Desktop deploy) remain outstanding with acceptance criteria in
[release-readiness.md](release-readiness.md). Per-phase evidence, including the
two places this plan's assumptions turned out to be wrong, is in
[tasks/buzz-remote-agents-progress.md](../tasks/buzz-remote-agents-progress.md).

**Objective:** make Torana-hosted Buzz agents fully independent of the Buzz
Desktop app's lifecycle and fully conformant with the Buzz remote-agents
specification, and let operators deploy agents from Buzz Desktop directly onto
Torana through the provider protocol. Includes upgrading the pinned Buzz
version from `desktop-v0.5.4` to the latest release, `desktop-v0.5.5`.

**Spec basis:** `block/buzz` `docs/remote-agents.md` (spec pinned at
`28ae6cd21`), NIP-OA, NIP-AA, `ARCHITECTURE.md`. Key facts this plan relies on:

- Client-visible online status derives **only** from kind `20001` ephemeral
  presence events self-signed by the agent key; relay-side TTL is **180 s**
  against a reference 60 s heartbeat (invariant I3).
- A conforming launcher at Layer 1 is anything that holds the agent nsec, the
  NIP-OA auth tag, and the relay URL. The relay authenticates the keypair,
  never the launcher. Torana already conforms at this layer.
- Desktop `backend: Local` agents are spawned and supervised by the Desktop
  app (orphan sweep, instance reaper); their runtime dies with the app. The
  durable fix is a **deployed provider-backed** record plus a provider that
  targets Torana.
- Desktop "Stop" for a remote agent is a relay `!shutdown` message from the
  owner; the host must drain, publish presence `offline`, and stay down
  (invariant I5). "Start" is an unconditional provider `deploy` with
  reconciliation semantics.
- Upstream Known Defects that shape our behavior: deploy payload may omit
  `owner_pubkey` when `auth_tag` is null (Defect 3); `protocol_version` is not
  checked before the nsec is sent to the provider binary (Defect 5); the
  inactivity reaper does not exist in the upstream harness (Defect 4).

## Pinned identities for this plan

| Item                      | Current                                                   | Target                                                                      |
| ------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| Buzz release tag          | `desktop-v0.5.4`                                          | `desktop-v0.5.5` (published 2026-08-05)                                     |
| Resolved commit           | `651f6372754e60e3f936b3397040eb0f1e44c9f3`                | `8342dfcc5890b81a269a8ec3db73a8a56f76ce79`                                  |
| Apple-silicon asset       | GitHub asset `500377749`, `Buzz_0.5.4_aarch64.app.tar.gz` | GitHub asset `502011159`, `Buzz_0.5.5_aarch64.app.tar.gz`, 97,561,748 bytes |
| Archive SHA-256           | `b2bb31fe…39b5c0`                                         | `7fe09906…1520e3` (recorded Phase 1)                                        |
| Installed `buzz` SHA-256  | `97a80164…a770`                                           | `8f59ea1a…2fdac9` (recorded Phase 1)                                        |
| CDHash / Team ID          | `2d19fc6b…0d724` / `EYF346PHUG`                           | `92f000da…6f833` / `EYF346PHUG` (unchanged)                                 |
| Remote-agents spec commit | n/a (not previously pinned)                               | `8342dfcc…ce79` tree (supersedes `28ae6cd21`; see Phase 1 §4)               |

The 0.5.4→0.5.5 compare (45 commits, 300 files) shows no provider-protocol,
presence, or NIP-42/NIP-OA changes; it is Desktop UI work plus NIP-AM and ACP
doc amendments. Two features may add CLI commands (Buzz Term, multi-repo
projects), so the Phase 1 manifest diff review is mandatory, not a formality.

## Scope

1. **Phase 1 — version pin upgrade** to `desktop-v0.5.5` per the
   [CLI upgrade runbook](buzz-cli-upgrades.md).
2. **Phase 2 — presence heartbeat hardening** so a healthy Torana endpoint can
   never show offline due to Torana's own rate limiter.
3. **Phase 3 — owner `!shutdown` conformance** (invariant I5).
4. **Phase 4 — dynamic endpoint provisioning API** in Torana (prerequisite for
   the provider).
5. **Phase 5 — `buzz-backend-torana` provider binary** implementing the L2
   `info`/`deploy` protocol so Buzz Desktop can deploy agents onto Torana.
6. **Phase 6 — rollout**: record conversion, deployment image update, canary,
   evidence.

Out of scope: implementing inactivity auto-stop for Buzz endpoints (upstream
Defect 4 — the reaper contract is not yet real; revisit when upstream ships
it); presence-on-crash (the 180 s relay TTL is the accepted mechanism, per
spec); key or auth-tag rotation (explicitly forbidden by the runbook for an
ordinary upgrade).

**Cross-repo note:** Phases 4 and 6 include companion changes in the
`agent-team` deployment repo (gateway-proxy allowlist + tests, env contract,
image pin, runbook updates). Land the proxy allowlist and env-contract change
**before** the Torana release that ships the admin routes is deployed, so the
routes are never live without their edge policy.

**Process:** one commit per phase tagged with its user-story id per the
repository convention, continuing the existing sequence (last used: `US-020`):
Phase 1 = `US-021` … Phase 6 = `US-026`, with a progress-tracker pin commit
after each gate. Every phase's
tests must cover failure paths and boundary conditions, not just happy paths.

---

## Phase 1 — pin upgrade to desktop-v0.5.5 (US-021)

Follow [buzz-cli-upgrades.md](buzz-cli-upgrades.md) §1–3 exactly.

1. **Provenance (§1).** Install Buzz Desktop 0.5.5. Record tag, commit
   `8342dfcc…ce79`, asset id `502011159`, size, archive SHA-256, installed
   binary SHA-256, CDHash, Team ID (`EYF346PHUG` expected unchanged). Update
   `spike/buzz-transport/artifact-provenance.json`; `bun run provenance:check`
   must pass.
2. **Manifest (§2).** Regenerate `cli-manifest.json`; diff against tracked.
   Explicitly review any new command groups from Buzz Term and multi-repo
   projects. Classify every new verb into `READ_ONLY_VERBS`,
   `COLLABORATE_ADDITIONS`, `MAINTAINER_ADDITIONS`, or
   `DANGEROUS_BUZZ_COMMANDS` in `src/broker/buzz-policy.ts`. Anything that
   starts processes, opens terminals, or mutates repos defaults to dangerous
   or maintainer, never collaborate.
3. **Pins.** Update `BUZZ_CLI_PIN` (version `0.5.5`, tag `desktop-v0.5.5`,
   commit `8342dfcc…ce79`) in `src/broker/buzz-policy.ts`; default
   `cli_sha256` and normalized default in `src/config/v2.ts`; doctor C024
   expectations; policy tests; both byte-identical skill copies; configuration
   docs and examples; changelog. `rg '0\.5\.4|651f6372|97a80164'` to find
   stragglers — preserve clearly historical evidence (Phase 0 findings keep
   the 0.5.4 identities as history; add 0.5.5 as current).
4. **Spec re-pin.** Diff `docs/remote-agents.md`, `docs/nips/NIP-OA.md`,
   `docs/nips/NIP-AA.md` between `28ae6cd21` and `8342dfcc…ce79`. If normative
   content changed, stop and amend this plan before Phase 2.

   **Outcome (recorded 2026-08-06):** `28ae6cd21` is an ancestor of the
   `desktop-v0.5.5` tree, but `docs/remote-agents.md` moved after it (89
   changed lines). `NIP-OA.md` and `NIP-AA.md` are byte-identical between the
   two commits. Going forward the spec pin is the `8342dfcc…ce79` tree, not
   `28ae6cd21`. Most of the delta is citation re-pinning
   (`c1bca1b56`/`b4f4ed1a6` → `28ae6cd21`, the commit at which the spec merged
   to `main`) plus line-number refreshes. Two **normative** changes:
   - **I3 presence TTL is 180 s, not 90 s** (`PRESENCE_TTL_SECS`,
     `buzz-pubsub/src/presence.rs:16`; upstream #3783 raised it to preserve a
     three-heartbeat expiry window after the Desktop heartbeat moved to 60 s).
     The spec now states explicitly that I3 promises the staleness window is
     _bounded_, not its width. **No plan amendment needed** — this plan was
     already written against 180 s, so Phase 2's cadence arithmetic and Phase
     3's stay-down reasoning are unchanged and now match the pinned spec.
   - **New normative rule — "One create attempt per call".** A binding must
     not delete-recreate, within a single `deploy` call, a workload that the
     same call created; on a deterministic startup failure it must return an
     in-band error carrying the latest condition rather than churning a
     mint/create cycle every poll interval. **Plan amendment:** Phase 5 §3 now
     carries this as an explicit conformance requirement (one `PUT` per deploy
     call, then poll-only).

   Neither change invalidates a Phase 2–6 design decision, so Phase 2 may
   proceed.

5. **Gate (§3).** Full local gate green with the 0.5.5 CLI on `PATH`:
   typecheck, lint, format, `bun test`, build, verify-pack, skill parity,
   spike tests, `manifest:check`, `provenance:check`.

**Evidence to append:** provenance JSON diff, manifest diff summary with
classification rationale, gate output.

## Phase 2 — presence heartbeat hardening (US-022)

**Defect:** `monitorLifecycle()` (`src/platform/buzz/transport.ts:741`)
republishes presence every `subscription.heartbeat_secs` (default 30 s), but
`BuzzAdapter.signal()` (`src/platform/buzz/adapter.ts:522`) suppresses any
presence publish inside `limits.presence_min_interval_ms` (default 30 000 ms).
The heartbeat sits exactly on its own rate-limit boundary: depending on
publish/query latency jitter, every other refresh is dropped, giving a ~60 s
effective cadence against the relay's 180 s TTL — one failed publish away from
a healthy agent showing offline.

**Changes:**

1. Add an internal bypass so the supervisor's lifecycle heartbeat presence is
   **exempt** from `presence_min_interval_ms` (same shape as the existing
   `offline` bypass at `adapter.ts:521`). The rate limit continues to govern
   conversation/runner-driven presence signals.
2. Config validation in `src/config/v2.ts`: reject configurations where
   `presence_min_interval_ms >= heartbeat_secs * 1000` unless the heartbeat
   bypass makes the combination harmless; document the interaction in
   [configuration.md](configuration.md).
3. Treat consecutive heartbeat presence publish failures as a health signal:
   after N failures (default 2, i.e. before the 180 s TTL can lapse), mark the
   endpoint `unhealthy` with reason `presence_stale` and fire
   `alerts.workerDegraded`; recover on next success.
4. Metrics: counter for presence publishes attempted/suppressed/failed per
   endpoint.

**Tests (thorough, per project convention):** heartbeat at exactly the
rate-limit boundary still publishes; conversation-driven presence remains
rate-limited; two consecutive publish failures flip health and alert exactly
once; recovery clears it; reconnect still resets ephemeral limits and
publishes immediately; `offline` on clean stop still bypasses. Config
validation rejection case.

**Gate:** full test suite green; a soak against the spike fake relay showing
≥ 10 min of uninterrupted ≤ 60 s presence refreshes under injected latency
jitter.

## Phase 3 — owner `!shutdown` conformance (US-023)

**Defect:** Desktop's remote-agent "Stop" publishes a `!shutdown` message
mentioning the agent. Torana currently routes it into a normal conversation
turn — the agent answers its own stop command, the exact failure the spec
calls out (invariant I5 violation).

**Changes:**

1. In the Buzz intake path (before turn creation, alongside the existing
   control-plane handling in `src/platform/buzz/transport.ts` /
   `adapter.ts`): a message event whose author is the endpoint's configured
   `owner_pubkey`, which p-tags the endpoint, and whose content — after
   stripping leading mention tokens (`@Name` / `nostr:npub…` forms) and
   trimming whitespace — is exactly `!shutdown`, is a **control command**,
   not a turn. **Before finalizing the matcher, capture one real
   Desktop-0.5.5-issued Stop event against a disposable channel and commit
   it as a spike fixture** — the Desktop may render the mention inside the
   content, and the matcher must be written against the observed shape, not
   an assumption.
2. Handling: persist the event as `control` with reason `owner_shutdown`;
   set the endpoint lifecycle state to `draining` (reusing the
   `torana endpoints drain` path in `src/cli.ts`), let in-flight turns drain,
   publish presence `offline`, close the connection, then set `disabled`.
   The supervisor loop must not reconnect a `disabled` endpoint — this is the
   existing lifecycle gate; the new part is only the transition trigger.
3. **Stay-down semantics (I5):** a full Torana process restart must not
   re-enable the endpoint; `disabled` is durable in the DB. Re-enabling is an
   explicit operator action (`torana endpoints resume <id>`) or a provider
   `deploy` (Phase 5).
4. Configurable via endpoint option `owner_shutdown: enabled | disabled`
   (default `enabled`); document in [platforms/buzz.md](platforms/buzz.md)
   and [operations.md](operations.md).
5. Non-matches fall through unchanged: wrong author, missing mention, content
   that merely contains `!shutdown`, replayed duplicates (event-ID dedup
   already terminal).

**Tests:** owner + mention → drains, publishes offline, disables, never
replies; non-owner sender → ordinary turn-eligible message; no mention →
ignored per subscribe rules; duplicate/replayed shutdown event → no double
transition; restart after shutdown → endpoint stays down; drain completes
in-flight turn before disconnect; `owner_shutdown: disabled` restores old
behavior; `respond_to: anyone` endpoints still enforce owner-only shutdown.

**Gate:** full suite green; E2E against the spike fake relay demonstrating the
full stop sequence and stay-down across a process restart.

## Phase 4 — dynamic endpoint provisioning API (US-024)

**Why:** provider `deploy` must create/start an endpoint without a YAML edit
and redeploy. Today Buzz endpoints exist only in `torana.yaml`.

**Design (chosen approach):** DB-backed _provisioned endpoints_ alongside
static YAML endpoints.

1. New table `provisioned_endpoints` storing the same normalized shape as a
   YAML Buzz endpoint (id, agent binding, community, relay URL, respond
   policy, subscribe mode, triggers, overrides) plus provenance
   (`provisioned_by`, deploy nonce, created/updated timestamps). Secrets
   (`private_key`, `auth_tag`) need a persistence design **that does not
   exist yet** — YAML endpoint secrets are env-interpolated at startup and
   the deployment materializes them into a non-persistent runtime dir, so
   there is no existing durable secret store to reuse. Decision: encrypt
   `private_key`/`auth_tag` at rest in the row (AES-256-GCM) under a key
   supplied via a new required env var `TORANA_PROVISIONING_SECRETS_KEY`
   (added to the deployment env contract; delivered via the same
   root-only-file materialization path as the other Buzz secrets). Startup
   with provisioned rows but a missing/wrong key fails closed with a
   doctor-visible error. Plaintext never appears in rows, logs, or API
   responses; reuse the redaction rules already applied to broker env. The
   table lives in the gateway DB on the `/data` volume and must be added to
   the deployment's backup checklist (the key is _not_ in the backup — a
   restore without the env key yields unusable rows by design; document
   this in the runbook).
   1a. **Agent binding (required).** Provisioning creates _endpoints_, never
   agents or runners. Every `PUT` payload carries a required `agent_id` that
   must name an agent already declared in YAML with a configured runner; the
   endpoint attaches to that agent exactly as a YAML
   `agents[].endpoints[]` entry would. A deploy naming an unknown
   `agent_id` fails with a message listing the configured agent ids. This
   also cleanly rejects publisher-only identities (e.g. Dev Team), which
   have no agent to bind to.
2. Loader merge: at startup and on provisioning events, provisioned endpoints
   are normalized through the **same** `BuzzEndpointSchema` validation as
   YAML endpoints (including the kind-9 auth-tag authorization check at
   `src/config/v2.ts:587`), then handed to `BuzzTransport`. ID collisions
   with YAML endpoints or the reserved `<agent_id>-agent-api` IDs are
   rejected (see `src/config/v2.ts:445`).
   2a. **Dynamic supervisor lifecycle (new transport capability).**
   `BuzzTransport` today builds one supervisor per endpoint from static
   config at startup; this phase adds runtime add/remove/restart of
   endpoint supervisors (and their DB endpoint-state rows) without a
   process restart. This is real scoped work, not an incidental detail —
   include supervisor teardown ordering (drain → presence offline → close →
   remove) and idempotent re-add in the tests.
3. Admin HTTP API, mounted under the Agent API prefix:
   - `PUT /v1/admin/buzz/endpoints/<id>` — upsert + start (idempotent; see
     reconciliation below);
   - `GET /v1/admin/buzz/endpoints/<id>` — status: lifecycle state, health,
     connected, last presence publish;
   - `DELETE /v1/admin/buzz/endpoints/<id>` — drain, disable, remove.

   **Auth:** a new dedicated scope `endpoints:admin` and a dedicated token —
   do **not** reuse `adminAuthed()`'s current rule (any `ask`-scoped token),
   which is only tolerable today because `/v1/*` is unreachable from the
   internet. These routes will be deliberately exposed (see network posture
   below), so an agent's messaging token must never satisfy them.

   **Network posture (resolved from the `agent-team` deployment):** the
   production topology is a public Bun reverse proxy
   (`agent-team/deploy/gateway-proxy/proxy.ts`) on the Railway domain that
   hard-404s all of `/v1/*` and blind-forwards everything else to torana on
   loopback `127.0.0.1:3001`. There is no private network or tunnel pattern
   to reuse, and `railway ssh` is unsuitable for a provider daemon. Decision:
   ride the existing public HTTPS domain with a **literal, method-scoped
   proxy allowlist** — exactly `PUT|GET|DELETE /v1/admin/buzz/endpoints/:id`
   passes; every other `/v1/*` path continues to 404. Companion change in the
   `agent-team` repo:
   - proxy allowlist + regression tests asserting neighbours
     (`/v1/bots`, `/v1/admin/sessions`, `/v1/health`) still 404 publicly —
     that test _is_ the security boundary;
   - edge hardening on the new route matching the Linear-webhook precedent:
     timing-safe token compare, body size cap (64 KB), and rate limiting
     (default 30 requests/min with burst 10, reusing the deployment's
     existing rate-limit vocabulary);
   - new `TORANA_ADMIN_TOKEN_BUZZ_PROVISION` variable added to the env
     contract (`deploy/lib/env-contract.sh`) with a minimum-length check and
     the "never reuse another token" rule. Rotation: swap the Railway
     variable and the provider's local config; per-request bearer auth means
     no restart coordination beyond the standard redeploy. Document in
     [operations.md](operations.md) alongside the existing rotation
     procedures.
     Never mount these routes outside `/v1/` — the proxy forwards non-`/v1`
     paths verbatim, so a bare `/admin/...` route would be silently public.
     3a. **YAML-vs-provisioned precedence (largest design risk).** In production,
     `torana.yaml` is baked into the deploy image and re-validated on every
     `railway up`; provisioned endpoints live in the DB on the `/data` volume.
     Rules, written into code and docs: (a) a YAML endpoint id or derived
     pubkey always wins — a provider deploy that collides with a YAML-declared
     endpoint is rejected with "managed by static config"; (b) provisioned
     endpoints survive redeploys untouched (volume-persisted, never
     regenerated from image state); (c) migrating an agent from YAML to
     provisioned is an explicit operator runbook step (remove from YAML,
     redeploy, then provider-deploy), never automatic. Without these rules the
     next redeploy silently reverts or duplicates whatever the provider
     created.

4. **Reconciliation semantics (mirrors the Desktop's deploy loop, keyed on
   the pubkey derived from the nsec):** if an endpoint with the same derived
   pubkey is live and healthy → strict no-op success; if present but
   `disabled`/failed → replace config and restart; never create a second
   live endpoint for the same pubkey (extends the existing
   `allow_shared_identity` guard). This is Torana taking on the I4
   uniqueness discipline within its own scope.
5. `torana doctor` and `/health` include provisioned endpoints; CLI
   `torana endpoints list` distinguishes `source: yaml | provisioned`.

**Tests:** upsert→connect→online E2E on the fake relay; idempotent re-deploy
no-op; replace-after-disable; secret never appears in logs, API responses, or
DB plaintext (assert ciphertext at rest + redaction); startup fails closed on
missing/wrong `TORANA_PROVISIONING_SECRETS_KEY`; unknown `agent_id` rejected
with the configured-agent listing; invalid auth tag rejected with the same
error surface as YAML validation; collision rejection; restart restores
provisioned endpoints; delete drains before removal; supervisor
add/remove/re-add idempotency; admin auth required on every route (401
without, wrong token, timing-safe compare).

**Gate:** full suite green; capacity note — provisioned endpoints count
against the approved session ceilings from Phase 0 (`max_global: 32`); the
API must reject deploys that would exceed configured endpoint limits rather
than degrade.

## Phase 5 — `buzz-backend-torana` provider binary (US-025)

**Contract (L2, `protocol_version: 1`):** an executable named
`buzz-backend-torana` discoverable on the Desktop machine (PATH or
`~/.local/bin`); one process per op; one JSON object on stdin, one on stdout;
nonzero exit = failure; stdout ≤ 1 MB, stderr ≤ 64 KB; never echo secrets
(env values, `nsec1…`) — the Desktop redacts, but we must not rely on it.

1. **Packaging (decided):** a compiled Bun single-file executable built in CI
   for darwin-arm64 and linux-x64, checksummed in the release — it runs on
   the operator's Desktop machine where Bun/Node may not exist. Windows
   naming caveat: upstream Defect 1 leaves `.exe` in the discovered id, so deploy
   fails on Windows even though probe succeeds — document as unsupported
   until fixed upstream; macOS/Linux are the targets.
2. **`info` op** (10 s budget): returns `name: "torana"`, provider version,
   `protocol_version: 1`, and a `config_schema` for the Desktop form:
   `torana_url` (required; production value is the Railway domain
   `https://agent-team-production.up.railway.app`), `torana_admin_token_ref`
   (a reference/alias, not the secret — invariant I2 forbids secrets in
   `provider_config`; the token itself lives in the provider's own local
   config file `~/.config/torana/provider.json`, mode 0600), optional
   defaults (`respond_to`, `subscribe`, `community_id`).
   **Agent addressing:** adopt the scheme already hand-written into the
   Desktop's `managed-agents.json` today —
   `backend_agent_id: "railway:agent-team:<endpoint-id>"` (see the
   `agent-team` RUNBOOK's manual provider-conversion step, which this
   provider replaces). `deploy` returns that id so existing records stay
   consistent.
3. **`deploy` op** (600 s budget): validate payload → call
   `PUT /v1/admin/buzz/endpoints/<endpoint-id>` with the mapped endpoint
   config → poll `GET` status every 2 s until the endpoint reports
   connected + presence published (fail with a diagnostic after 120 s).
   Return `{"ok": true, "agent_id"}`. **One create attempt per call**
   (normative, spec `8342dfcc…ce79`): exactly one `PUT` per `deploy`
   invocation, then poll-only. A failed endpoint start is reported in-band
   with the latest observed status; the provider never re-`PUT`s inside the
   same call, because a re-run of an identical create cannot change a
   deterministic startup failure and would churn state every poll interval.
   Retry is gated on fresh owner intent (another Desktop "Start"). Mapping
   notes:
   - **Torana agent binding:** the per-agent provider config carries the
     target `agent_id` (Phase 4 §1a); default derived from the endpoint id
     by the existing `<agent>-buzz` naming convention. A deploy whose
     `agent_id` Torana rejects surfaces Torana's error verbatim (it lists
     the configured agents).
   - `relay_url`, `private_key_nsec`, `auth_tag` → endpoint credentials.
   - **Refuse `auth_tag: null`.** Torana requires the owner attestation
     (hosted-relay reality per Phase 0: `403 relay_membership_required`
     without it), and upstream Defect 3 means a null-tag payload also lacks
     `owner_pubkey`, which would break Phase 3 shutdown matching. Clear
     error, no partial deploy.
   - Refuse `relay-mesh`/desktop-loopback transports (non-deployable by
     spec).
   - `respond_to`/allowlist map directly; unmapped upstream knobs
     (`system_prompt`, `model`, timeout knobs, `parallelism`) are recorded in
     the deploy record and reported back as "managed by Torana config" in
     the deploy result message rather than silently dropped — Torana's
     runner configuration owns them.
   - Do not forward host paths or reserved keys from `env_vars`; apply the
     same reserved-key rejection as `src/config/v2.ts:688`.
4. **Defect 5 mitigation:** upstream sends the nsec before verifying
   `protocol_version`. We cannot fix the Desktop, but the provider itself
   verifies the payload shape/versions first, holds the secret only in
   memory, transmits it exclusively over TLS to the configured
   `torana_url`, and zeroes/never-writes it locally.
5. **Stop path:** none in v1 (no `undeploy` op exists) — stop is Phase 3's
   `!shutdown`. The provider README must state this explicitly so operators
   don't expect Desktop "Stop" to call the provider.

**Tests:** golden stdin/stdout fixtures for `info` and `deploy` (success,
each refusal class, Torana unreachable, timeout, oversized payload); a
subprocess harness asserting exit codes and output caps; secret-leak
assertions on stdout/stderr in every failure path; an E2E driving the real
binary against a local Torana with the fake relay. Manual gate: one real
deploy from Buzz Desktop 0.5.5 on macOS into a staging Torana.

**Gate:** E2E + manual Desktop deploy evidence recorded.

## Phase 6 — rollout (US-026)

1. **Deployment image** (runbook §4): bump Buzz source tag/commit to
   `desktop-v0.5.5`/`8342dfcc…ce79` in the CLI build stage, build with the
   release's `Cargo.lock`, verify in-image hashes match, pin the new Torana
   package version in the same change. Doctor C024 must name 0.5.5.
2. **Deploy and observe** (runbook §5): all supervisors up, endpoints
   authenticated/subscribed, zero pending outbox, owner-mention canary, and —
   new for this plan — **presence soak**: confirm from a second community
   member's client that every Torana agent shows online continuously for
   ≥ 30 min with Buzz Desktop closed.
3. **Record conversion:** the inventory is **Jules, Cato, Alfred, Harper,
   and Dev Team**. Jules and Cato are already registered as deployed
   provider-backed (see [release-readiness.md](release-readiness.md)) but
   should be re-deployed through the new provider so their records carry the
   provider's `railway:agent-team:<endpoint-id>` addressing consistently;
   **Alfred and Harper** are the remaining conversational-agent conversions.
   **Dev Team is a special case:** in Torana it is an outbound-only
   `publishers:` principal with no runner (`dev-team-buzz` in the deployment
   `torana.yaml`), so there is no runtime to deploy — its Desktop record
   just needs to be marked provider-backed (or archived as a Desktop agent)
   so the Desktop never spawns a local runtime for that key; provider
   `deploy` for publisher identities is out of scope and is refused
   naturally by the agent-binding rule (Phase 4 §1a — no agent to bind to).
   **Order per agent (required by Phase 4 §3a precedence — a provider
   deploy colliding with a YAML endpoint is rejected):** (1) remove the
   agent's Buzz endpoint block from the deployment `torana.yaml` (the
   `agents[]` entry and its runner stay), redeploy; (2) provider-deploy
   from Desktop, recreating the endpoint as provisioned; (3) retire the
   now-unused `BUZZ_*_<AGENT>` Railway variables once verified.
   Convert one agent at a time; after each, verify no
   duplicate local runtime spawns on explicit mention (the historical
   dual-reply hazard in [operations.md](operations.md)) and that the agent
   stays online with Desktop closed. Note the deployment's env-contract
   constraint: any new YAML env references must exist in Railway before the
   config redeploy, or the whole gateway crash-loops at startup validation.
4. **Shutdown drill:** owner issues `!shutdown` to one canary agent; verify
   drain, offline presence, stay-down across a Torana restart; re-deploy via
   the provider; verify reconciliation no-op on a second "Start".
5. **Evidence:** append versions, hashes, deployment ID, canary event IDs,
   presence-soak observations, and drill results to
   [release-readiness.md](release-readiness.md); update
   [platforms/buzz.md](platforms/buzz.md), [operations.md](operations.md),
   [configuration.md](configuration.md), changelog; release via the actual
   release-cut process (annotated `vX.Y.Z` tag drives `release.yml` → npm —
   note CONTRIBUTING's Changesets flow is documented but not set up).

## Risks and dependencies

| Risk                                                           | Mitigation                                                                                                                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.5.5 CLI manifest adds commands with unsafe defaults          | Phase 1 manual classification review is a hard gate                                                                                                                                |
| Upstream deploy payload omissions (Defect 3)                   | Provider refuses null `auth_tag`; requires explicit owner attestation                                                                                                              |
| nsec sent to provider pre-negotiation (Defect 5)               | Provider-side minimization: memory-only, TLS-only, no local persistence                                                                                                            |
| Same nsec live in two scopes (I4 boundary: relay tolerates it) | Reconciliation keyed on derived pubkey inside Torana; record conversion in Phase 6 removes the Desktop-local copy; `allow_shared_identity` stays the guard for intentional sharing |
| Provisioning API widens attack surface                         | Dedicated admin token, deny-by-default routing, schema-identical validation, secret redaction tests                                                                                |
| Presence fan-out is per-relay-node upstream                    | Out of our control; note in operations docs so "shows offline for some viewers" is diagnosable                                                                                     |
| Windows provider discovery broken upstream (Defect 1)          | Documented unsupported; macOS/Linux only                                                                                                                                           |

## Resolved questions

1. Phase 4 admin-route network posture (from the `agent-team` deployment
   repo): no private network or tunnel exists; the pattern is a public
   `gateway-proxy` that 404s `/v1/*` and forwards everything else to torana
   on loopback. The admin API rides the public Railway domain behind a
   literal proxy allowlist, a dedicated `endpoints:admin` scope/token, and
   Linear-webhook-grade edge hardening — full details in Phase 4.
2. Phase 5 binary format: compiled Bun executable built in CI for
   darwin-arm64 and linux-x64, checksummed in the release (default accepted).
3. Phase 6 inventory: Jules, Cato, Alfred, Harper, Dev Team. Jules and Cato
   are already provider-backed (re-deploy for consistent addressing); Alfred
   and Harper are the remaining agent conversions; Dev Team is a
   publisher-only principal with no runtime — record-flag only.

## Refinement log

- Passes completed: 1 full cycle (8 passes) via iterative-refinement,
  2026-08-05.
- Issues found and fixed: 1 critical (undefined agent/runner binding for
  provisioned endpoints), 6 high (US-numbering off-convention, wrong CLI
  verb `enable`→`resume`, stale release-process reference, `!shutdown`
  content-shape assumption, missing dynamic-supervisor scoping, hand-waved
  secret persistence, YAML-precedence vs Phase 6 conversion contradiction),
  5 medium, 0 low remaining above cosmetic.
- Final result: Pass 7 clean; Pass 8 low-only.
- Known limitations (deliberate): archive/binary SHA-256s are
  record-during-Phase-1 fields; the `!shutdown` matcher and the spec re-pin
  depend on observations only obtainable during execution (both have
  explicit capture steps); Windows provider support deferred on upstream
  Defect 1.
- Issue log: session scratchpad `buzz-remote-agents-plan.refinement.md`
  (evidence: grep/ls/sed verification of every cited path, line number, CLI
  verb, script, and identifier in both repos).
