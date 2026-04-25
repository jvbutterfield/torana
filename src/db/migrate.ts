// DB schema migration dispatcher. Uses SQLite's PRAGMA user_version.
//
// States this dispatcher handles:
//   - Fresh install: DB doesn't exist or has no tables. Apply schema.sql, set user_version=TARGET.
//   - v0 upgrade: DB has inbound_updates with a `persona` column. Apply 0001 + 0002 + 0003.
//   - v1 upgrade: DB has bot_id but no agent_api tables. Apply 0002 + 0003.
//   - v2 upgrade: DB has agent_api tables but no codex_thread_id column. Apply 0003.
//   - v3 current: user_version=3 — no-op.
//
// Migration is idempotent: running twice is a no-op. Failure rolls back the
// transaction; next run re-applies from scratch.

import { Database } from "bun:sqlite";
import {
  readFileSync,
  existsSync,
  copyFileSync,
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
  statSync,
  chmodSync,
} from "node:fs";
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
  const userVersion = (
    db.query("PRAGMA user_version").get() as { user_version: number }
  ).user_version;

  if (userVersion >= 1) return userVersion;

  // user_version == 0: could be fresh, v0 with persona columns, or v1 with missing pragma.
  const table = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='inbound_updates'",
    )
    .get();
  if (!table) return null;

  // Table exists — inspect columns.
  const cols = db.query("PRAGMA table_info(inbound_updates)").all() as Array<{
    name: string;
  }>;
  const names = cols.map((c) => c.name);
  if (names.includes("bot_id")) return 1;
  if (names.includes("persona")) return 0;
  throw new Error(
    `unknown schema: inbound_updates has neither bot_id nor persona column`,
  );
}

const TARGET_VERSION = 3;

const STEP_0001: MigrationStep = {
  id: "0001_persona_to_bot_id",
  description:
    "Rename persona → bot_id, remap inbound_updates.status, rebuild indexes",
  // sql is resolved lazily because the migrations/ dir may not ship in some
  // builds; readMigrationSql throws a descriptive error if missing.
  get sql(): string {
    return readMigrationSql("0001_persona_to_bot_id.sql");
  },
} as unknown as MigrationStep;

const STEP_0002: MigrationStep = {
  id: "0002_agent_api",
  description: "Add agent_api tables + turns columns",
  get sql(): string {
    return readMigrationSql("0002_agent_api.sql");
  },
} as unknown as MigrationStep;

const STEP_0003: MigrationStep = {
  id: "0003_runner_session_resume",
  description:
    "Add worker_state.codex_thread_id for cross-restart Codex resume",
  get sql(): string {
    return readMigrationSql("0003_runner_session_resume.sql");
  },
} as unknown as MigrationStep;

function freshInstallStep(): MigrationStep {
  return {
    id: "fresh-install",
    description: `Apply v${TARGET_VERSION} schema.sql and set user_version=${TARGET_VERSION}`,
    sql: readSchemaSql() + `\nPRAGMA user_version = ${TARGET_VERSION};`,
  };
}

export function planMigration(dbPath: string): MigrationPlan {
  const dbExists = existsSync(dbPath);
  if (!dbExists) {
    return {
      currentVersion: null,
      targetVersion: TARGET_VERSION,
      steps: [freshInstallStep()],
    };
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const version = detectVersion(db);
    if (version === null) {
      return {
        currentVersion: null,
        targetVersion: TARGET_VERSION,
        steps: [freshInstallStep()],
      };
    }
    if (version === TARGET_VERSION) {
      return {
        currentVersion: version,
        targetVersion: TARGET_VERSION,
        steps: [],
      };
    }
    if (version === 2) {
      return {
        currentVersion: 2,
        targetVersion: TARGET_VERSION,
        steps: [STEP_0003],
      };
    }
    if (version === 1) {
      return {
        currentVersion: 1,
        targetVersion: TARGET_VERSION,
        steps: [STEP_0002, STEP_0003],
      };
    }
    if (version === 0) {
      return {
        currentVersion: 0,
        targetVersion: TARGET_VERSION,
        steps: [STEP_0001, STEP_0002, STEP_0003],
      };
    }
    throw new Error(
      `unsupported schema version: ${version} (this binary knows up to ${TARGET_VERSION})`,
    );
  } finally {
    db.close();
  }
}

export interface ApplyOptions {
  /**
   * When true, take a snapshot at dbPath+".pre-v<target>" before applying any
   * upgrade to an existing DB. Back-compat alias `snapshotV0Upgrade` also
   * honoured. Default false.
   */
  snapshotOnAnyUpgrade?: boolean;
  /** @deprecated use {@link snapshotOnAnyUpgrade} — kept for back-compat. */
  snapshotV0Upgrade?: boolean;
}

