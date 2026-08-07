# Buzz remote-agents conformance and provider — implementation progress

Plan: [docs/buzz-remote-agents-plan.md](../docs/buzz-remote-agents-plan.md)
Branch: `main` (one commit per phase, `US-021` … `US-026`, tracker pin after
each gate).

---

## How to resume (handoff, 2026-08-07)

All six phases are implemented. `torana@2.0.0-rc.10` is published and running
in production with schema v7. The presence gate and the owner-`!shutdown` drill
both passed against production. What remains is the provider rollout, which is
blocked on one decision, not on code.

### Read this first — `main` is ahead of what is deployed

`dba11f0` ("Keep outbound-only publishers off the presence feed") is on `main`
but **not in rc.10**, so it is inert. `dev-team-buzz` is still announcing itself
online every ~30 s in production. The owner decided publishers should stay
silent; the fix is written and tested but needs a release to take effect.

Everything else on `main` past `v2.0.0-rc.10` is documentation.

### Two decisions waiting on the owner

1. **Staging for the first provider deploy.** The plan assumed a staging Torana
   and there isn't one — `agent-team` is a single production service. Either
   deploy the first provider-created agent into production with a throwaway
   identity, or stand up a second Railway service first. **This gates all
   remaining provider work.**
2. **When to ship the publisher-presence fix.** Batch it with the provisioning
   deploy (one restart instead of two — the recommendation), or cut rc.11 now.

### Current state

| Surface                | State                                                            |
| ---------------------- | ---------------------------------------------------------------- |
| `torana` main          | `bcf0611`, clean, pushed                                          |
| `agent-team` main      | `15f3444`, clean, pushed (`start_ssh.sh` untracked, pre-existing) |
| npm `rc` dist-tag      | `2.0.0-rc.10`                                                     |
| Production deployment  | `bf55fe88`, commit `194f4de`, healthy                             |
| Production schema      | v7 (`gateway.db.pre-v7` is the rollback copy on the volume)       |
| Buzz CLI in image      | `desktop-v0.5.5`, Linux digest `c83fcfbe…2876`                    |
| Provisioning           | **deployed but off** — `BUZZ_PROVISION_ENABLED` unset, routes 404 |
| Buzz endpoints         | all five `active`/`healthy`/`connected`                           |

### Next actions, in order

1. **Enable provisioning** (after the staging decision). Set
   `TORANA_ADMIN_TOKEN_BUZZ_PROVISION` and `TORANA_PROVISIONING_SECRETS_KEY`,
   then `BUZZ_PROVISION_ENABLED=1` — in that order, the env contract refuses a
   partial setup. Add the `endpoints:admin` token block to the deployment
   `torana.yaml`. Full recipe: `agent-team` RUNBOOK §"Deploy a Buzz agent onto
   Torana with the provider". **Back the secrets key up somewhere other than
   the volume** — a restore without it cannot recover provisioned identities.
2. **Install the provider** on the operator's Mac from the release artifact
   (`gh run download <run-id> -R jvbutterfield/torana -n buzz-backend-torana`),
   verify against `SHA256SUMS`, and write `~/.config/torana/provider.json`
   mode 0600. rc.10 checksums are in `release-readiness.md`.
3. **First provider deploy**, then the drill's remaining half: bring a stopped
   agent back via provider `deploy` rather than `endpoints resume`, and confirm
   a second Start reconciles to `unchanged`.
4. **Record conversions**, one agent at a time, in the order the precedence rule
   forces: remove the endpoint from YAML → redeploy → provider-deploy → retire
   the `BUZZ_*_<AGENT>` variables. Jules and Cato first (re-deploy for
   consistent addressing), then Alfred and Harper. Dev Team is record-flag only
   — it is a publisher with no runner, and provider deploy refuses it naturally.
5. **Owner-mention canary** on the new build.

### Operational facts that cost real time to learn

1. **Pushing `agent-team` `main` deploys to production automatically.** There is
   no review gap.
2. **There is no way to restart torana alone.** `supervisorctl restart
   telegram-gateway` bounces the whole container (~50 s) because the runtime
   supervisor treats a gateway exit as fatal. The `abnormal termination` line is
   the expected stop, not a failure.
3. **Schema migrations must run from `deploy/bin/torana-start`.** `torana
   migrate --config` loads and validates the whole config, so it needs the
   secrets `torana-start` exports; and Railway's pre-deploy phase does **not**
   have the volume attached, confirmed in production logs.
