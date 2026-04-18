-- Upgrade v0 (agent-team pre-cutover) to v1.
-- Renames `persona` columns to `bot_id`, remaps inbound_updates.status values,
-- rebuilds indexes, and adds the bot_state table for polling offset tracking.
-- Runs inside a single BEGIN/COMMIT so crash mid-migration is safe.

BEGIN;

ALTER TABLE inbound_updates RENAME COLUMN persona TO bot_id;
ALTER TABLE turns            RENAME COLUMN persona TO bot_id;
ALTER TABLE outbox           RENAME COLUMN persona TO bot_id;
ALTER TABLE worker_state     RENAME COLUMN persona TO bot_id;

-- inbound_updates.status remap:
--   v0 queued/processing -> v1 enqueued (dedup-terminal)
--   v0 completed/failed  -> v1 processed (dedup-terminal)
--   v0 received          -> unchanged (transient / retryable)
UPDATE inbound_updates SET status = 'enqueued'  WHERE status IN ('queued', 'processing');
UPDATE inbound_updates SET status = 'processed' WHERE status IN ('completed', 'failed');

DROP INDEX IF EXISTS idx_turns_persona_status;
DROP INDEX IF EXISTS idx_outbox_status_next;
DROP INDEX IF EXISTS idx_inbound_persona_status;

CREATE INDEX idx_turns_bot_status   ON turns(bot_id, status);
CREATE INDEX idx_outbox_status_next ON outbox(status, next_attempt_at);
CREATE INDEX idx_inbound_bot_status ON inbound_updates(bot_id, status);

CREATE TABLE IF NOT EXISTS bot_state (
  bot_id         TEXT PRIMARY KEY,
  last_update_id INTEGER,
  disabled       INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

PRAGMA user_version = 1;

COMMIT;