/** Apply all pending migrations. Returns the plan that was executed. */
export function applyMigrations(
  dbPath: string,
  opts: ApplyOptions = {},
): MigrationPlan {
  const plan = planMigration(dbPath);
  if (plan.steps.length === 0) {
    log.info("schema already current", { version: plan.currentVersion });
    return plan;
  }

  const wantSnapshot =
    opts.snapshotOnAnyUpgrade ?? opts.snapshotV0Upgrade ?? false;
  // Only snapshot when upgrading an existing DB — fresh installs have nothing to restore.
  if (wantSnapshot && plan.currentVersion !== null) {
    const snapshotPath = `${dbPath}.pre-v${plan.targetVersion}`;
    if (!existsSync(snapshotPath)) {
      copyFileSync(dbPath, snapshotPath);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(dbPath + suffix)) {
          copyFileSync(dbPath + suffix, snapshotPath + suffix);
        }
      }
      log.info("pre-migration snapshot written", {
        from: dbPath,
        to: snapshotPath,
      });
      plan.snapshotPath = snapshotPath;
    } else {
      log.info("pre-migration snapshot already exists — skipping", {
        path: snapshotPath,
      });
      plan.snapshotPath = snapshotPath;
    }
  }

  // Cross-process lock. Two concurrently-started `torana` processes that
  // both see user_version < TARGET must not both try to apply the same
  // migration: individual step SQL is idempotent in some cases (IF NOT
  // EXISTS) but not in all (ADD COLUMN fails if the column exists), and
  // silent half-applied state is the worst case. SQLite's own locking
  // narrows the race window but does not close it because planMigration
  // and applyMigrations use separate connections.
  //
  // Use a simple O_CREAT|O_EXCL lock file with the PID inside. On stale
  // lock (older than 10 minutes — migrations here are measured in seconds,
  // even on large DBs), we log a warning and steal. On fresh lock, we
  // refuse to start and surface a clear message.
  const lock = acquireMigrationLock(dbPath);
  try {
    const db = new Database(dbPath, { create: true });
    try {
      for (const step of plan.steps) {
        log.info("applying migration", {
          id: step.id,
          description: step.description,
        });
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
    // Lock down the DB and its WAL sidecars to 0600. Best-effort — fails
    // silently on filesystems without POSIX perms (Windows NTFS, some
    // FUSE mounts). GatewayDB also chmods on every open, so a migration
    // that ran on a posix-less mount still gets tightened whenever the
    // gateway next opens the DB on a posix mount.
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        if (existsSync(dbPath + suffix)) chmodSync(dbPath + suffix, 0o600);
      } catch (err) {
        log.warn("could not chmod db file to 0600", {
          path: dbPath + suffix,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    lock.release();
  }
  return plan;
}

/** Lifetime of a migration — if a lock file is older than this, treat as stale. */
const STALE_LOCK_AGE_MS = 10 * 60 * 1000;

function acquireMigrationLock(dbPath: string): { release: () => void } {
  const lockPath = `${dbPath}.migrate.lock`;
  const tryOpen = (): number | null => {
    try {
      return openSync(lockPath, "wx"); // O_CREAT | O_EXCL
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw err;
    }
  };

  let fd = tryOpen();
  if (fd === null) {
    // Lock file exists. Check age; steal if stale.
    let stale = false;
    try {
      const s = statSync(lockPath);
      const ageMs = Date.now() - s.mtimeMs;
      if (ageMs > STALE_LOCK_AGE_MS) {
        stale = true;
        log.warn("stealing stale migration lock", {
          path: lockPath,
          age_ms: Math.round(ageMs),
        });
        unlinkSync(lockPath);
      }
    } catch {
      /* race: other process may have released; try again below */
    }
    if (stale) {
      fd = tryOpen();
    }
    if (fd === null) {
      throw new Error(
        `migration lock held by another process at ${lockPath}. ` +
          `If you are certain no other torana process is running, delete the lock file and retry.`,
      );
    }
  }

  // Write PID + timestamp so a stuck operator can identify the holder.
  writeSync(
    fd,
    Buffer.from(`pid=${process.pid} ts=${new Date().toISOString()}\n`),
  );

  let released = false;
  return {
    release: (): void => {
      if (released) return;
      released = true;
      try {
        closeSync(fd!);
      } catch {
        /* already closed */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    },
  };
}
