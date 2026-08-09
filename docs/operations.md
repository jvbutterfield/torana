# Operations

## Data directory layout

```
<data_dir>/
  gateway.db                         # SQLite state (WAL)
  gateway.db.pre-v1                  # auto-snapshot before a v0→v1 migration
  gateway.db.pre-v5                  # auto-snapshot before normalized schema activation
  attachments/<bot_id>/              # inbound files (safe filenames only — see security.md)
  logs/<bot_id>.log                  # runner stdout+stderr, tailable
  state/<bot_id>/                    # per-runner scratch (e.g. Claude config dir)
```

## Health endpoint

`GET /health` → JSON. Always on:

```json
{
  "status": "ok",
  "bots": {
    "assistant": {
      "botId": "assistant",
      "runner_ready": true,
      "mailbox_depth": 0,
      "last_turn_at": "2026-04-18T12:00:00Z",
      "disabled": false,
      "disabled_reason": null
    }
  },
  "endpoints": [
    {
      "endpoint_id": "assistant-buzz",
      "agent_id": "assistant",
      "platform": "buzz",
      "lifecycle_state": "active",
      "runtime_state": "healthy",
      "connected": true,
      "diagnosis": "none",
      "last_error": null,
      "subscriptions": 4,
      "presence": {
        "last_published_at": 1786000000000,
        "consecutive_failures": 0,
        "stale": false
      },
      "queue": { "queued": 0, "running": 0 },
      "conversations": 12,
      "sessions": 8,
      "outbox": { "pending": 0, "dead": 0 }
    }
  ],
  "uptime_secs": 3600
}
```

Returns HTTP 503 if any bot's runner isn't ready or a Buzz endpoint is
unhealthy. `diagnosis` is a bounded operator hint (`key`, `auth`, `membership`,
or `reconnect`); the redacted `last_error` carries the supporting detail.

`presence` is the liveness signal Buzz clients actually read. An endpoint whose
`last_error` is `presence_stale` is **connected but going invisible**: the
relay expires presence 180 s after the last accepted publish, so once
`consecutive_failures` reaches `limits.presence_failure_threshold` the endpoint
is marked unhealthy and alerts, while the connection itself is still fine.
Diagnose it as a publish/permission problem on the agent's own key, not as a
reconnect. Note that presence fan-out is per relay node upstream, so an agent
can legitimately look offline to some viewers and online to others while
`presence.stale` is `false` — that asymmetry is not a Torana fault and is not
fixable from here.

## Metrics endpoint

`GET /metrics` → Prometheus text exposition format. **Off by default** — set `metrics.enabled: true` to expose.

```
gateway_uptime_secs 3847
bot_state{bot_id="assistant"} 2
turns_total{bot_id="assistant",status="completed"} 142
turns_total{bot_id="assistant",status="failed"} 3
telegram_api_calls_total{status="2xx"} 1024
torana_endpoint_connection_state{platform="buzz",endpoint_id="assistant-buzz",state="healthy"} 1
torana_conversation_queue_depth{platform="buzz",endpoint_id="assistant-buzz",state="queued"} 0
torana_endpoint_outbox_depth{platform="buzz",endpoint_id="assistant-buzz",status="dead"} 0
torana_endpoint_presence_publishes_total{platform="buzz",endpoint_id="assistant-buzz",outcome="published"} 120
torana_endpoint_presence_publishes_total{platform="buzz",endpoint_id="assistant-buzz",outcome="suppressed"} 0
torana_endpoint_presence_publishes_total{platform="buzz",endpoint_id="assistant-buzz",outcome="failed"} 0
torana_endpoint_presence_stale{platform="buzz",endpoint_id="assistant-buzz"} 0
```

A non-zero `outcome="suppressed"` means a lifecycle presence refresh was
dropped by the presence rate limiter, which the lifecycle exemption is supposed
to make impossible — treat it as a regression, not as tuning.

`bot_state` values: `0=disabled`, `1=starting`, `2=ready`, `3=busy`, `4=crash_loop`.

The endpoint/platform labels are bounded by configured endpoints. Conversation,
session, event, and turn identifiers are deliberately excluded from metric
labels. No auth on the endpoint in v1 — don't expose the port publicly. Scrape
it from within the same network.

## Logs

Structured JSON by default (auto-switches to human-readable text when stdout is a TTY). Every line includes `{ts, level, module, msg, ...fields}`. Runner subprocess output is captured separately to `${data_dir}/logs/<bot_id>.log` (tailable).

Secret redaction: the central logger strips known secrets and `/bot<TOKEN>/` URL segments from every emit. Callers can't opt out.

## Crash recovery

Every startup runs crash recovery:

