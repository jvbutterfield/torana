PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

ALTER TABLE inbound_updates ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE turns ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE outbox ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE worker_state ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE bot_state ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE user_chats ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_api_idempotency ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE side_sessions ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE stream_state ADD COLUMN active_external_message_id TEXT;

UPDATE inbound_updates SET agent_id = bot_id;
UPDATE turns SET agent_id = bot_id;
UPDATE outbox SET agent_id = bot_id;
UPDATE worker_state SET agent_id = bot_id;
UPDATE bot_state SET agent_id = bot_id;
UPDATE user_chats SET agent_id = bot_id;
UPDATE agent_api_idempotency SET agent_id = bot_id;
UPDATE side_sessions SET agent_id = bot_id;
-- Side-session rows describe live processes and are never resumable state.
-- The bridge starts them stopped/empty rather than pretending to restore PIDs.
DELETE FROM side_sessions;
UPDATE stream_state
SET active_external_message_id = CAST(active_telegram_message_id AS TEXT)
WHERE active_telegram_message_id IS NOT NULL;

CREATE TABLE endpoints (
  endpoint_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_identity TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  state_reason TEXT,
  cursor_json TEXT,
  next_received_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE conversation_sessions (
  session_key TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  runner_session_id TEXT NOT NULL UNIQUE,
  runner_type TEXT NOT NULL,
  provider_state_json TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  started_at TEXT,
  last_used_at TEXT,
  hard_expires_at TEXT,
  context_expires_at TEXT,
  last_error TEXT
);

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  platform TEXT NOT NULL,
  community_id TEXT,
  external_conversation_id TEXT NOT NULL,
  thread_root_id TEXT NOT NULL DEFAULT '',
  workflow_run_id TEXT NOT NULL DEFAULT '',
  conversation_type TEXT NOT NULL,
  conversation_key TEXT NOT NULL UNIQUE,
  session_policy TEXT NOT NULL,
  session_key TEXT REFERENCES conversation_sessions(session_key),
  archived INTEGER NOT NULL DEFAULT 0,
  last_sender_id TEXT,
  last_inbound_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((session_policy = 'ephemeral' AND session_key IS NULL) OR
         (session_policy <> 'ephemeral' AND session_key IS NOT NULL)),
  UNIQUE(endpoint_id, external_conversation_id, thread_root_id, workflow_run_id)
);

CREATE TABLE inbound_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  platform TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  external_message_id TEXT,
  target_external_event_id TEXT,
  workflow_run_id TEXT,
  conversation_id INTEGER REFERENCES conversations(id),
  sender_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  reply_to_external_id TEXT,
  payload_json TEXT,
  payload_sha256 TEXT NOT NULL,
  received_seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  status_reason TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(endpoint_id, external_event_id)
);

CREATE TABLE pending_event_mutations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL,
  target_external_event_id TEXT NOT NULL,
  mutation_event_id INTEGER NOT NULL REFERENCES inbound_events(id),
  mutation_kind TEXT NOT NULL,
  received_seq INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(endpoint_id, mutation_event_id)
);

CREATE TABLE user_conversations (
  agent_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'telegram',
  external_user_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  last_inbound_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, platform, external_user_id)
);

INSERT OR IGNORE INTO conversation_sessions
  (session_key, agent_id, runner_session_id, runner_type, state)
SELECT 'legacy:' || agent_id, agent_id, 'legacy-' || agent_id, 'legacy', 'stopped'
FROM (
  SELECT bot_id AS agent_id FROM inbound_updates
  UNION SELECT bot_id FROM turns
  UNION SELECT bot_id FROM worker_state
  UNION SELECT bot_id FROM bot_state
  UNION SELECT bot_id FROM user_chats
  UNION SELECT bot_id FROM agent_api_idempotency
  UNION SELECT bot_id FROM side_sessions
);

INSERT OR IGNORE INTO endpoints (endpoint_id, agent_id, platform, lifecycle_state)
SELECT agent_id || '-telegram', agent_id, 'telegram', 'active'
FROM conversation_sessions;

INSERT OR IGNORE INTO endpoints (endpoint_id, agent_id, platform, lifecycle_state)
SELECT agent_id || '-agent-api', agent_id, 'agent_api', 'active'
FROM conversation_sessions;

UPDATE endpoints
SET cursor_json = (
  SELECT json_object('kind', 'telegram_offset', 'last_update_id', last_update_id)
  FROM bot_state
  WHERE bot_state.bot_id = endpoints.agent_id
)
WHERE platform = 'telegram';

