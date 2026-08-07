# Buzz 2.0 release readiness

This document records the Phase 11 review and the remaining operator gates.
Local implementation is not equivalent to production release approval.

## Threat review

| Threat                             | Control                                                                       | Residual risk                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Private-key or auth-tag disclosure | config redaction, mode check, broker-only runner capability                   | a compromised same-container runner remains in the Torana trust domain     |
| Signed-event replay                | signature and event-ID verification, durable dedup, composite cursors         | relay history outside configured replay bounds needs operator recovery     |
| Author spoofing                    | derived pubkeys, signature verification, exact author/mention policy          | an authorized owner or allowlisted identity can still send hostile prompts |
| Membership removal or change       | live membership subscription and pre-dispatch membership check                | relay delay can briefly defer, but never broaden, accepted access          |
| Malicious or forged tags           | strict parsing; trace tags are diagnostic only                                | peer-controlled trace metadata cannot be trusted for security              |
| Reply-loop amplification           | self-event rejection plus local endpoint/conversation rate budgets            | coordinated identities can consume the bounded allowance                   |
| Attachment URL abuse               | signed same-origin `/media/`, no redirect/compression, byte/hash/MIME checks  | accepted files remain untrusted runner input                               |
| Workflow injection                 | pinned notification kinds, provenance-isolated sessions, no implicit approval | explicitly enabled workflow prompts can influence a runner                 |
| Tool-policy bypass                 | endpoint-bound short-lived capability and pinned command manifest             | broker is a policy chokepoint, not a sandbox against host compromise       |

No unresolved P0 or P1 finding was identified in this review. Hard persona
isolation still requires separate Torana installations or containers.

## Fault-injection map

| Fault                         | Regression evidence                                                              |
| ----------------------------- | -------------------------------------------------------------------------------- |
| relay disconnect/reconnect    | Phase 4 authenticated replay, composite cursor, restart dedup                    |
| duplicate relay delivery      | Phase 4 restart replay dedup and exact pre-dispatch recovery                     |
| delayed or dropped relay `OK` | Phase 5 and Phase 8 exact signed payload retry tests                             |
| out-of-order mutation         | Phase 6 tombstone-before-message and queued edit/delete tests                    |
| SQLite busy                   | `test/db/buzz-db-busy.test.ts` proves cursor/event atomicity and safe redelivery |
| runner crash                  | runner fatal tests plus terminal interrupted/recovery coverage                   |
| outbox crash windows          | in-flight grace, auto-recovery, idempotent sent-state tests                      |
| membership removal            | Phase 4 live add/remove subscription test                                        |
| auth rotation                 | `test/config/buzz-auth-rotation.test.ts` rejects a stale owner tag               |

## Local audit evidence

On 2026-08-02, `bun audit --audit-level=high` reported no vulnerabilities.
The production dependency license inventory contained five MIT packages and
one Unlicense package (`nostr-tools`). The repository contains a gitleaks
policy and CI runs the full-history secret scan; release CI repeats the
high-severity dependency audit. Public examples contain placeholders only and
are parsed in the default test suite with synthetic credentials.

## Soak and rollout

### Live verification on 2026-08-02

The configured Block hosted closed relay passed authenticated membership
discovery, a signed publish, exact-event duplicate publication, intake readback,
reconnect replay, and local event-ID deduplication. The hosted Blossom probe
then uploaded a PNG and PDF, persisted and retried the identical signed event,
downloaded both objects with signed authorization, and verified their byte
sizes, MIME types, and SHA-256 hashes. No credential value was printed or
copied out of Apple Keychain or the Buzz Desktop managed-agent record.

Authenticated real-runner Agent API checks passed 4/4: Codex request/response
plus same-session continuity, and Claude request/response plus same-session
continuity. The pinned Buzz regression passed 10/10 across the open/closed
WebSocket protocol tests and installed Rust CLI golden test; typecheck, command
manifest parity, release archive checksum, installed CLI checksum, and artifact
provenance also passed.

The real Telegram sandbox regression remains pending because no
`TELEGRAM_TEST_BOT_TOKEN` and `TELEGRAM_TEST_CHAT_ID` are configured.

The production `agent-team` Buzz rollout is active on Railway deployment
`e6ea885b-742a-47b5-9dee-fd396901ba3b`, pinned to `torana@2.0.0-rc.1` and the
Block Buzz CLI `desktop-v0.5.3` source. Buzz Desktop registers Jules and Cato as
deployed provider-backed agents, preventing explicit mentions from starting
second local runtimes. The corrected Jules test dispatched exactly one Torana
turn (`4079`) and produced one visible reply. Cato was then added behind a
separate disabled endpoint gate in `agent-team` commit `10ff31a`; the disabled
deployment passed before activation. His final test dispatched exactly one
Torana turn (`4080`) and produced one visible reply. Both tests left the Desktop
local-worker process set unchanged. Both endpoints are healthy and connected
with one isolated conversation/session each and empty queues and Buzz outboxes.
The 24-hour two-persona observation window began at 2026-08-02 22:07:57 UTC
(16:07:57 MDT).

