// US-030 — schema v8: provisioned agents, tombstone cursors, provisioning audit.
//
// The v7→v8 step is additive, so the interesting cases are not "does the table
// exist" but: does an *occupied* v7 database survive the upgrade with its rows
// intact, does the binary refuse a database from the future, and do the CHECK
// constraints actually hold the invariants the delete pipeline will depend on?

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMigrations,
  detectVersion,
  planMigration,
  TARGET_VERSION,
} from "../../src/db/migrate.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-v8-"));
  dbPath = join(tmpDir, "gateway.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A v8 database with the v8 tables dropped and user_version wound back to 7. */
function seedOccupiedV7(): void {
  applyMigrations(dbPath);
  const db = new Database(dbPath);
  db.exec(`
    DROP TABLE provisioned_agents;
    DROP TABLE buzz_tombstone_cursors;
    DROP TABLE provisioning_audit;
    PRAGMA user_version = 7;
  `);
  db.query(
    `INSERT INTO provisioned_endpoints
       (endpoint_id, agent_id, derived_pubkey, config_json,
        private_key_ciphertext, provisioned_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("cato-buzz", "cato", "pub-cato", "{}", "sealed", "provisioner");
  db.close();
}

describe("schema v8 migration", () => {
  test("TARGET_VERSION is 8", () => {
    expect(TARGET_VERSION).toBe(8);
  });

  test("fresh install lands at v8 with all three new tables", () => {
    applyMigrations(dbPath);
    const db = new Database(dbPath, { readonly: true });
    expect(detectVersion(db)).toBe(8);
    const tables = db
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN
           ('provisioned_agents','buzz_tombstone_cursors','provisioning_audit')
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "buzz_tombstone_cursors",
      "provisioned_agents",
      "provisioning_audit",
    ]);
    db.close();
  });

  test("v7 → v8 plans exactly the one additive step", () => {
    seedOccupiedV7();
    const plan = planMigration(dbPath);
    expect(plan.currentVersion).toBe(7);
    expect(plan.targetVersion).toBe(8);
    expect(plan.steps.map((step) => step.id)).toEqual([
      "0008_provisioned_agents",
    ]);
  });

  test("v7 → v8 preserves populated provisioned_endpoints rows", () => {
    seedOccupiedV7();
    applyMigrations(dbPath);
    const db = new Database(dbPath, { readonly: true });
    expect(detectVersion(db)).toBe(8);
    const row = db
      .query(
        "SELECT endpoint_id, agent_id, private_key_ciphertext FROM provisioned_endpoints",
      )
      .get() as {
      endpoint_id: string;
      agent_id: string;
      private_key_ciphertext: string;
    };
    // The sealed secret must survive verbatim: re-encrypting or dropping it
    // would orphan the identity the endpoint authenticates with.
    expect(row).toEqual({
      endpoint_id: "cato-buzz",
      agent_id: "cato",
      private_key_ciphertext: "sealed",
    });
    db.close();
  });

  test("re-running the migration is a no-op", () => {
    applyMigrations(dbPath);
    const again = applyMigrations(dbPath);
    expect(again.steps.filter((s) => s.id.startsWith("0008"))).toHaveLength(0);
    const db = new Database(dbPath, { readonly: true });
    expect(detectVersion(db)).toBe(8);
    db.close();
  });

  test("refuses a database newer than this binary", () => {
    applyMigrations(dbPath);
    const db = new Database(dbPath);
    db.exec("PRAGMA user_version = 9");
    db.close();
    expect(() => planMigration(dbPath)).toThrow(
      /unsupported schema version: 9/,
    );
  });
});

describe("provisioned_agents invariants", () => {
  function open(): Database {
    applyMigrations(dbPath);
    return new Database(dbPath);
  }

  function insert(db: Database, overrides: Record<string, unknown> = {}): void {
    const row = {
      agent_id: "canary",
      derived_pubkey: "pub-canary",
      harness: "claude",
      system_prompt: "",
      model: null,
      timeouts_json: "{}",
      instruction_version: "abc123def456",
      lifecycle: "active",
      staged_at: null,
      purge_deadline: null,
      provisioned_by: "provisioner",
      ...overrides,
    };
    db.query(
      `INSERT INTO provisioned_agents
         (agent_id, derived_pubkey, harness, system_prompt, model,
          timeouts_json, instruction_version, lifecycle, staged_at,
          purge_deadline, provisioned_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.agent_id as string,
      row.derived_pubkey as string,
      row.harness as string,
      row.system_prompt as string,
      row.model as string | null,
      row.timeouts_json as string,
      row.instruction_version as string,
      row.lifecycle as string,
      row.staged_at as string | null,
      row.purge_deadline as string | null,
      row.provisioned_by as string,
    );
  }

  test("accepts an active agent with no staging fields", () => {
    const db = open();
    expect(() => insert(db)).not.toThrow();
    db.close();
  });

  test("accepts a staged agent carrying both staging fields", () => {
    const db = open();
    expect(() =>
      insert(db, {
        lifecycle: "staged_delete",
        staged_at: "2026-08-08T00:00:00Z",
        purge_deadline: "2026-08-11T00:00:00Z",
      }),
    ).not.toThrow();
    db.close();
  });

  test("rejects a staged agent with no purge deadline", () => {
    // The row the purge sweep would skip forever — staged, but invisible to
    // the deadline query, so it never purges and never returns to active.
    const db = open();
    expect(() =>
      insert(db, {
        lifecycle: "staged_delete",
        staged_at: "2026-08-08T00:00:00Z",
      }),
    ).toThrow();
    db.close();
  });

  test("rejects an active agent that still carries a purge deadline", () => {
    // The mirror failure: a restore that cleared lifecycle but left the
    // deadline behind would purge a live agent at the old deadline.
    const db = open();
    expect(() =>
      insert(db, { purge_deadline: "2026-08-11T00:00:00Z" }),
    ).toThrow();
    db.close();
  });

  test("rejects an unknown lifecycle value", () => {
    const db = open();
    expect(() => insert(db, { lifecycle: "deleted" })).toThrow();
    db.close();
  });

  test("rejects a second agent bound to the same pubkey", () => {
    // One identity backs at most one agent (I4, extended to definitions).
    const db = open();
    insert(db);
    expect(() => insert(db, { agent_id: "other" })).toThrow();
    db.close();
  });

  test("rejects a duplicate agent id", () => {
    const db = open();
    insert(db);
    expect(() => insert(db, { derived_pubkey: "pub-other" })).toThrow();
    db.close();
  });
});

