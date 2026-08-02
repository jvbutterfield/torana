PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

CREATE TABLE turns_v5 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT,
  chat_id INTEGER,
  source_update_id INTEGER REFERENCES inbound_updates(id),
  status TEXT NOT NULL DEFAULT 'queued',
  attachment_paths_json TEXT,
  started_at TEXT,
  completed_at TEXT,
  worker_generation INTEGER,
  first_output_at TEXT,
  last_output_at TEXT,
  error_text TEXT,
  source TEXT,
  agent_api_token_name TEXT,
  agent_api_source_label TEXT,
  final_text TEXT,
  idempotency_key TEXT,
  usage_json TEXT,
  duration_ms INTEGER,
  agent_id TEXT NOT NULL,
  conversation_id INTEGER REFERENCES conversations(id),
  session_key TEXT,
  source_platform TEXT NOT NULL,
  source_event_id INTEGER REFERENCES inbound_events(id),
  retry_of_turn_id INTEGER REFERENCES turns(id),
  prompt_text TEXT,
  prompt_markdown INTEGER NOT NULL DEFAULT 0,
  prompt_revision_seq INTEGER NOT NULL DEFAULT 0
);

INSERT INTO turns_v5
  (id, bot_id, chat_id, source_update_id, status, attachment_paths_json,
   started_at, completed_at, worker_generation, first_output_at, last_output_at,
   error_text, source, agent_api_token_name, agent_api_source_label, final_text,
   idempotency_key, usage_json, duration_ms, agent_id, conversation_id,
   session_key, source_platform, source_event_id, prompt_text,
   prompt_markdown, prompt_revision_seq)
SELECT t.id, t.bot_id, t.chat_id, t.source_update_id, t.status,
       t.attachment_paths_json, t.started_at, t.completed_at,
       t.worker_generation, t.first_output_at, t.last_output_at, t.error_text,
       t.source, t.agent_api_token_name, t.agent_api_source_label, t.final_text,
       t.idempotency_key, t.usage_json, t.duration_ms, t.bot_id,
       ie.conversation_id, c.session_key,
       COALESCE(ie.platform, CASE WHEN t.source LIKE 'agent_api_%' THEN 'agent_api' ELSE 'telegram' END),
       ie.id,
       CASE WHEN json_valid(iu.payload_json) THEN
         COALESCE(json_extract(iu.payload_json, '$.message.text'),
                  json_extract(iu.payload_json, '$.message.caption'),
                  json_extract(iu.payload_json, '$.prompt'))
       END,
       0, COALESCE(ie.received_seq, 0)
FROM turns t
LEFT JOIN inbound_updates iu ON iu.id = t.source_update_id
LEFT JOIN inbound_events ie
  ON ie.endpoint_id = CASE WHEN iu.telegram_update_id < 0
      THEN iu.bot_id || '-agent-api' ELSE iu.bot_id || '-telegram' END
 AND ie.external_event_id = CASE WHEN iu.telegram_update_id < 0
      THEN 'agentapi:' || CAST(ABS(iu.telegram_update_id) AS TEXT)
      ELSE CAST(iu.telegram_update_id AS TEXT) END
LEFT JOIN conversations c ON c.id = ie.conversation_id;

CREATE TABLE outbox_v5 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id INTEGER REFERENCES turns(id),
  bot_id TEXT,
  chat_id INTEGER,
  kind TEXT,
  telegram_message_id INTEGER,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  agent_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  platform TEXT NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  operation_kind TEXT NOT NULL,
  external_message_id TEXT,
  signed_payload_json TEXT,
  signed_event_id TEXT
);

INSERT INTO outbox_v5
  (id, turn_id, bot_id, chat_id, kind, telegram_message_id, payload_json,
   status, attempt_count, next_attempt_at, last_error, created_at, agent_id,
   endpoint_id, platform, conversation_id, operation_kind,
   external_message_id)
SELECT o.id, o.turn_id, o.bot_id, o.chat_id, o.kind,
       o.telegram_message_id, o.payload_json, o.status, o.attempt_count,
       o.next_attempt_at, o.last_error, o.created_at, o.bot_id,
       o.bot_id || '-telegram', 'telegram',
       COALESCE(t.conversation_id, c.id), o.kind,
       CAST(o.telegram_message_id AS TEXT)
FROM outbox o
LEFT JOIN turns_v5 t ON t.id = o.turn_id
LEFT JOIN conversations c
  ON c.endpoint_id = o.bot_id || '-telegram'
 AND c.external_conversation_id = CAST(o.chat_id AS TEXT);

CREATE TABLE stream_state_v5 (
  turn_id INTEGER PRIMARY KEY REFERENCES turns(id),
  active_telegram_message_id INTEGER,
  active_external_message_id TEXT,
  buffer_text TEXT NOT NULL DEFAULT '',
  last_flushed_at TEXT,
  segment_index INTEGER NOT NULL DEFAULT 0
);

INSERT INTO stream_state_v5
SELECT turn_id, active_telegram_message_id,
       COALESCE(active_external_message_id, CAST(active_telegram_message_id AS TEXT)),
       buffer_text, last_flushed_at, segment_index
FROM stream_state;

DROP TABLE stream_state;
DROP TABLE outbox;
DROP TABLE turns;
ALTER TABLE turns_v5 RENAME TO turns;
ALTER TABLE outbox_v5 RENAME TO outbox;
ALTER TABLE stream_state_v5 RENAME TO stream_state;

DROP INDEX IF EXISTS idx_turns_bot_status;
DROP INDEX IF EXISTS idx_inbound_bot_status;
DROP INDEX IF EXISTS idx_inbound_bot_negid;
DROP INDEX IF EXISTS idx_turns_idempotency;

CREATE INDEX idx_turns_bot_status ON turns(bot_id, status);
CREATE INDEX idx_turns_agent_status ON turns(agent_id, status);
CREATE INDEX idx_turns_conv_status ON turns(conversation_id, status);
CREATE INDEX idx_outbox_status_next ON outbox(status, next_attempt_at);
CREATE INDEX idx_outbox_conversation ON outbox(conversation_id, status);
CREATE INDEX idx_inbound_endpoint_status ON inbound_events(endpoint_id, status);
CREATE INDEX idx_inbound_conv_seq ON inbound_events(conversation_id, received_seq);
CREATE UNIQUE INDEX idx_inbound_endpoint_seq ON inbound_events(endpoint_id, received_seq);
CREATE INDEX idx_pending_mutation_target ON pending_event_mutations(endpoint_id, target_external_event_id, received_seq);
CREATE INDEX idx_conversations_agent ON conversations(agent_id, last_inbound_at);
CREATE INDEX idx_sessions_state_used ON conversation_sessions(state, last_used_at);
CREATE INDEX idx_sessions_context_exp ON conversation_sessions(context_expires_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON agent_api_idempotency(created_at);
CREATE INDEX idx_turns_idempotency
  ON turns(agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

PRAGMA user_version = 5;
COMMIT;
PRAGMA foreign_keys = ON;
