PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

CREATE TABLE publisher_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publisher_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  outbox_id INTEGER NOT NULL REFERENCES outbox(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (publisher_id, idempotency_key)
);

CREATE INDEX idx_publisher_publications_created
  ON publisher_publications(created_at);

PRAGMA user_version = 6;
COMMIT;
