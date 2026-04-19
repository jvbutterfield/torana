-- 0002 — Agent API tables + turns column extensions.
--
-- Adds three new tables (user_chats, agent_api_idempotency, side_sessions)
-- plus nullable columns on `turns` so existing telegram rows stay valid.
-- See tasks/impl-agent-api.md §3.2 for the design rationale.

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
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON agent_api_idempotency(created_at);

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

ALTER TABLE turns ADD COLUMN source                 TEXT;
ALTER TABLE turns ADD COLUMN agent_api_token_name   TEXT;
ALTER TABLE turns ADD COLUMN agent_api_source_label TEXT;
ALTER TABLE turns ADD COLUMN final_text             TEXT;
ALTER TABLE turns ADD COLUMN idempotency_key        TEXT;
ALTER TABLE turns ADD COLUMN usage_json             TEXT;
ALTER TABLE turns ADD COLUMN duration_ms            INTEGER;

CREATE INDEX IF NOT EXISTS idx_turns_idempotency
  ON turns(bot_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inbound_bot_negid
  ON inbound_updates(bot_id, telegram_update_id)
  WHERE telegram_update_id < 0;

PRAGMA user_version = 2;
