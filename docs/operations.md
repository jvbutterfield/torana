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
  "uptime_secs": 3600
}
```

Returns HTTP 503 if any bot's runner isn't ready.

## Metrics endpoint

`GET /metrics` → Prometheus text exposition format. **Off by default** — set `metrics.enabled: true` to expose.

```
gateway_uptime_secs 3847
bot_state{bot_id="cato"} 2
turns_total{bot_id="cato",status="completed"} 142
turns_total{bot_id="cato",status="failed"} 3
telegram_api_calls_total{status="2xx"} 1024
```

`bot_state` values: `0=disabled`, `1=starting`, `2=ready`, `3=busy`, `4=crash_loop`.

No auth on the endpoint in v1 — don't expose the port publicly. Scrape it from within the same network.

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
torana migrate --config ./torana.yaml --to 5     # explicit bridge activation
```

The compatibility bridge can run v1 configuration on schema v3 or v5. It does
not migrate merely because it starts. A v2 configuration requires schema v5.
Use `--auto-migrate` only when an explicit automatic schema jump is intended.

### v3 → v5 compatibility bridge

Use this sequence for the Phase 2 rollout:

1. Deploy and soak the bridge binary on schema v3 with the existing v1 config.
2. Stop intake for the maintenance window.
3. Run `torana migrate --dry-run` and review the sanitized backfill counts.
4. Run `torana migrate --to 5`. Torana writes
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
2. Outbox drains for up to `shutdown.outbox_drain_secs` (default 10).
3. Each runner's `stop()` forwards `SIGTERM` to its subprocess with a grace window; then `SIGKILL`.
4. DB closes (checkpoints the WAL). Exit 0.

Hard-cutoff at `shutdown.hard_timeout_secs` (default 25). Tuned to fit within Railway's 30s SIGKILL window.

## Config reload

v1 reads config once at startup. SIGHUP is **not** handled — restart to apply changes.

## Runbook snippets

### Clear a stuck turn

```
sqlite3 /data/gateway/gateway.db "UPDATE turns SET status='failed' WHERE id=?"
```

### Inspect pending outbox

```
sqlite3 /data/gateway/gateway.db "SELECT id, bot_id, kind, attempt_count, last_error FROM outbox WHERE status IN ('pending','retrying') ORDER BY id"
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