4. **The gateway proxy forwards request bodies as streams**, which wedges the
   connection for a following GET. The provisioning route buffers instead. Any
   new route with a PUT-then-poll pattern needs the same treatment.
5. **`railway ssh` lacks the runtime environment.** `BUZZ_CLI_SHA256` and the
   Buzz secrets are materialized by the entrypoint, so any `torana` CLI command
   that loads the config fails there. Mirror `torana-start`'s loading: export
   `BUZZ_CLI_SHA256` from `/usr/local/share/torana/buzz-cli.sha256`, then read
   each name from `/run/torana-secrets/<NAME>`. Never echo the values.
6. **Never run `ps eww`** on the Mac or in the container — process environments
   carry Buzz private keys.
7. **Poll faster than the heartbeat** when measuring presence, or the gap
   aliases to the poll period. See `spike/buzz-transport/presence-watch.ts`.
8. **`dev-team` cannot receive `!shutdown`.** Publishers never subscribe to
   channel messages, so a drill target must be a conversational agent.

### Verification recipes

- **Presence watch** — collector one-liner and analysis:
  `spike/buzz-transport/presence-watch.ts` (header has the `railway ssh`
  command).
- **Endpoint health** —
  `railway ssh "curl -s http://127.0.0.1:3001/health"`; the `presence` block per
  endpoint is the US-022 surface.
- **Public edge** — `/v1/bots`, `/v1/health`, `/v1/admin/sessions` must 404 from
  the public domain; so must the provisioning path until it is enabled.
- **Provider E2E, offline** — `BUZZ_PROVIDER_E2E=1 bun test
  test/provider/provider.e2e.test.ts` compiles the real binary and deploys
  against a local gateway plus fake relay.
- **Local presence soak** — `BUZZ_PRESENCE_SOAK=1 bun test
  test/soak/buzz-presence.test.ts` (10 min).

### Two places the original plan was wrong

Recorded so nobody re-derives them from the plan text:

1. The `!shutdown` matcher needs **exact trimmed content**, no mention-token
   stripping. Verified against upstream source, not a GUI capture — evidence in
   `spike/buzz-transport/owner-shutdown-contract.json`.
2. The presence rate-limit config check the plan specified would have **rejected
   the shipped defaults**. Implemented the check that actually protects the
   invariant instead: reject `heartbeat_secs >= 90`.

---

## Phase table

| Phase                                    | Status         | Story    | Evidence                                                   |
| ---------------------------------------- | -------------- | -------- | ---------------------------------------------------------- |
| 1 — pin upgrade to `desktop-v0.5.5`      | ✅ Complete    | `US-021` | provenance verified live; manifest diff = checksum only     |
| 2 — presence heartbeat hardening         | ✅ Complete    | `US-022` | 11 tests + 10-min soak: 92 refreshes, max gap 7.9 s          |
| 3 — owner `!shutdown` conformance        | ✅ Complete    | `US-023` | 13 tests; matcher pinned to upstream source, not a guess     |
| 4 — dynamic endpoint provisioning API    | ✅ Complete    | `US-024` | 30 tests; schema v7; secrets sealed, verified at rest        |
| 5 — `buzz-backend-torana` provider       | ✅ Complete    | `US-025` | 30 tests + E2E against a live gateway                       |
| 6 — rollout                              | 🟡 Partial     | `US-026` | rc.10 published + deployed, schema v7 live; drills pending    |

## Phase 1 evidence (US-021)

**Provenance (runbook §1).** Verified against the live release, not asserted:

| Field                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| Tag                  | `desktop-v0.5.5`, published 2026-08-05T01:23:40Z                    |
| Resolved commit      | `8342dfcc5890b81a269a8ec3db73a8a56f76ce79`                          |
| Apple-silicon asset  | `502011159`, `Buzz_0.5.5_aarch64.app.tar.gz`, 97,561,748 bytes      |
| Archive SHA-256      | `7fe09906460fd85e6f215af4074b50c2963f2bd3e218c75de4d6fb21a11520e3`  |
| Bundled CLI SHA-256  | `8f59ea1a877fce972ce1d0165b9deda457085c21ee2c36ef497b8038812fdac9`  |
| Installed CLI        | byte-for-byte identical (`cmp` clean) to the archive's bundled CLI  |
| CDHash               | `92f000da71c9dd221335c037d203eb8e5bc6f833` (was `2d19fc6b…0d724`)   |
| Team ID              | `EYF346PHUG` — unchanged                                            |
| App bundle version   | `0.5.5`                                                             |