UPDATE endpoints
SET lifecycle_state = COALESCE((
      SELECT CASE WHEN disabled = 1 THEN 'disabled' ELSE 'active' END
      FROM bot_state WHERE bot_state.bot_id = endpoints.agent_id
    ), lifecycle_state),
    state_reason = (
      SELECT disabled_reason FROM bot_state
      WHERE bot_state.bot_id = endpoints.agent_id
    )
WHERE platform = 'telegram';

INSERT OR IGNORE INTO conversations
  (agent_id, endpoint_id, platform, external_conversation_id,
   conversation_type, conversation_key, session_policy, session_key,
   last_sender_id, last_inbound_at)
SELECT bot_id, bot_id || '-telegram', 'telegram', CAST(chat_id AS TEXT),
       'direct', 'telegram:' || bot_id || '-telegram:' || CAST(chat_id AS TEXT),
       'legacy_agent', 'legacy:' || bot_id,
       MAX(from_user_id), MAX(received_at)
FROM inbound_updates
WHERE telegram_update_id > 0
GROUP BY bot_id, chat_id;

INSERT OR IGNORE INTO conversations
  (agent_id, endpoint_id, platform, external_conversation_id,
   conversation_type, conversation_key, session_policy, session_key,
   last_sender_id, last_inbound_at)
SELECT bot_id, bot_id || '-agent-api', 'agent_api',
       CASE WHEN chat_id = 0 THEN 'legacy' ELSE 'chat:' || CAST(chat_id AS TEXT) END,
       'api', 'agent_api:' || bot_id || ':' ||
         CASE WHEN chat_id = 0 THEN 'legacy' ELSE 'chat:' || CAST(chat_id AS TEXT) END,
       'legacy_agent', 'legacy:' || bot_id,
       MAX(from_user_id), MAX(received_at)
FROM inbound_updates
WHERE telegram_update_id < 0
GROUP BY bot_id, chat_id;

INSERT OR IGNORE INTO inbound_events
  (endpoint_id, platform, external_event_id, external_message_id,
   conversation_id, sender_id, event_kind, payload_json, payload_sha256,
   received_seq, status, received_at)
SELECT endpoint_id, platform, external_event_id, external_message_id,
       conversation_id, from_user_id, 'message', payload_json,
       '',
       ROW_NUMBER() OVER (PARTITION BY endpoint_id ORDER BY legacy_id),
       status, received_at
FROM (
  SELECT iu.id AS legacy_id,
         CASE WHEN iu.telegram_update_id < 0
           THEN iu.bot_id || '-agent-api'
           ELSE iu.bot_id || '-telegram' END AS endpoint_id,
         CASE WHEN iu.telegram_update_id < 0 THEN 'agent_api' ELSE 'telegram' END AS platform,
         CASE WHEN iu.telegram_update_id < 0
           THEN 'agentapi:' || CAST(ABS(iu.telegram_update_id) AS TEXT)
           ELSE CAST(iu.telegram_update_id AS TEXT) END AS external_event_id,
         CASE WHEN iu.telegram_update_id < 0 THEN NULL ELSE CAST(iu.message_id AS TEXT) END AS external_message_id,
         c.id AS conversation_id, iu.from_user_id, iu.payload_json, iu.status, iu.received_at
  FROM inbound_updates iu
  JOIN conversations c
    ON c.endpoint_id = CASE WHEN iu.telegram_update_id < 0
      THEN iu.bot_id || '-agent-api' ELSE iu.bot_id || '-telegram' END
   AND c.external_conversation_id = CASE WHEN iu.telegram_update_id < 0
      THEN CASE WHEN iu.chat_id = 0 THEN 'legacy' ELSE 'chat:' || CAST(iu.chat_id AS TEXT) END
      ELSE CAST(iu.chat_id AS TEXT) END
);

UPDATE endpoints
SET next_received_seq = COALESCE((
  SELECT MAX(received_seq) FROM inbound_events
  WHERE inbound_events.endpoint_id = endpoints.endpoint_id
), 0);

INSERT OR REPLACE INTO user_conversations
  (agent_id, platform, external_user_id, conversation_id, last_inbound_at)
SELECT uc.bot_id, 'telegram', uc.telegram_user_id, c.id, uc.last_inbound_at
FROM user_chats uc
JOIN conversations c
  ON c.endpoint_id = uc.bot_id || '-telegram'
 AND c.external_conversation_id = CAST(uc.chat_id AS TEXT);

PRAGMA user_version = 4;
COMMIT;
PRAGMA foreign_keys = ON;