- **Orphaned turns** (`status='running'` with no active worker) are either re-queued (if no output yet) or marked `interrupted` (if partial output). The user is sent a one-liner for the interrupted case.
- **Superseded outbox edits** — if a newer `send` already landed for the same `telegram_message_id`, older pending edits are marked failed to avoid clobbering.
- **Worker state** is reset to `starting` so everything resumes clean.

## Migrations

```sh
torana migrate --config ./torana.yaml            # apply pending
torana migrate --config ./torana.yaml --dry-run  # preview steps + sanitized backfill counts
torana migrate --config ./torana.yaml --to 6     # explicit bridge activation
```

The compatibility bridge can run v1 configuration on schema v3 or v5. It does
not migrate merely because it starts. A v2 configuration requires schema v6.
Use `--auto-migrate` only when an explicit automatic schema jump is intended.

### v3 → v5 compatibility bridge

Use this sequence for the Phase 2 rollout:

1. Deploy and soak the bridge binary on schema v3 with the existing v1 config.
2. Stop intake for the maintenance window.
3. Run `torana migrate --dry-run` and review the sanitized backfill counts.
4. Run `torana migrate --to 6`. Torana writes
   `gateway.db.pre-v5`, applies the normalized schema, and enables incremental
   auto-vacuum before intake resumes.
5. Run `torana doctor`, restart the bridge on schema v5, and soak it before
   switching to a v2 config.

Preferred rollback is binary-only: stop the 2.0 process and start the tested
compatibility bridge with the v1 config against the same schema-v5 database.
It continues Telegram and Agent API from dual-written rows and leaves Buzz
rows untouched.

Snapshot restoration is emergency-only and loses activity after the snapshot.
Before restoring, preserve the current v5 database for forensics. With Torana
stopped, replace the database with `gateway.db.pre-v5` (and its matching WAL/
SHM sidecars if present), then start the pre-migration binary and verify with
`torana doctor`.

### v0 → v1 (pre-release deployments only)

A one-time `persona → bot_id` rename + status remap, relevant only to a
deployment that predates the first public release. Forward-only. Before the
first v1 boot, your deployment must snapshot the DB:

```sh
cp /data/gateway/gateway.db /data/gateway/gateway.db.pre-v1
# copy -wal and -shm sidecars too if they exist
```

torana's entrypoint can do this automatically when `snapshotV0Upgrade: true` is set on migrate (see `src/db/migrate.ts`). **Do the snapshot before any v1 process opens the DB** — otherwise WAL sidecars may already reflect partial checkpointing.

A v0 process cannot run against a v1 DB. Rollback = restore from the snapshot; you lose turns processed by v1 after cutover. Document this in your deploy runbook.

## Graceful shutdown

On `SIGTERM`/`SIGINT`:

1. Transports stop accepting new updates; in-flight webhook handlers complete their enqueue transaction.
2. Accepted conversation turns drain for up to `shutdown.runner_grace_secs`;
   undispatched rows remain durable, while over-budget active turns are marked
   interrupted.
3. Streaming cadence is cancelled, then the durable outbox drains for up to
   `shutdown.outbox_drain_secs` (default 10).
4. Agent API sessions, conversation sessions, runners, and the Buzz credential
   broker stop within the remaining runner grace.
5. HTTP/relay sockets close, then SQLite checkpoints and closes. Exit 0.

Hard-cutoff at `shutdown.hard_timeout_secs` (default 25). Tuned to fit within Railway's 30s SIGKILL window.

## Owner `!shutdown` (remote-agent Stop)

Buzz Desktop's "Stop" for a provider-backed agent is not an RPC — it publishes
a stream message whose content is exactly `!shutdown`, p-tagging the agent,
signed by the owner. Torana treats that as a control command, never as a
prompt:

1. intake stops and the endpoint's `lifecycle_state` becomes `draining` with
   `state_reason = owner_shutdown`;
2. in-flight turns drain for up to `limits.owner_shutdown_drain_ms`
   (default 30000) — the relay connection stays up for this, so replies still
   land;
3. presence `offline` is published, so clients stop showing the agent as
   online immediately instead of waiting out the relay's 180 s TTL;
4. `lifecycle_state` becomes `disabled`, and the connection closes.

**It stays down against the runtime.** `disabled` is durable: no process
restart, supervisor flap, or reconnect re-enables it — that is the point of the
invariant, not an accident.

**A provider deploy does bring it back**, either from `torana endpoints resume
<id>` or from a Buzz Desktop "Start". Since Desktop 0.5.6 that second path is
**not necessarily an explicit human act**: the Desktop redeploys every
provider-backed agent automatically before loading community UI, and the deploy
protocol carries no field distinguishing that reconcile from an owner pressing
Start — same operation, same payload, a fresh request id on both. Torana
therefore cannot tell them apart and honours the deploy, rather than breaking
the Start button for every stopped agent.