`bun run provenance:check` re-downloads the recorded asset and re-verifies
both digests plus the installed-binary comparison: passes.

**Manifest review (runbook §2).** `diff -u cli-manifest.json <regenerated>` is
**one line** — the `sha256` field. Zero commands added, removed, renamed, or
re-nested. The plan flagged Buzz Term and multi-repo projects as candidates for
new verbs; neither reaches the `buzz` CLI surface in 0.5.5 (`projects.*` was
already present and classified at 0.5.4). No new verb therefore required
classification, and no `src/broker/buzz-policy.ts` tier changed.

The classification review did surface a **pre-existing** gap, unrelated to the
upgrade: nine manifest commands sit in no tier and are reachable only through
the `custom` profile — `dms.add-member`, `dms.hide`, `messages.vote`,
`notes.rm`, `patches.status`, `pr.status`, `users.set-presence`,
`users.set-profile`, `users.set-status`. That fails closed, so it is not a
security hole, but it was drift rather than a decision. This phase pins the
exact set in a test instead of widening any named profile under a
version-pin commit; deciding tiers for those nine is a separate, deliberate
policy change.

**Spec re-pin (plan Phase 1 §4).** `docs/nips/NIP-OA.md` and
`docs/nips/NIP-AA.md` are byte-identical between `28ae6cd21` and the
`desktop-v0.5.5` tree. `docs/remote-agents.md` moved (89 changed lines), almost
all of it citation re-pinning to `28ae6cd21` and line-number refreshes. Two
normative changes, both recorded in the plan:

1. **I3 presence TTL is 180 s, not 90 s.** The plan was already written against
   180 s, so nothing downstream changes.
2. **New "one create attempt per call" rule.** Folded into Phase 5 §3 as an
   explicit provider requirement: exactly one `PUT` per `deploy`, then
   poll-only.

Neither invalidates a Phase 2–6 design decision, so Phase 2 is unblocked.

**Changes landed.**

- `spike/buzz-transport/artifact-provenance.json` — 0.5.5 identities.
- `spike/buzz-transport/cli-manifest.json` — regenerated (checksum only).
- `src/broker/buzz-policy.ts` — `BUZZ_CLI_PIN` → 0.5.5 / `desktop-v0.5.5` /
  `8342dfcc…ce79`.
- `src/config/v2.ts` — both `cli_sha256` defaults now read `BUZZ_CLI_PIN.sha256`
  instead of repeating the literal. Two copies of a checksum that must agree is
  the exact drift this upgrade would otherwise re-create every time.
- `docs/configuration.md`, `examples/agent-team/{README.md,torana.yaml}`, both
  byte-identical `torana-buzz` skill copies, `CHANGELOG.md`.
- `test/broker/buzz-policy.test.ts` — two new tests: pin/manifest/provenance
  describe one artifact, and no manifest command is silently unclassified.

Historical evidence deliberately left at 0.5.4/0.5.3 identities:
`docs/buzz-phase0-findings.md`, `docs/buzz-platform-plan.md`,
`docs/release-readiness.md`, and prior `CHANGELOG.md` sections.

**Gate (runbook §3).** All green on the 0.5.5 CLI:

```
bun x tsc --noEmit                     clean
bun x eslint src                       clean
bun x prettier --check .               clean (also fixed two files that were
                                       already unformatted at HEAD)
bun test --timeout 15000               1426 pass / 14 skip / 0 fail
bun run build                          dist/cli.js 1.16 MB
bun run scripts/verify-pack.ts         14/14 required SQL files
bun run scripts/check-skill-parity.ts  3/3 skills byte-identical
spike: bun test                        10 pass / 0 fail
spike: bun run typecheck               clean
spike: bun run manifest:check          matches installed binary
spike: bun run provenance:check        both digests + installed match
```

Runbook §4–6 (downstream image, deploy, rollback) are deployment-repo work and
land in Phase 6.

## Phase 2 evidence (US-022)