describe("provisioning audit and tombstone cursors", () => {
  test("audit rows survive deletion of the agent they describe", () => {
    // The purge record must outlive its agent — a purge log deleted with the
    // agent proves nothing (R12.5). Asserted by the absence of a cascade.
    applyMigrations(dbPath);
    const db = new Database(dbPath);
    db.query(
      `INSERT INTO provisioned_agents
         (agent_id, derived_pubkey, harness, timeouts_json,
          instruction_version, provisioned_by)
       VALUES ('doomed', 'pub-doomed', 'claude', '{}', 'v1', 'provisioner')`,
    ).run();
    db.query(
      `INSERT INTO provisioning_audit (agent_id, signal, actor, outcome, detail)
       VALUES ('doomed', 'purge', 'operator-cli', 'ok', '{"bytes":1}')`,
    ).run();
    db.query("DELETE FROM provisioned_agents WHERE agent_id = 'doomed'").run();
    const remaining = db
      .query("SELECT signal FROM provisioning_audit WHERE agent_id = 'doomed'")
      .all() as Array<{ signal: string }>;
    expect(remaining).toEqual([{ signal: "purge" }]);
    db.close();
  });

  test("a relay may hold only one cursor", () => {
    applyMigrations(dbPath);
    const db = new Database(dbPath);
    const insert = db.query(
      "INSERT INTO buzz_tombstone_cursors (relay_url, last_created_at) VALUES (?, ?)",
    );
    insert.run("wss://relay.example", 1000);
    expect(() => insert.run("wss://relay.example", 2000)).toThrow();
    db.close();
  });
});
