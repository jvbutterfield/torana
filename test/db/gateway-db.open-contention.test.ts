// Regression: `applyMigrations` leaves a fresh database in `delete` journal
// mode, so the first GatewayDB open *changes* the mode to WAL — and a mode
// change needs exclusive access. When `busy_timeout` was set after that
// pragma, the switch ran with SQLite's default timeout of zero: any concurrent
// reader made the open fail outright with `database is locked` rather than
// wait. That is what intermittently failed `torana endpoints` on CI, three
// times, including twice inside a release run.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations } from "../../src/db/migrate.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function freshMigratedDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "torana-open-contention-"));
  dirs.push(dir);
  const dbPath = join(dir, "gateway.db");
  applyMigrations(dbPath);
  return dbPath;
}

test("a freshly migrated database is still in delete journal mode", () => {
  // The premise of this whole test file. If migrations ever start leaving WAL
  // behind, the open below stops being a mode *change* and this regression
  // can no longer occur — at which point this file should be revisited rather
  // than silently passing for the wrong reason.
  const dbPath = freshMigratedDb();
  const probe = new Database(dbPath);
  expect(probe.query("PRAGMA journal_mode").get()).toEqual({
    journal_mode: "delete",
  });
  probe.close();
});

test("opening under a concurrent read lock waits instead of failing", () => {
  const dbPath = freshMigratedDb();
  const reader = new Database(dbPath);
  reader.exec("BEGIN");
  reader.query("SELECT count(*) FROM sqlite_master").get();

  // Zero-timeout behaviour returned in about a millisecond. Honouring the
  // timeout means this call blocks for the full wait and then reports busy;
  // in production the holder releases first and the open succeeds.
  const started = Date.now();
  expect(() => new GatewayDB(dbPath)).toThrow(/database is locked/);
  const waited = Date.now() - started;
  reader.exec("COMMIT");
  reader.close();

  expect(waited).toBeGreaterThan(2000);
});

test("the open succeeds once the other holder releases", () => {
  const dbPath = freshMigratedDb();
  const reader = new Database(dbPath);
  reader.exec("BEGIN");
  reader.query("SELECT count(*) FROM sqlite_master").get();
  // Release well inside the busy_timeout window. Same shape as a second
  // torana process finishing its read while this one opens.
  reader.exec("COMMIT");
  reader.close();

  const db = new GatewayDB(dbPath);
  expect(db._unsafeQuery("PRAGMA journal_mode").get()).toEqual({
    journal_mode: "wal",
  });
  db.close();
});