The mixed-platform harness uses five personas, Telegram plus cryptographically
signed Buzz delivery, configurable realistic conversation counts, durable
outbox assertions, and a one-to-one session-isolation invariant. Smoke it with:

```sh
BUZZ_PLATFORM_SOAK=1 \
BUZZ_PLATFORM_SOAK_DURATION_MS=300000 \
BUZZ_PLATFORM_SOAK_INTERVAL_MS=1000 \
bun test test/soak/buzz-platform.test.ts
```

Omit the duration and interval overrides for the 24-hour release gate. Set
`BUZZ_PLATFORM_SOAK_ARTIFACT_DIR` to retain the JSON summary.

Production approval still requires the real Telegram regression E2E, a real
external open-relay E2E, fresh cross-process Codex and Claude restart checks,
completion of the 24-hour canary observation and mixed-platform soak, full-team
rollout, and rollback
rehearsal. Do not tag or publish 2.0.0 until those gates are recorded.

## Buzz remote-agents conformance and provider (US-021 … US-026)

Implementation evidence for
[buzz-remote-agents-plan.md](buzz-remote-agents-plan.md); per-phase detail in
[tasks/buzz-remote-agents-progress.md](../tasks/buzz-remote-agents-progress.md).

**Versions and hashes.** Buzz `desktop-v0.5.5` at
`8342dfcc5890b81a269a8ec3db73a8a56f76ce79`, Apple-silicon asset `502011159`
(97,561,748 bytes), archive SHA-256
`7fe09906460fd85e6f215af4074b50c2963f2bd3e218c75de4d6fb21a11520e3`, bundled and
installed CLI `8f59ea1a877fce972ce1d0165b9deda457085c21ee2c36ef497b8038812fdac9`
(byte-for-byte identical), CDHash `92f000da71c9dd221335c037d203eb8e5bc6f833`,
Team ID `EYF346PHUG` unchanged. Verified live by re-downloading the release, not
transcribed. The 0.5.5 command surface is identical to 0.5.4 — the regenerated
manifest differs only in the checksum — so no broker policy tier changed.

**Spec pin.** `docs/remote-agents.md` at the `desktop-v0.5.5` tree supersedes
`28ae6cd21`. `NIP-OA.md` and `NIP-AA.md` are unchanged between them. Two
normative deltas: the I3 presence TTL is 180 s (the plan already assumed this),
and a new "one create attempt per call" rule, which the provider implements as
one `PUT` per deploy followed by poll-only.

**Local gate, all green.** `bun test` 1512 pass / 16 skip / 0 fail; typecheck,
lint, and format clean; build + `verify-pack` (16/16 SQL files, now including
the 0006 and 0007 migrations that were missing from the required list); skill
parity 3/3; spike tests 10/10; `manifest:check` and `provenance:check` pass.

**Presence soak (Phase 2 gate).** 10 minutes against the fake relay with up to
1500 ms injected latency on every publish and query: 93 presence refreshes,
worst gap 7893 ms, mean 6419 ms, zero suppressed, zero failed, endpoint healthy
throughout. Reproduce with `BUZZ_PRESENCE_SOAK=1 bun test
test/soak/buzz-presence.test.ts`. Carry into production observation: the
supervisor waits `heartbeat_secs` _after_ each refresh completes, so the real
cadence is the interval plus relay round-trip — roughly 30 s + RTT at the
shipped default, not exactly 30 s.

**Provider E2E (Phase 5 gate).** `BUZZ_PROVIDER_E2E=1 bun test
test/provider/provider.e2e.test.ts` compiles the real binary, starts a gateway,
and deploys against it: the endpoint connects and publishes presence, a second
identical deploy reconciles to `unchanged`, and neither stdout nor stderr nor
the status response contains the nsec or the admin token.

**Deployment repo.** `agent-team` commit `04bbf3a` lands the edge policy ahead
of the Torana release that ships the routes: the literal method-scoped proxy
allowlist with neighbour-still-404 regression tests, a 64 KiB body cap,
per-client rate limiting, the `BUZZ_PROVISION_ENABLED` /
`TORANA_ADMIN_TOKEN_BUZZ_PROVISION` / `TORANA_PROVISIONING_SECRETS_KEY` env
contract with credential-reuse rejection, and the provider-based conversion
runbook.

### Released 2026-08-07 — `2.0.0-rc.11`

