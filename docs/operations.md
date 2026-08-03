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
    "cato": {
      "botId": "cato",
      "runner_ready": true,
      "mailbox_depth": 0,
      "last_turn_at": "2026-04-18T12:00:00Z",
      "disabled": false,
      "disabled_reason": null
    }
  },
  "endpoints": [
    {
      "endpoint_id": "cato-buzz",
      "agent_id": "cato",
      "platform": "buzz",
      "lifecycle_state": "active",
      "runtime_state": "healthy",
      "connected": true,
      "diagnosis": "none",
      "last_error": null,
      "subscriptions": 4,
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

## Metrics endpoint

`GET /metrics` → Prometheus text exposition format. **Off by default** — set `metrics.enabled: true` to expose.

```
gateway_uptime_secs 3847
bot_state{bot_id="cato"} 2
turns_total{bot_id="cato",status="completed"} 142
turns_total{bot_id="cato",status="failed"} 3
telegram_api_calls_total{status="2xx"} 1024
torana_endpoint_connection_state{platform="buzz",endpoint_id="cato-buzz",state="healthy"} 1
torana_conversation_queue_depth{platform="buzz",endpoint_id="cato-buzz",state="queued"} 0
torana_endpoint_outbox_depth{platform="buzz",endpoint_id="cato-buzz",status="dead"} 0
```

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

### v0 → v1 (agent-team only)

A one-time `persona → bot_id` rename + status remap. Forward-only. Before the first v1 boot, your deployment must snapshot the DB:

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

See [`release-readiness.md`](release-readiness.md) for the 24-hour soak and
real-relay release gates.

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
sqlite3 /data/gateway/gateway.db "UPDATE bot_state SET last_update_id=NULL WHERE bot_id='cato'"
```

(Dedup will still suppress any updates you've already processed.)

### Disable a bot temporarily

```
sqlite3 /data/gateway/gateway.db "UPDATE bot_state SET disabled=1, disabled_reason='manual' WHERE bot_id='cato'"
```

(Pollers exit the next loop iteration; webhook endpoints still 200-ack.)
