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

  test("fresh install creates current-version tables + matching user_version", () => {
    const dbPath = join(tmpDir, "fresh.db");
    const plan = applyMigrations(dbPath);
    expect(plan.currentVersion).toBe(null);
    expect(plan.targetVersion).toBe(3);

    const db = new Database(dbPath);
    const user = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(user).toBe(3);

    // inbound_updates has bot_id, not persona
    const cols = db.query("PRAGMA table_info(inbound_updates)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("bot_id");
    expect(cols.map((c) => c.name)).not.toContain("persona");

    // agent_api tables created for fresh installs
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("user_chats");
    expect(names).toContain("agent_api_idempotency");
    expect(names).toContain("side_sessions");

    // turns gains agent_api columns
    const turnsCols = (db.query("PRAGMA table_info(turns)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(turnsCols).toContain("source");
    expect(turnsCols).toContain("agent_api_token_name");
    expect(turnsCols).toContain("final_text");
    expect(turnsCols).toContain("idempotency_key");
    expect(turnsCols).toContain("usage_json");
    expect(turnsCols).toContain("duration_ms");

    // worker_state gains codex_thread_id (from 0003).
    const workerCols = (
      db.query("PRAGMA table_info(worker_state)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(workerCols).toContain("codex_thread_id");
    db.close();
  });

  test("v0 → v3 renames column + applies 0001/0002/0003", () => {
    const dbPath = join(tmpDir, "v0-upgrade.db");
    seedV0Schema(dbPath);

    const plan = applyMigrations(dbPath);
    expect(plan.currentVersion).toBe(0);
    expect(plan.targetVersion).toBe(3);
    expect(plan.steps.map((s) => s.id)).toEqual([
      "0001_persona_to_bot_id",
      "0002_agent_api",
      "0003_runner_session_resume",
    ]);

    const db = new Database(dbPath);
    const user = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(user).toBe(3);

    // status remap (from 0001)
    const rows = db
      .query(
        "SELECT telegram_update_id, status FROM inbound_updates ORDER BY telegram_update_id",
      )
      .all() as Array<{ telegram_update_id: number; status: string }>;
    expect(rows.map((r) => r.status)).toEqual([
      "enqueued",
      "processed",
      "processed",
      "received",
    ]);

    // bot_id preserved
    const one = db
      .query("SELECT bot_id FROM inbound_updates WHERE telegram_update_id = 100")
      .get() as { bot_id: string };
    expect(one.bot_id).toBe("cato");

    // bot_state exists (from 0001)
    const tbl = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='bot_state'")
      .get();
    expect(tbl).not.toBeNull();

    // agent_api tables exist (from 0002)
    const aa = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_chats'")
      .get();
    expect(aa).not.toBeNull();

    // idempotent
    const plan2 = planMigration(dbPath);
    expect(plan2.steps.length).toBe(0);

    db.close();
  });

  test("migrate is a no-op on a current DB", () => {
    const dbPath = join(tmpDir, "v3.db");
    applyMigrations(dbPath);
    const plan = planMigration(dbPath);
    expect(plan.steps.length).toBe(0);
  });

  test("v1 → v3 applies 0002 + 0003", () => {
    const dbPath = join(tmpDir, "v1-upgrade.db");
    // Build a v1 DB by running the 0001 migration on a v0 DB, then
    // resetting user_version to 1 (simulating a v1-shipped install).
    seedV0Schema(dbPath);
    // Apply 0001 manually.
    const db = new Database(dbPath);
    const sqlPath = join(__dirname, "..", "..", "src", "db", "migrations", "0001_persona_to_bot_id.sql");
    const sql = require("node:fs").readFileSync(sqlPath, "utf8");
    db.exec(sql);
    db.exec("PRAGMA user_version = 1");
    db.close();

    const plan = planMigration(dbPath);
    expect(plan.currentVersion).toBe(1);
    expect(plan.targetVersion).toBe(3);
    expect(plan.steps.map((s) => s.id)).toEqual([
      "0002_agent_api",
      "0003_runner_session_resume",
    ]);

    applyMigrations(dbPath);

    const db2 = new Database(dbPath);
    const user = (db2.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(user).toBe(3);
    db2.close();
  });

  test("v2 → v3 applies 0003 only", () => {
    const dbPath = join(tmpDir, "v2-upgrade.db");
    // Build a v2 DB by running 0001 + 0002 manually.
    seedV0Schema(dbPath);
    const db = new Database(dbPath);
    const fs = require("node:fs");
    db.exec(
      fs.readFileSync(
        join(__dirname, "..", "..", "src", "db", "migrations", "0001_persona_to_bot_id.sql"),
        "utf8",
      ),
    );
    db.exec(
      fs.readFileSync(
        join(__dirname, "..", "..", "src", "db", "migrations", "0002_agent_api.sql"),
        "utf8",
      ),
    );
    db.close();

    const plan = planMigration(dbPath);
    expect(plan.currentVersion).toBe(2);
    expect(plan.targetVersion).toBe(3);
    expect(plan.steps.map((s) => s.id)).toEqual(["0003_runner_session_resume"]);

    applyMigrations(dbPath);

    const db2 = new Database(dbPath);
    const user = (db2.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(user).toBe(3);
    const cols = (db2.query("PRAGMA table_info(worker_state)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("codex_thread_id");
    db2.close();
  });
});
