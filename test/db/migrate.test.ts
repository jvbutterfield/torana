import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, detectVersion, planMigration } from "../../src/db/migrate.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-migrate-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedV0Schema(dbPath: string): void {
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE inbound_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona TEXT NOT NULL,
      telegram_update_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      from_user_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'received',
      UNIQUE(persona, telegram_update_id)
    );
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      source_update_id INTEGER NOT NULL REFERENCES inbound_updates(id),
      status TEXT NOT NULL DEFAULT 'queued',
      attachment_paths_json TEXT,
      started_at TEXT,
      completed_at TEXT,
      worker_generation INTEGER,
      first_output_at TEXT,
      last_output_at TEXT,
      error_text TEXT
    );
    CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id INTEGER NOT NULL REFERENCES turns(id),
      persona TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      telegram_message_id INTEGER,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE worker_state (
      persona TEXT PRIMARY KEY,
      pid INTEGER,
      generation INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'starting',
      started_at TEXT,
      last_event_at TEXT,
      last_ready_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE TABLE stream_state (
      turn_id INTEGER PRIMARY KEY REFERENCES turns(id),
      active_telegram_message_id INTEGER,
      buffer_text TEXT NOT NULL DEFAULT '',
      last_flushed_at TEXT,
      segment_index INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_turns_persona_status ON turns(persona, status);
    CREATE INDEX idx_outbox_status_next ON outbox(status, next_attempt_at);
    CREATE INDEX idx_inbound_persona_status ON inbound_updates(persona, status);
    INSERT INTO inbound_updates (persona, telegram_update_id, chat_id, message_id, from_user_id, payload_json, status)
      VALUES ('cato', 100, 111, 1, '42', '{}', 'queued');
    INSERT INTO inbound_updates (persona, telegram_update_id, chat_id, message_id, from_user_id, payload_json, status)
      VALUES ('cato', 101, 111, 2, '42', '{}', 'completed');
    INSERT INTO inbound_updates (persona, telegram_update_id, chat_id, message_id, from_user_id, payload_json, status)
      VALUES ('cato', 102, 111, 3, '42', '{}', 'failed');
    INSERT INTO inbound_updates (persona, telegram_update_id, chat_id, message_id, from_user_id, payload_json, status)
      VALUES ('cato', 103, 111, 4, '42', '{}', 'received');
    INSERT INTO turns (persona, chat_id, source_update_id, status) VALUES ('cato', 111, 1, 'queued');
  `);
  db.close();
}

describe("db/migrate", () => {
  test("detectVersion: empty DB is null", () => {
    const dbPath = join(tmpDir, "empty.db");
    const db = new Database(dbPath, { create: true });
    expect(detectVersion(db)).toBe(null);
    db.close();
  });

  test("detectVersion: v0 schema → 0", () => {
    const dbPath = join(tmpDir, "v0.db");
    seedV0Schema(dbPath);
    const db = new Database(dbPath);
    expect(detectVersion(db)).toBe(0);
    db.close();
  });

  test("fresh install creates v1 tables + user_version=1", () => {
    const dbPath = join(tmpDir, "fresh.db");
    const plan = applyMigrations(dbPath);
    expect(plan.currentVersion).toBe(null);
    expect(plan.targetVersion).toBe(1);

    const db = new Database(dbPath);
    const user = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(user).toBe(1);

    // inbound_updates has bot_id, not persona
    const cols = db.query("PRAGMA table_info(inbound_updates)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("bot_id");
    expect(cols.map((c) => c.name)).not.toContain("persona");
    db.close();
  });

  test("v0 → v1 renames column + remaps status values", () => {
    const dbPath = join(tmpDir, "v0-upgrade.db");
    seedV0Schema(dbPath);

    const plan = applyMigrations(dbPath);
    expect(plan.currentVersion).toBe(0);
    expect(plan.targetVersion).toBe(1);

    const db = new Database(dbPath);
    const user = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(user).toBe(1);

    // status remap
    const rows = db.query("SELECT telegram_update_id, status FROM inbound_updates ORDER BY telegram_update_id").all() as Array<{
      telegram_update_id: number;
      status: string;
    }>;
    expect(rows.map((r) => r.status)).toEqual(["enqueued", "processed", "processed", "received"]);

    // bot_id preserved
    const one = db.query("SELECT bot_id FROM inbound_updates WHERE telegram_update_id = 100").get() as { bot_id: string };
    expect(one.bot_id).toBe("cato");

    // bot_state exists
    const tbl = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='bot_state'").get();
    expect(tbl).not.toBeNull();

    // idempotent
    const plan2 = planMigration(dbPath);
    expect(plan2.steps.length).toBe(0);

    db.close();
  });

  test("migrate is a no-op on a current v1 DB", () => {
    const dbPath = join(tmpDir, "v1.db");
    applyMigrations(dbPath);
    const plan = planMigration(dbPath);
    expect(plan.steps.length).toBe(0);
  });
});
