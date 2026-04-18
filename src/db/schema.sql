-- torana v1 schema. Single source of truth — migrate.ts applies this on
-- fresh installs, and migrations/0001_persona_to_bot_id.sql upgrades v0.
--
-- Keep columns ordered logically. Indexes at the bottom.

CREATE TABLE IF NOT EXISTS inbound_updates (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id              TEXT    NOT NULL,
  telegram_update_id  INTEGER NOT NULL,
  chat_id             INTEGER NOT NULL,
  message_id          INTEGER NOT NULL,
  from_user_id        TEXT    NOT NULL,
  payload_json        TEXT    NOT NULL,
  received_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  status              TEXT    NOT NULL DEFAULT 'received',  -- received|enqueued|processed|rejected
  UNIQUE(bot_id, telegram_update_id)
);

CREATE TABLE IF NOT EXISTS turns (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id                 TEXT    NOT NULL,
  chat_id                INTEGER NOT NULL,
  source_update_id       INTEGER NOT NULL REFERENCES inbound_updates(id),
  status                 TEXT    NOT NULL DEFAULT 'queued', -- queued|running|completed|failed|interrupted|dead
  attachment_paths_json  TEXT,
  started_at             TEXT,
  completed_at           TEXT,
  worker_generation      INTEGER,
  first_output_at        TEXT,
  last_output_at         TEXT,
  error_text             TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id             INTEGER NOT NULL REFERENCES turns(id),
  bot_id              TEXT    NOT NULL,
  chat_id             INTEGER NOT NULL,
  kind                TEXT    NOT NULL,                   -- send|edit
  telegram_message_id INTEGER,
  payload_json        TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'pending', -- pending|retrying|sent|failed|dead
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT,
  last_error          TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS worker_state (
  bot_id               TEXT PRIMARY KEY,
  pid                  INTEGER,
  generation           INTEGER NOT NULL DEFAULT 0,
  status               TEXT    NOT NULL DEFAULT 'starting',
  started_at           TEXT,
  last_event_at        TEXT,
  last_ready_at        TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT
);

CREATE TABLE IF NOT EXISTS stream_state (
  turn_id                    INTEGER PRIMARY KEY REFERENCES turns(id),
  active_telegram_message_id INTEGER,
  buffer_text                TEXT    NOT NULL DEFAULT '',
  last_flushed_at            TEXT,
  segment_index              INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bot_state (
  bot_id         TEXT PRIMARY KEY,
  last_update_id INTEGER,
  disabled       INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_turns_bot_status   ON turns(bot_id, status);
CREATE INDEX IF NOT EXISTS idx_outbox_status_next ON outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_inbound_bot_status ON inbound_updates(bot_id, status);
