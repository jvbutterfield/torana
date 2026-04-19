-- torana v2 schema. Single source of truth — migrate.ts applies this on
-- fresh installs; migrations/0001_persona_to_bot_id.sql upgrades v0 →v1, and
-- migrations/0002_agent_api.sql upgrades v1→v2.
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
  error_text             TEXT,
  -- Agent API columns (NULL for telegram-origin rows).
  source                 TEXT,                                 -- telegram | agent_api_ask | agent_api_inject
  agent_api_token_name   TEXT,
  agent_api_source_label TEXT,
  final_text             TEXT,
  idempotency_key        TEXT,
  usage_json             TEXT,
  duration_ms            INTEGER
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

-- Agent API tables.
CREATE TABLE IF NOT EXISTS user_chats (
  bot_id            TEXT    NOT NULL,
  telegram_user_id  TEXT    NOT NULL,
  chat_id           INTEGER NOT NULL,
  last_inbound_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bot_id, telegram_user_id)
);

CREATE TABLE IF NOT EXISTS agent_api_idempotency (
  bot_id            TEXT    NOT NULL,
  idempotency_key   TEXT    NOT NULL,
  turn_id           INTEGER NOT NULL REFERENCES turns(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bot_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS side_sessions (
  bot_id            TEXT    NOT NULL,
  session_id        TEXT    NOT NULL,
  pid               INTEGER,
  started_at        TEXT    NOT NULL,
  last_used_at      TEXT    NOT NULL,
  hard_expires_at   TEXT    NOT NULL,
  state             TEXT    NOT NULL,  -- starting|ready|busy|stopping|stopped
  PRIMARY KEY (bot_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_turns_bot_status   ON turns(bot_id, status);
CREATE INDEX IF NOT EXISTS idx_outbox_status_next ON outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_inbound_bot_status ON inbound_updates(bot_id, status);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON agent_api_idempotency(created_at);
CREATE INDEX IF NOT EXISTS idx_turns_idempotency
  ON turns(bot_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbound_bot_negid
  ON inbound_updates(bot_id, telegram_update_id)
  WHERE telegram_update_id < 0;