Published on the `rc` dist-tag by `release.yml` run `31140035625` (tag
`v2.0.0-rc.11`, integrity
`sha512-UsxOxoRBlU+Ynpeun4nqplb5EFTEJUo88dpnGI/5fwFOobWtVrDil1WQXgL8ZTTASXDjJyO46HF53HoU8PUyvw==`).

One behavioural change: outbound-only publishers announce presence on connect,
on every heartbeat, and `offline` on stop. **No schema migration** — v7 from
rc.10 is current — and the `desktop-v0.5.5` CLI pin is unchanged, so this
version needs neither a `torana migrate` step nor a Linux `buzz` rebuild. That
makes it the one deploy in this series that is just a package bump.

Provider binaries built and checksummed by the same run, both verified locally
with `shasum -a 256 -c SHA256SUMS`:

| Platform     | SHA-256                                                            |
| ------------ | ------------------------------------------------------------------ |
| darwin-arm64 | `311d14bb09d6da1da09acaa4f1f8d276fd5ab135994984d065b9b4ef868dea97` |
| linux-x64    | `51bba8234fd88dda94c8441974fd4b3407eadf1a7dddfef087053fd290971c92` |

**Use these, not rc.10's**, when installing the provider on the operator's Mac:

```
gh run download 31140035625 -R jvbutterfield/torana -n buzz-backend-torana
```

Not yet deployed to `agent-team` at the time of writing.

### Released and deployed, 2026-08-06

1. **`torana@2.0.0-rc.10`** published on the `rc` dist-tag by `release.yml`
   run `31103224191` (tag `v2.0.0-rc.10`, integrity
   `sha512-LBdqsOVymg2ifCKmHMvIhQOoIVIH7FgihV4OhCKHlrFCDCIaZ6TI0/M5EvogoEkKjxDwW+3lDhCzpJtfxVcJgQ==`).
   The registry tarball was installed in a disposable directory and verified to
   contain all seven migrations. The release also builds and checksums the
   provider binaries: `2318781f…011a` (darwin-arm64), `e148ba14…a764`
   (linux-x64).
2. **Image pin.** `agent-team` `aa5d472` moved `BUZZ_SOURCE_TAG`,
   `BUZZ_SOURCE_COMMIT`, and the `torana@` package pin in one commit. In the
   running container `sha256sum /usr/local/bin/buzz` and
   `/usr/local/share/torana/buzz-cli.sha256` both read
   `c83fcfbe57e9c7a368c0deb4749a028a0f5e5ddbd8e5e9a7111bfcc9acb62876`, and
   `torana version` reports `2.0.0-rc.10`.
3. **Migration.** Schema v7 applied on the first boot of the new image, by
   `deploy/bin/torana-migrate`:
   `schema 6 → 7; snapshotting before migrating` →
   `snapshot written to /data/gateway/gateway.db.pre-v7` →
   `migrations complete from=6 to=7 steps=1` → `migrated to user_version=7`,
   followed by `torana ready`. The v6 rollback copy is on the volume.
4. **Deploy and observe.** Railway deployment `bf55fe88` (commit `194f4de`)
   promoted SUCCESS. `/health` reports `status: ok`, all five runners ready,
   and all five Buzz endpoints — `alfred-buzz`, `cato-buzz`, `dev-team-buzz`,
   `harper-buzz`, `jules-buzz` — `active` / `healthy` / `connected` with
   `diagnosis: none`, zero pending outbox, and the new presence block showing
   `stale: false`, `consecutive_failures: 0`. The dead outbox rows that remain
   are from May and predate this work. Publicly, `/v1/bots`, `/v1/health`,
   `/v1/admin/sessions`, and `/v1/admin/endpoints` all 404, and so does the
   provisioning path under every method — provisioning is off by default and
   was left off.

Two deployments failed before this one, both worth recording. The first put the
migration in `entrypoint.sh`, which runs before the secrets that `torana.yaml`
interpolates are exported, so `torana migrate --config` could not load the
config; the script had also discarded stderr, which turned a one-line cause
into an opaque failure. The second surfaced a pre-existing proxy bug that the
provisioning route would have hit on its first real deploy: a GET immediately
after a body-carrying PUT on the same keep-alive connection hung, because the
generic path forwards request bodies as streams. Both are fixed, tested, and
recorded in the deployment runbook's symptom table.

### Presence soak — Torana side, 2026-08-06

Sampled `/health` from inside the container across **30.9 minutes**, all five
production Buzz endpoints (`alfred-buzz`, `cato-buzz`, `dev-team-buzz`,
`harper-buzz`, `jules-buzz`):

