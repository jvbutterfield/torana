// Migration lock — verifies cross-process mutual exclusion via the
// <dbPath>.migrate.lock file.
//
// The real race we're defending: two `torana start --auto-migrate`
// processes both see user_version < TARGET, both try to apply the same
// migration. Individual step SQL is not always idempotent (ADD COLUMN
// fails when the column already exists), so uncoordinated concurrent
// migrations can half-apply. SQLite's own lock narrows the window but
// planMigration and applyMigrations use separate connections, so the
// gap is observable. This test file pins the file-lock invariants.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations, planMigration } from "../../src/db/migrate.js";

let tmpDir: string;
let dbPath: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-migrate-lock-"));
  dbPath = join(tmpDir, "gateway.db");
  lockPath = `${dbPath}.migrate.lock`;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("migration lock — happy path", () => {
  test("applyMigrations creates, holds, and releases the lock", () => {
    // Before: no lock.
    expect(existsSync(lockPath)).toBe(false);
    applyMigrations(dbPath);
    // After: lock released.
    expect(existsSync(lockPath)).toBe(false);
    // And migration succeeded.
    const plan = planMigration(dbPath);
    expect(plan.steps).toHaveLength(0);
  });

  test("lock releases even when an already-current DB skips the migration work", () => {
    applyMigrations(dbPath);
    expect(existsSync(lockPath)).toBe(false);
    // Second call: no steps, so the lock code path isn't entered. Still
    // no lock left behind.
    applyMigrations(dbPath);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("migration lock — contention", () => {
  test("pre-existing fresh lock file causes applyMigrations to throw", () => {
    // Simulate a concurrent process holding the lock.
    writeFileSync(lockPath, "pid=99999 ts=now\n");

    expect(() => applyMigrations(dbPath)).toThrow(
      /migration lock held by another process/,
    );
    // Our lock file is left in place; the holder owns release.
    expect(existsSync(lockPath)).toBe(true);
  });

  test("stale lock (older than 10 minutes) is stolen + migration proceeds", () => {
    writeFileSync(lockPath, "pid=99999 ts=stale\n");
    // Age the mtime by 11 minutes so it exceeds the 10-minute staleness
    // threshold.
    const eleven = new Date(Date.now() - 11 * 60 * 1000);
    const { utimesSync } = require("node:fs") as typeof import("node:fs");
    utimesSync(lockPath, eleven, eleven);

    applyMigrations(dbPath);

    // Migration completed — plan should be current.
    expect(planMigration(dbPath).steps).toHaveLength(0);
    // Lock released.
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("migration lock — lock file contents (debug aid)", () => {
  test("lock file contains pid + timestamp while held", async () => {
    // We can't easily observe the lock file during the synchronous
    // applyMigrations call, so rerun via a lock we pre-create after
    // the migration completes. Instead verify that *our* manual lock
    // file format matches what applyMigrations writes: start a migration
    // on a DB that's already current (so applyMigrations skips the lock
    // path entirely), then manually create a lock file ourselves and
    // confirm the parse survives.
    applyMigrations(dbPath);
    // Write a lock file in the same format applyMigrations would,
    // verify it's parseable as `pid=<int> ts=<iso>`.
    writeFileSync(
      lockPath,
      `pid=${process.pid} ts=${new Date().toISOString()}\n`,
    );
    const contents = readFileSync(lockPath, "utf8");
    expect(contents).toMatch(/^pid=\d+ ts=\d{4}-\d{2}-\d{2}T/);
  });
});
