// DB file permissions — every DB file we open gets locked down to 0600.
// The DB contains bot tokens + inbound Telegram payloads + agent-API turn
// rows; leaving it group- or world-readable exposes live credentials and
// message history to any other user on the host.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations } from "../../src/db/migrate.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-dbperm-"));
  dbPath = join(tmpDir, "gateway.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function mode(p: string): number {
  return statSync(p).mode & 0o777;
}

describe("db permissions", () => {
  test.skipIf(process.platform === "win32")(
    "applyMigrations chmods the db file to 0600",
    () => {
      applyMigrations(dbPath);
      expect(mode(dbPath)).toBe(0o600);
    },
  );

  test.skipIf(process.platform === "win32")(
    "GatewayDB constructor chmods the db + WAL sidecars to 0600",
    () => {
      applyMigrations(dbPath);
      // Deliberately loosen the perms to simulate an old deployment that
      // was created before this release.
      chmodSync(dbPath, 0o644);
      if (existsSync(dbPath + "-wal")) chmodSync(dbPath + "-wal", 0o644);

      // Opening a GatewayDB should re-tighten them.
      const db = new GatewayDB(dbPath);
      try {
        // Run a simple write to force the WAL to materialise.
        db.exec("CREATE TABLE IF NOT EXISTS t (a INT); INSERT INTO t VALUES(1)");
        expect(mode(dbPath)).toBe(0o600);
        // WAL may or may not exist depending on SQLite's checkpoint
        // cadence — only assert it's 0600 when it does exist.
        if (existsSync(dbPath + "-wal")) expect(mode(dbPath + "-wal")).toBe(0o600);
        if (existsSync(dbPath + "-shm")) expect(mode(dbPath + "-shm")).toBe(0o600);
      } finally {
        db.close();
      }
    },
  );
});