In practice: **opening the Buzz community UI can restart an agent you stopped
with `!shutdown`.** A revive is never silent — it logs
`Buzz endpoint revived by deploy after an owner shutdown` and the provisioning
API returns `result: "revived"` rather than `replaced` — but it is not
prevented.

There is currently **no Torana-side stop that a deploy cannot clear**: deleting
the endpoint does not help either, because the next deploy simply creates it
again. Stopping the redeploys means removing their source — delete the managed
agent record in Buzz Desktop, or revoke the `endpoints:admin` token its provider
uses.

Only the endpoint's configured `owner_pubkey` can do this, on every
`respond_to` setting, including `anyone`. A `!shutdown` from anyone else is an
ordinary message, and so is a message that merely contains the word — the
match is on the trimmed content being exactly `!shutdown`, which is what the
Desktop sends and what the upstream harness matches. Set
`owner_shutdown: disabled` on the endpoint to opt out; the endpoint then
answers stop commands as prompts, which is the pre-conformance behaviour.

## Config reload

v1 reads config once at startup. SIGHUP is **not** handled — restart to apply changes.

## Buzz key and auth rotation

Drain the endpoint, wait for accepted turns and its outbox to reach zero, then
replace the endpoint private key and matching owner-signed auth tag together.
`torana validate` rejects a new key paired with the old tag. Run `torana
doctor`, restart, and confirm `/health` reports the expected identity and no
`key` or `auth` diagnosis before resuming. Never delete old pending signed rows;
they remain historical evidence and should be dead-lettered explicitly if they
must not publish.

Membership changes arrive live. Removal stops intake for that channel without
advancing past an unprocessed accepted event. After an intentional access
change, inspect endpoint status and cursor age before assuming the relay is at
fault.

## Rotating `TORANA_PROVISIONING_SECRETS_KEY`

Every provisioned endpoint's private key and auth tag are sealed under this key.
Rotating it takes two deploys, needs no re-provisioning, and has no downtime
beyond the rolling restarts the config edits already cause.

1. **Add the new key in front of the old one.** The variable is a
   comma-separated list, primary first:

   ```sh
   TORANA_PROVISIONING_SECRETS_KEY="<new>,<old>"
   ```

2. **Redeploy.** At startup the gateway re-seals every row that still opens
   under the outgoing key, logging one line per row:

   ```
   re-sealed a provisioned endpoint under the primary key  endpoint_id=… was_key_index=1
   re-sealed provisioned endpoints under the primary key   resealed=3 already_primary=0
   ```

3. **Confirm nothing is left on the old key** before you delete it. `torana
doctor` C029 answers exactly this question:

   ```
   C029  ok    3 provisioned Buzz endpoint(s) decrypt with the primary key; the 1 outgoing key(s) are no longer needed
   ```

   A `warn` here — "still sealed under an outgoing key" — means step 2 has not
   taken effect yet. **Do not proceed while it says that**: deleting the old key
   at that point destroys those agent identities permanently.

4. **Drop the old key** and redeploy again:

   ```sh
   TORANA_PROVISIONING_SECRETS_KEY="<new>"
   ```

During the window both processes hold both keys, so an in-flight deploy seals
under whichever primary its process holds and stays readable by the other. New
rows are always sealed under the primary, never the outgoing key.

Listing the same key twice is rejected at startup — it is nearly always a
half-finished edit that would report every row as already current while changing
nothing. A row that opens under **no** configured key is left untouched and
reported, by both C029 and the startup restore, which fails closed rather than
running an endpoint nobody can account for.

## Rotating the `endpoints:admin` token

Bearer auth is per-request and the `tokens[]` array accepts several entries, so
this needs no coordination beyond the redeploys the config edits already cause.

1. Add the new token alongside the existing one and redeploy.
2. Switch the Desktop provider's local config
   (`~/.config/torana/provider.json`) to the new value and confirm a deploy
   still succeeds.
3. Remove the old entry and redeploy.

If the new token is the wildcard (`bot_ids: ["*"]`), remember it must be
sole-scope `endpoints:admin`; config validation rejects it combined with `ask`
or `send`.

## Provisioning audit retention

`provisioning_audit` records every lifecycle transition for Desktop-managed
agents: create, update, start, stop, stage-delete, restore, purge, reject, and
every tombstone that deleted nothing. **Nothing sweeps it.** Pruning is an
explicit operator act:

```sh
torana audit prune --dry-run          # what would go, using retention.provisioning_audit_days
torana audit prune --before 2026-01-01
```

Purge records are skipped by default and reported separately:

```
deleted 214 audit row(s) older than 2025-08-09 00:00:00
kept 3 purge record(s) — they outlive the agents they describe; use --include-purge-records --acknowledge-data-loss to remove them
```