| Measure                                      | Result                  |
| -------------------------------------------- | ----------------------- |
| Samples showing a fresh publish              | 31 / 31, every endpoint |
| Worst observed staleness                     | 31.7 s                  |
| Margin against the relay's 180 s TTL         | ~148 s                  |
| Stale flips / failed publishes / disconnects | none                    |
| Runtime state                                | `healthy` throughout    |

A second, finer-grained watch (10 s poll, 4.7 min) measured the refresh
interval directly rather than inferring it: **30.1–31.8 s, mean 30.2 s** — the
configured 30 s heartbeat plus roughly 200 ms of relay round-trip. That
confirms the prediction recorded from the fake-relay soak: production cadence
is the interval plus RTT, and the RTT here is small.

**Measurement caveat, recorded because it nearly produced a wrong conclusion.**
The first pass polled every 60 s against a 30 s heartbeat and reported an
apparent 61.9 s "refresh gap". That is aliasing, not the system: each sample
sees the newest publish two refreshes on, so the apparent gap collapses to the
poll period. The same run's worst observed staleness was 31.7 s, which is
impossible at a true 61 s cadence, and the 10 s watch settled it. Any future
run must poll faster than the heartbeat; the analyzer now detects this
condition and reads the staleness bound instead.

**What this establishes and what it does not.** It establishes that the US-022
fix works under real production traffic: presence publishes continuously, the
rate limiter suppresses none of it, and the endpoints hold ~148 s of headroom
before the relay would expire them. It does _not_ establish independence from
Buzz Desktop — whether Desktop was running during the window was not observed
— and it cannot speak to what other members' clients render, since relay
fan-out is per-node upstream.

### Owner `!shutdown` drill — 2026-08-07, PASS

Owner published `!shutdown` mentioning `jules-buzz` (chosen as the least active
conversational endpoint: 4 turns in 7 days). Gateway-side evidence:

| Check                | Result                                                       |
| -------------------- | ------------------------------------------------------------ |
| Event classification | `status: control`, `status_reason: owner_shutdown` (id 4418) |
| Author               | the configured owner pubkey                                  |
| **Turn created**     | **none** — latest turn remained 4079, from Aug 2             |
| **Reply published**  | **none** — zero outbox rows in the hour                      |
| Drain                | `running_or_queued: 0`, `outbox_pending: 0`                  |
| Terminal state       | `disabled`, `state_reason: owner_shutdown`                   |
| Log sequence         | `owner shutdown requested` → `stopped by owner`, 32 ms apart |
| Presence `offline`   | observed by the owner's own Buzz client                      |

The two empty rows are the point: the agent did not answer its own stop
command. Before this change the same message produced an ordinary reply and a
still-running agent — the invariant I5 violation the specification names.

**Stay-down across a restart.** `supervisorctl restart telegram-gateway`
produced a full container restart (the runtime supervisor treats a gateway exit
as fatal, so there is no way to bounce torana alone on this deployment). The
gateway re-ran the entrypoint, the schema migration, and `syncNormalizedConfig`.
Afterwards `jules-buzz` was still `disabled` / disconnected while the other four
Buzz endpoints reconnected `healthy`. The migration logged `schema already
current (user_version=7)` — idempotent in production, as designed.

Jules's Telegram endpoint and runner were unaffected: `!shutdown` disables the
Buzz endpoint, not the agent.

### Presence soak — client side, confirmed 2026-08-07

With Buzz Desktop closed and then reopened, the owner confirmed the other four
Torana agents show online in their Buzz client. Combined with the Torana-side
soak and the identity-disjointness argument above, the presence gate is closed:
Torana publishes continuously, nothing local can be responsible, and the relay
delivers it to a client.

### Still outstanding — requires the Desktop or a live drill

1. **Owner-mention canary** on the new build.
2. **Record conversion.** Jules and Cato re-deployed through the provider for
   consistent `railway:agent-team:<endpoint-id>` addressing; Alfred and Harper
   converted. Order per agent is fixed by the precedence rule: remove the YAML
   endpoint, redeploy, provider-deploy, then retire the `BUZZ_*_<AGENT>`
   variables. One agent at a time, verifying no duplicate local runtime spawns
   on an explicit mention. **Dev Team is record-flag only** — it is an
   outbound-only publisher principal with no runner, so provider deploy refuses
   it naturally (no agent to bind to); its Desktop record just needs marking
   provider-backed or archiving.
3. **Provider re-deploy of the stopped agent.** The drill's remaining half:
   bring `jules-buzz` back through a provider `deploy` rather than
   `torana endpoints resume`, and verify a second Start reconciles to a no-op.
   Blocked on provisioning being enabled.
4. **Manual Desktop deploy.** One real deploy from Buzz Desktop 0.5.5 on macOS
   into a staging Torana, which is the only way to exercise the Desktop's own
   discovery, form rendering, and payload shape.
