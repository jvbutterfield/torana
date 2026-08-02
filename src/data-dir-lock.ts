import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

interface LockRecord {
  pid: number;
  token: string;
  acquired_at: string;
}

export class DataDirLock {
  readonly path: string;
  private record: LockRecord;
  private released = false;

  private constructor(path: string, record: LockRecord) {
    this.path = path;
    this.record = record;
  }

  static acquire(dataDir: string): DataDirLock {
    const path = resolve(dataDir, ".torana.lock");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record: LockRecord = {
        pid: process.pid,
        token: crypto.randomUUID(),
        acquired_at: new Date().toISOString(),
      };
      try {
        const fd = openSync(path, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify(record), { encoding: "utf8" });
        } finally {
          closeSync(fd);
        }
        return new DataDirLock(path, record);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const existingRaw = safeRead(path);
        const existing = parseRecord(existingRaw);
        if (existing && processExists(existing.pid)) {
          throw new Error(
            `gateway data directory is already locked by PID ${existing.pid} (${path})`,
          );
        }
        // Remove only the exact stale record we inspected. If another process
        // replaced it between reads, leave it alone and fail on the next pass.
        if (existingRaw !== null && safeRead(path) === existingRaw) {
          try {
            unlinkSync(path);
          } catch {
            // The second exclusive-create attempt reports the final result.
          }
        }
      }
    }
    throw new Error(`could not acquire gateway data-directory lock (${path})`);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    const current = parseRecord(safeRead(this.path));
    if (current?.token !== this.record.token) return;
    try {
      unlinkSync(this.path);
    } catch {
      // Best effort during shutdown; a stale PID record is recovered safely.
    }
  }
}

export function dataDirLockAvailable(dataDir: string): {
  available: boolean;
  detail: string;
} {
  try {
    const lock = DataDirLock.acquire(dataDir);
    lock.release();
    return { available: true, detail: "data-directory lock is obtainable" };
  } catch (error) {
    return {
      available: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function safeRead(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseRecord(raw: string | null): LockRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LockRecord>;
    if (
      Number.isSafeInteger(value.pid) &&
      typeof value.token === "string" &&
      typeof value.acquired_at === "string"
    ) {
      return value as LockRecord;
    }
  } catch {
    // Malformed lock records are stale and recoverable.
  }
  return null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}