A purge record is the only surviving evidence of what a purge destroyed — agent
id, pubkey, endpoint, workspace path and byte count, instruction version, the
tombstone that staged it, and the timestamps. Removing one takes both
`--include-purge-records` and `--acknowledge-data-loss`. Prompts appear in audit
detail only as digests; secrets never appear at all.

## Staged-deletion alerts

A verified tombstone stages a deletion and fires an alert naming the purge
deadline and the command to reverse it. When a single sweep stages two or more
agents the text escalates to `persona cascade suspected: N agents staged` —
Buzz's persona-delete cascade tombstones every agent derived from that persona,
and the events are indistinguishable on the wire from a single deliberate
delete. The alert is how you learn the blast radius while every one of them is
still reversible:

```sh
torana agents list              # lifecycle + purge_at per agent
torana agents restore <id>      # cancel one, during its grace window
```

See [platforms/buzz](platforms/buzz.md#deleting-is-staged-never-immediate) for
what restore does and does not do.

## One-time setup for Desktop-managed agents

Complete once. After it, creating, updating, starting, stopping, and deleting a
Desktop-managed agent needs **zero** Railway-side action — no YAML edit, no
redeploy, no `railway ssh`.

1. **Railway variables:** `TORANA_PROVISIONING_SECRETS_KEY`, the
   `endpoints:admin` token secret, and any model credentials the harness base
   env references (e.g. `ANTHROPIC_API_KEY`).
2. **`torana.yaml` in the deploy image:** the
   [`provisioning`](configuration.md#provisioning) block — harness allowlist,
   `max_agents`, `delete_grace_hours`, quotas, `buzz_tools_default` — plus the
   wildcard `endpoints:admin` token entry.
3. **Edge proxy allowlist:** the agent routes, literal and method-scoped —
   `GET /v1/admin/buzz/agents`, `GET|DELETE /v1/admin/buzz/agents/:id`,
   `POST /v1/admin/buzz/agents/:id/restore`,
   `GET /v1/admin/buzz/reconciliation`.
4. **Volume:** confirm headroom for `workspaces/` above `min_free_bytes`.
5. **Desktop machine:** provider binary on `PATH`, `~/.config/torana/provider.json`
   holding the token, and each agent's provider config supplying
   `torana_agent_id` (plus optional `torana_harness`).
6. **Schema:** migration to v8 rides the standard deploy (`--auto-migrate`).

**The honest exceptions.** These remain gateway-level and each needs a redeploy:
adding a harness to the allowlist, changing ceilings, caps, or the grace period,
and rotating either long-lived secret. The claim is "no _per-agent_
configuration", not "no configuration at all".

## Buzz canary rollout

1. Deploy with `platforms.buzz.enabled: false`; run validate and doctor.
2. If Buzz Desktop also manages the canary identity, register the hosted runtime
   as a deployed provider-backed agent before enabling it. Merely stopping a
   local managed agent is insufficient: an explicit mention can start that
   local runtime and produce a duplicate reply alongside Torana.
3. Mark exactly one Buzz endpoint enabled, then turn on the master switch.
4. Observe health, reconnect age, queue/outbox depth, dedup, and conversation
   isolation across ordinary mentions, DMs, and one restart.
5. Enable remaining endpoints individually. Keep proactive triggers off.
6. Rehearse a drain and binary rollback before tagging 2.0.0.

Run the 24-hour mixed-platform soak before a release gate:

```sh
BUZZ_PLATFORM_SOAK=1 bun test test/soak/buzz-platform.test.ts
```

Set `BUZZ_PLATFORM_SOAK_DURATION_MS` and `BUZZ_PLATFORM_SOAK_INTERVAL_MS` to
smoke it in minutes instead, and `BUZZ_PLATFORM_SOAK_ARTIFACT_DIR` to retain the
JSON summary.

## Runbook snippets

### Inspect and rotate conversation sessions

```
torana sessions list --config /data/torana.yaml
torana sessions reset <session-key> --config /data/torana.yaml
```

### Inspect pending outbox

```
torana outbox list --config /data/torana.yaml
torana outbox dead-letter <id> --config /data/torana.yaml
torana outbox replay <id> --config /data/torana.yaml
```

Replay republishes the exact stored payload and signed Buzz event; it never
re-signs. To stop new intake and let accepted work drain gateway-wide:

```sh
torana gateway drain --config /data/torana.yaml
```

### Force re-poll from scratch (one bot)

```
sqlite3 /data/gateway/gateway.db "UPDATE bot_state SET last_update_id=NULL WHERE bot_id='assistant'"
```

(Dedup will still suppress any updates you've already processed.)

### Disable a bot temporarily

```
sqlite3 /data/gateway/gateway.db "UPDATE bot_state SET disabled=1, disabled_reason='manual' WHERE bot_id='assistant'"
```

(Pollers exit the next loop iteration; webhook endpoints still 200-ack.)
