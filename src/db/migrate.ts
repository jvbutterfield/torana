// DB schema migration dispatcher. Uses SQLite's PRAGMA user_version.
//
// States this dispatcher handles:
//   - Fresh install: DB doesn't exist or has no tables. Apply schema.sql, set user_version=1.
//   - v0 upgrade: DB has inbound_updates with a `persona` column. Apply 0001 migration.
//   - v1 current: user_version=1 — no-op.
//
// Migration is idempotent: running twice is a no-op. Failure rolls back the
// transaction; next run re-applies from scratch.

import { Database } from "bun:sqlite";
import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../log.js";

const log = logger("migrate");

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface MigrationStep {
  id: string;
  description: string;
  sql: string;
}

export interface MigrationPlan {
  /** Current schema version detected (0 = v0 agent-team, 1 = v1, null = empty DB). */
  currentVersion: number | null;
  /** Target schema version this binary ships. */
  targetVersion: number;
  /** Steps that would run, in order. Empty when already current. */
  steps: MigrationStep[];
  /** Path the snapshot was written to, if a pre-migration snapshot was taken. */
  snapshotPath?: string;
}

// __dirname varies by how the code is running:
//   - source: src/db/  → sibling schema.sql and migrations/
//   - bundled (npm-published): dist/  → scripts/build.ts copies SQL to dist/db/
function sqlCandidates(relative: string): string[] {
  return [resolve(__dirname, relative), resolve(__dirname, "db", relative)];
}

function readSchemaSql(): string {
  const candidates = sqlCandidates("schema.sql");
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(`schema.sql not found; tried: ${candidates.join(", ")}`);
}

function readMigrationSql(name: string): string {
  const candidates = sqlCandidates(`migrations/${name}`);
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(`${name} not found; tried: ${candidates.join(", ")}`);
}

/** Detect the schema version. Returns null for an empty DB (no tables). */
export function detectVersion(db: Database): number | null {
  const userVersion = (db.query("PRAGMA user_version").get() as { user_version: number })
    .user_version;

  if (userVersion >= 1) return userVersion;

  // user_version == 0: could be fresh, v0 with persona columns, or v1 with missing pragma.
  const table = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='inbound_updates'")
    .get();
  if (!table) return null;

  // Table exists — inspect columns.
  const cols = db.query("PRAGMA table_info(inbound_updates)").all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  if (names.includes("bot_id")) return 1;
  if (names.includes("persona")) return 0;
  throw new Error(`unknown schema: inbound_updates has neither bot_id nor persona column`);
}

export function planMigration(dbPath: string): MigrationPlan {
  const dbExists = existsSync(dbPath);
  if (!dbExists) {
    return {
      currentVersion: null,
      targetVersion: 1,
      steps: [
        {
          id: "fresh-install",
          description: "Apply v1 schema.sql and set user_version=1",
          sql: readSchemaSql() + "\nPRAGMA user_version = 1;",
        },
      ],
    };
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const version = detectVersion(db);
    if (version === null) {
      return {
        currentVersion: null,
        targetVersion: 1,
        steps: [
          {
            id: "fresh-install",
            description: "Empty DB — apply v1 schema.sql and set user_version=1",
            sql: readSchemaSql() + "\nPRAGMA user_version = 1;",
          },
        ],
      };
    }
    if (version === 1) {
      return { currentVersion: 1, targetVersion: 1, steps: [] };
    }
    if (version === 0) {
      return {
        currentVersion: 0,
        targetVersion: 1,
        steps: [
          {
            id: "0001_persona_to_bot_id",
            description: "Rename persona → bot_id, remap inbound_updates.status, rebuild indexes",
            sql: readMigrationSql("0001_persona_to_bot_id.sql"),
          },
        ],
      };
    }
    throw new Error(`unsupported schema version: ${version} (this binary knows up to 1)`);
  } finally {
    db.close();
  }
}

export interface ApplyOptions {
  /** When true, take a snapshot at dbPath+".pre-v<current+1>" before the v0→v1 migration. */
  snapshotV0Upgrade?: boolean;
}

/** Apply all pending migrations. Returns the plan that was executed. */
export function applyMigrations(dbPath: string, opts: ApplyOptions = {}): MigrationPlan {
  const plan = planMigration(dbPath);
  if (plan.steps.length === 0) {
    log.info("schema already current", { version: plan.currentVersion });
    return plan;
  }

  // Snapshot v0 before touching it — this must happen before WAL sidecars appear.
  if (plan.currentVersion === 0 && opts.snapshotV0Upgrade) {
    const snapshotPath = `${dbPath}.pre-v1`;
    if (!existsSync(snapshotPath)) {
      copyFileSync(dbPath, snapshotPath);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(dbPath + suffix)) {
          copyFileSync(dbPath + suffix, snapshotPath + suffix);
        }
      }
      log.info("pre-migration snapshot written", { from: dbPath, to: snapshotPath });
      plan.snapshotPath = snapshotPath;
    } else {
      log.info("pre-migration snapshot already exists — skipping", { path: snapshotPath });
      plan.snapshotPath = snapshotPath;
    }
  }

  const db = new Database(dbPath, { create: true });
  try {
    for (const step of plan.steps) {
      log.info("applying migration", { id: step.id, description: step.description });
      db.exec(step.sql);
    }
    log.info("migrations complete", {
      from: plan.currentVersion,
      to: plan.targetVersion,
      steps: plan.steps.length,
    });
  } finally {
    db.close();
  }
  return plan;
}
