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

Production approval still requires the real Telegram regression E2E, real
open- and closed-relay Buzz E2E, real Codex and Claude restart continuity, the
24-hour soak, canary observation, full-team rollout, and rollback rehearsal.
Do not tag or publish 2.0.0 until those gates are recorded.