**The defect, confirmed.** `monitorLifecycle()` republished presence every
`subscription.heartbeat_secs` while `BuzzAdapter.signal()` suppressed any
presence publish inside `limits.presence_min_interval_ms`. At the shipped
defaults those are the same 30 s, so the heartbeat sat exactly on its own
rate-limit boundary: publish-latency jitter, or any conversation-driven
presence signal landing first, dropped refreshes and stretched the effective
cadence toward 60 s against a 180 s relay TTL.

**Changes landed.**

- `EphemeralSignal` presence gains `lifecycle?: boolean`; `BuzzAdapter`
  exempts lifecycle presence from the rate limit exactly as it already
  exempted the clean-stop `offline` publish. Conversation- and runner-driven
  presence is unchanged.
- New `BuzzAdapter.signalDetailed()` returning
  `published | suppressed | failed`. `signal()` keeps its boolean contract.
  A boolean could not distinguish "the limiter dropped it" from "the relay
  refused it", and only the second is a liveness problem.
- Supervisor tracks presence health: `presence_failure_threshold` (new,
  default 2) consecutive failures → `unhealthy` + `last_error:
  presence_stale` + one `workerDegraded` alert per episode, cleared on the
  next success. Exposed on `/health` (`endpoints[].presence`) and `/metrics`
  (`torana_endpoint_presence_publishes_total` by outcome,
  `torana_endpoint_presence_stale`).
- `BUZZ_PRESENCE_TTL_SECS = 180` recorded in `protocol.ts` next to the kinds,
  cited to `buzz-pubsub/src/presence.rs`.

**Deliberate deviation from the plan.** The plan asked config validation to
"reject configurations where `presence_min_interval_ms >= heartbeat_secs *
1000` unless the heartbeat bypass makes the combination harmless". With the
bypass in place that combination *is* harmless — and the shipped defaults are
exactly it (30 s / 30 000 ms), so the rejection would have made the default
config invalid. Implemented instead: reject `heartbeat_secs >= 90` while Buzz
is enabled, which is the case no bypass can rescue (one failed publish
outlives the 180 s TTL). The permitted-but-noteworthy combination is
documented in `configuration.md` instead.

**Tests.** `test/platform/buzz-presence.test.ts`, 11 tests: lifecycle refresh
publishes inside the limit window; conversation-driven presence still
rate-limited; a lifecycle refresh is not blocked by a conversation publish
that just consumed the window; `offline` and typing behaviours preserved;
relay rejection, publisher exception, and missing publisher all report
`failed` (never a silent success); heartbeat cadence on a fake relay; two
consecutive failures flip health and alert exactly once; a third failure does
not re-alert; recovery restores `healthy` and re-arms the alert for the next
episode; clean stop still publishes `offline`; config defaults accepted,
`heartbeat_secs` boundary rejected at 90 and accepted at 89, disabled Buzz
unconstrained, threshold floor of 1.

**Gate — soak.** `test/soak/buzz-presence.test.ts`, gated by
`BUZZ_PRESENCE_SOAK=1`, 10 minutes of wall clock against the fake relay with
up to 1500 ms of injected latency on every publish and query:

```
{"soak":"buzz-presence","duration_ms":600108,"heartbeat_secs":5,
 "jitter_ms":1500,"presence_publishes":92,"max_gap_ms":7855,
 "mean_gap_ms":6556,
 "presence":{"attempted":92,"suppressed":0,"failed":0,
             "consecutiveFailures":0,"stale":false},"state":"healthy"}
```

Zero suppressed, zero failed, worst gap 7.9 s against a 60 s budget and a
180 s TTL. Re-run after correcting the assertion below: 93 publishes,
`max_gap_ms` 7893, `mean_gap_ms` 6419, still zero suppressed and zero failed —
green.

The first run failed one assertion — not the property under test:
it expected `duration / heartbeat` publishes, but the supervisor waits
`heartbeat_secs` *after* the previous refresh completes, so the observed
cadence is the interval plus the round trip (6.6 s mean at a 5 s heartbeat
with 1.5 s jitter). The assertion now derives its floor from that model; the
gap assertions, which are what actually bound liveness, passed on both runs.
Worth carrying into Phase 6: production cadence is ~30 s + relay RTT, not
30 s.

**Gate — suite.** `bun test`: 1452 pass / 15 skip / 0 fail.

## Phase 3 evidence (US-023)

**Matcher provenance.** The plan required capturing a real Desktop-issued Stop
event before finalizing the matcher, because the Desktop "may render the
mention inside the content". Driving the Desktop GUI against a live hosted
relay was not available here, so the shape was taken from the pinned source
tree instead — which is stronger evidence than one observed event, since it
shows the matcher upstream actually applies. Recorded in
`spike/buzz-transport/owner-shutdown-contract.json`:

- `desktop/src/features/agents/lib/managedAgentControlActions.ts` — Stop for a
  provider-backed agent calls `sendChannelMessage(channelId, "!shutdown",
  undefined, undefined, [agent.pubkey])`. The content is the bare literal; the
  mention travels as `mentionPubkeys` → `p` tags.
- `crates/buzz-acp/src/lib.rs` — `is_owner_control_command` is
  `kind == KIND_STREAM_MESSAGE && content.trim() == "!shutdown" && event
  p-tags the agent`; the caller then requires the author to be the resolved
  owner, and a non-owner match deliberately falls through to normal prompt
  handling instead of being dropped.
- `crates/buzz-core/src/kind.rs` — `KIND_STREAM_MESSAGE = 9`, documented in
  place as the shutdown convention.

**The plan's assumption was wrong, and stripping would have been harmful.**
The Desktop never puts the mention in the content, and upstream compares the
trimmed content exactly. Stripping leading `@Name` / `nostr:npub…` tokens
would have made Torana's matcher *wider* than upstream's — stopping an agent
on a message a Desktop-hosted agent would have answered. Implemented exact
trimmed equality.

**One deliberate divergence:** Torana honours both stream-message kinds (9 and
40002) where upstream honours kind 9 only. Every other message path in Torana
treats V1 and V2 identically; an owner stop that worked in one channel and not
another would be a worse surprise than the divergence. Recorded in the
fixture.

**Changes landed.**

- `owner_shutdown: enabled | disabled` per Buzz endpoint (default `enabled`).
- `BuzzAdapter.evaluateInbound` classifies a matching event as
  `control` / `owner_shutdown` **before** the author and mention gates, so the
  rule is identical on every `respond_to` setting: `anyone` cannot be stopped
  by a stranger, `nobody` still obeys its owner.
- `BuzzEndpointSupervisor.beginOwnerShutdown()`: stop intake → `draining`
  (`state_reason = owner_shutdown`) → wait out in-flight turns up to
  `limits.owner_shutdown_drain_ms` (new, default 30 000) → publish presence
  `offline` → `disabled` → close. `monitorLifecycle` now keeps the connection
  alive for the supervisor's own drain, so replies still land while draining;
  every other transition out of `active` closes as before.
- Stay-down is durable: `state_reason` is deliberately *not* `config_disabled`,
  which is the one reason `syncNormalizedConfig` treats as "re-enable when the
  config says so".

**Tests.** `test/platform/buzz-owner-shutdown.test.ts`, 13 tests: the pinned
contract matches the implementation; owner + exact content + mention is a
control command, including leading/trailing whitespace and V2 kinds; six
near-miss contents (`!shutdown please`, `!shutdownnow`, `!Shutdown`, fenced,
…) stay ordinary turns; a non-owner cannot stop it under `owner_only` *or*
`anyone`; an unmentioned or wrongly-mentioned event is not a stop; the agent's
own echo is ignored; `owner_shutdown: disabled` restores the old behaviour; an
inaccessible channel is rejected first; end-to-end drain → offline → disable
with zero replies published; a replayed event does not transition twice or
publish a second goodbye; stay-down across a full database reopen and config
re-sync, with an operator resume bringing it back; an in-flight turn finishes
before the disconnect; and a drain that overruns its budget still shuts down.

**Gate — suite.** `bun test`: 1452 pass / 15 skip / 0 fail; typecheck, lint,
and format clean.

**Not done here:** the plan's "E2E against the spike fake relay demonstrating
the full stop sequence and stay-down across a process restart" is covered by
the transport-level tests above against the fake relay, including a database
reopen. A separate OS-process restart adds no new failure mode — the stay-down
decision is a durable DB row, and it is asserted directly.

## Phase 4 evidence (US-024)

**Design.** DB-backed provisioned endpoints alongside YAML ones, schema v7
(`provisioned_endpoints`). The row's stored block is merged into the parsed
config and re-run through `ConfigV2Schema`, so identity checks, auth-tag
authorization, globally unique endpoint ids, the reserved `<agent>-agent-api`
id, and shared-identity rules are the *same code* that guards YAML — Zod's
message is returned verbatim, so an operator sees what a bad YAML edit would
have shown them.

**Secrets at rest.** AES-256-GCM envelopes (`v1.<iv>.<tag>.<ct>`, base64url)
with the endpoint id as AAD, so a ciphertext cannot be moved between rows, under
a new `TORANA_PROVISIONING_SECRETS_KEY` (32 bytes, hex or base64). The key is
deliberately not in the database. Startup with rows but no usable key fails
closed; doctor `C029` reports it first.

**Dynamic supervisor lifecycle.** `BuzzTransport` gained
`upsertEndpoint`/`removeEndpoint`/`hasEndpoint`/`snapshot(id)`, and `botIds`
became derived rather than captured at construction — a stale list would leave a
provisioned agent's endpoint invisible to everything that iterates transports.
Replacement tears the old supervisor down first; two supervisors on one endpoint
id would mean two subscriptions and two independently signed replies. Delete
drains and announces `offline` first, reusing the same sequence the owner
`!shutdown` path uses (extracted as `drainAndAnnounceOffline`).

**Authorization.** New `endpoints:admin` scope; config validation rejects a
token combining it with `ask` or `send`, so "dedicated" is structural rather
than a convention. 64 KiB body cap. The token's `bot_ids` still bound which
agents it may attach endpoints to. Routes are mounted under `/v1/` precisely
because the deployment's proxy forwards non-`/v1` paths verbatim — a bare
`/admin/...` route would have been silently public.

**Reconciliation.** Keyed on the pubkey derived from the submitted key: live and
identical → `unchanged` (no connection churn); disabled or failed → `replaced`
and restarted; a second live endpoint for one identity → rejected. A YAML
endpoint wins any collision, by id or by identity.

**Tests.** 21 in `test/platform/buzz-provisioning.test.ts` (seal/open round
trip, endpoint binding, wrong key, tampered and truncated envelopes, key format,
timing-safe token compare, unknown agent with the configured list, YAML id and
YAML identity collisions, invalid auth tag, malformed key, no-key refusal,
capacity ceiling, schema strictness, connect/no-op/replace, add-remove-re-add
idempotency, drain-before-delete, ciphertext at rest including a raw file dump,
restart restore, missing and wrong key on restore, an agent that disappeared
from YAML, and no secret material in any error) plus 9 route tests
(`test/agent-api/provisioning.routes.test.ts`) covering 401/403 on all three
methods for anonymous, wrong, and messaging tokens, cross-agent refusal,
oversized body, malformed JSON, unknown fields, 503 when unavailable, 404 for
unknown endpoints, and the neighbouring admin routes still requiring their own
scope.

## Phase 5 evidence (US-025)

**Contract.** L2 `info`/`deploy`, `protocol_version: 1`, one process per op,
one JSON object each way, non-zero exit on failure, 1 MB stdout / 64 KiB stderr
caps enforced on our own side. Compiled single-file executable for darwin-arm64
and linux-x64, checksummed in the release (`release.yml`), because it runs where
Bun may not exist. Windows documented unsupported (upstream discovery keeps
`.exe` in the derived id).

**One create attempt per call** — the normative rule the Phase 1 spec re-pin
surfaced. Exactly one `PUT`, then poll-only; a failed start is reported in-band
with the last observed status and retry is gated on a fresh Start.

**Refusals**, each because something downstream would otherwise break quietly:
null/empty auth tag (hosted relay refuses membership, and upstream omits
`owner_pubkey` with it, leaving an endpoint nobody could `!shutdown`),
relay-mesh transports, desktop-loopback relays against a non-local gateway,
plaintext gateway URLs, reserved identity env vars.

**Secret handling.** Bearer from `~/.config/torana/provider.json` (mode 0600),
never from Desktop-persisted `provider_config` (invariant I2). Payload validated
before anything is transmitted; the nsec is held in memory, sent over TLS only,
never written to disk. A test proved the scrubber necessary: an upstream `fetch`
error carrying the nsec was passing through verbatim before it existed.

**Tests.** 30 unit tests including a subprocess harness on the real binary
(exit codes, one-object stdout, garbage and empty stdin), and
`test/provider/provider.e2e.test.ts` (gated by `BUZZ_PROVIDER_E2E=1`) which
compiles the binary and deploys against a live gateway and fake relay: connected
endpoint, presence published, second deploy `unchanged`, no secret on any
stream.

## Phase 6 status (US-026)

Everything that can be produced from a repository is done and recorded in
[docs/release-readiness.md](../docs/release-readiness.md):

- Torana docs — `configuration.md`, `operations.md`, `platforms/buzz.md`,
  `agent-api.md`, `CHANGELOG.md`, `release-readiness.md`, and the provider
  README.
- `agent-team` commit `04bbf3a` — proxy allowlist with neighbour-still-404
  regression tests, edge hardening, env contract, supervisord wiring, and the
  provider-based conversion runbook. This is the change the plan requires to
  land *before* the Torana release that ships the routes is deployed, and it
  has.

**Released and deployed on 2026-08-06.** `torana@2.0.0-rc.10` is on the npm
`rc` dist-tag; `agent-team` moved the Buzz tag and the package pin together
(`aa5d472`), schema v7 applied itself on first boot with a v6 snapshot kept,
and Railway deployment `bf55fe88` promoted with all five Buzz endpoints
healthy and connected. Full evidence in `release-readiness.md`.

Two deploys failed first, and both taught something worth keeping:

1. The migration cannot live in `entrypoint.sh` — `torana migrate --config`
   loads and validates the whole config, so it needs the secrets that
   `torana-start` exports. It also cannot discard stderr, which is what turned
   a one-line config error into an opaque "could not read the migration plan"
   repeated until the healthcheck gave up. Railway's pre-deploy phase was
   confirmed not to have the volume attached, so the migration could never have
   run there either.
2. The gateway proxy wedged on the provisioning route's own access pattern: a
   GET immediately after a body-carrying PUT on one keep-alive connection hung,
   because the generic path forwards bodies as streams. That is exactly what
   the provider does — PUT, then poll — so it would have failed on the first
   real deploy rather than in a test. The route now forwards a buffered body
   (already capped at 64 KiB) and a regression test drives the full
   PUT-poll-poll-poll-DELETE sequence.

**Presence soak, Torana side: PASS** (2026-08-06). 30.9 min across all five
production endpoints — 31/31 samples fresh, worst staleness 31.7 s, ~148 s of
margin against the 180 s TTL, zero stale flips, zero failed publishes, zero
disconnects. A 10 s-poll follow-up measured the true refresh interval directly
at 30.1–31.8 s (mean 30.2 s), confirming the fake-relay soak's prediction that
production cadence is the heartbeat plus RTT.

Worth keeping: the first pass polled at 60 s against a 30 s heartbeat and
reported an apparent 61.9 s gap. That is aliasing — each sample sees the newest
publish two refreshes on — and the same run's 31.7 s worst staleness already
contradicted it. Poll faster than the heartbeat; the analyzer now flags the
condition rather than letting the number be misread.

Buzz Desktop was running throughout that window, and it did not matter: its 17
local runtimes cover 10 identities, disjoint from the five Torana endpoints.
Presence is self-signed by the agent key, so no local process can refresh these
dots. Independence is therefore a structural property here, not something a
test window has to arrange — worth knowing before anyone kills 17 local agents
to satisfy the runbook's literal wording.

**Owner `!shutdown` drill: PASS** (2026-08-07, `jules-buzz`). Event 4418
recorded as `control` / `owner_shutdown`; **no turn created and no reply
published** — the agent did not answer its own stop command, which is the whole
point. Drained clean, went `disabled` with reason `owner_shutdown`, and the
owner saw her go offline in their own client. A full container restart (there
is no way to bounce torana alone — the runtime supervisor treats a gateway exit
as fatal) left her still disabled while the other four reconnected healthy, and
the migration logged `schema already current` on the way through. `!shutdown`
disables the Buzz endpoint only; her Telegram side was untouched.

**Presence, client side: confirmed.** The owner sees the other four online in
their Buzz client, closing the fan-out half of the presence gate.

**Publisher presence decision (taken):** publishers should not advertise
themselves online. The heartbeat now matches the connect-time gate.

**Still outstanding**, all needing the Desktop or a deliberate drill: an
owner-mention
canary on the new build, the four record conversions plus Dev Team's record
flag, the `!shutdown` drill, and one manual Desktop deploy. Provisioning itself
is deployed but **off** (`BUZZ_PROVISION_ENABLED` unset), verified by the
provisioning path 404ing publicly under every method.
