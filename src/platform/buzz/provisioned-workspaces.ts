// Per-agent workspaces for Desktop-managed agents (R6).
//
// The path is always derived by Torana from the validated agent id and never
// taken from Desktop input (R6.5). There is no traversal surface to defend
// against because `BotIdSchema` cannot express one — `^[a-z][a-z0-9_-]{0,31}$`
// admits no dot and no separator — but the derivation is centralized here so
// that stays true by construction rather than by every call site remembering.
//
// **Honest scope of the isolation claim (R6.2).** Every harness process runs
// as the same UID. Distinct directories and the broker's workspace-containment
// check mean nothing Torana does ever points one agent at another's files, but
// a harness that *chooses* to read outside its `cwd` is not stopped by the
// filesystem. This is the layout-and-tooling layer of isolation, not a
// sandbox, and the residual is exactly the spec's declared trust boundary: a
// single owner, no multi-tenant isolation.

import { existsSync, mkdirSync, rmSync, statfsSync, statSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export class WorkspaceError extends Error {
  constructor(
    readonly code: "insufficient_space" | "not_a_directory" | "io_error",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** Root under which every provisioned agent's workspace lives. */
export function workspacesRoot(dataDir: string): string {
  return resolve(dataDir, "workspaces");
}

/** The workspace path for one agent. Derived, never supplied. */
export function workspacePathFor(dataDir: string, agentId: string): string {
  return join(workspacesRoot(dataDir), agentId);
}

/**
 * Free bytes on the volume holding the workspace root.
 *
 * Measured at the root rather than at the agent's own directory because the
 * directory does not exist yet at create time, and both live on the same
 * volume by construction.
 */
export function freeBytesFor(dataDir: string): number {
  const root = workspacesRoot(dataDir);
  const probe = existsSync(root) ? root : resolve(dataDir);
  const stats = statfsSync(probe);
  return Number(stats.bsize) * Number(stats.bavail);
}

/**
 * Create an agent's workspace, failing closed when the volume is low.
 *
 * The disk gate runs before the directory is created so a full volume refuses
 * the *create* rather than corrupting an agent that already exists (R6.4).
 * Idempotent: an existing directory is adopted, because create is re-run by
 * the startup restore path for agents whose rows already committed.
 */
export function ensureWorkspace(input: {
  dataDir: string;
  agentId: string;
  minFreeBytes: number;
}): string {
  const path = workspacePathFor(input.dataDir, input.agentId);
  if (existsSync(path)) {
    if (!statSync(path).isDirectory()) {
      throw new WorkspaceError(
        "not_a_directory",
        `workspace path '${path}' exists but is not a directory`,
      );
    }
    return path;
  }

  if (input.minFreeBytes > 0) {
    let free: number;
    try {
      free = freeBytesFor(input.dataDir);
    } catch (error) {
      throw new WorkspaceError(
        "io_error",
        `cannot determine free space for '${input.dataDir}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (free < input.minFreeBytes) {
      throw new WorkspaceError(
        "insufficient_space",
        `refusing to create workspace for '${input.agentId}': ${free} bytes free, ` +
          `provisioning.min_free_bytes requires ${input.minFreeBytes}`,
      );
    }
  }

  // 0700: the gateway is the only intended reader. This does not isolate one
  // agent from another (same UID) — see the note at the top of this file.
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/**
 * Remove an agent's workspace. Only ever called from purge (R6.3).
 *
 * Tolerates a missing directory so a purge interrupted midway converges when
 * the sweep re-runs, rather than wedging on the half it already finished.
 */
export function removeWorkspace(dataDir: string, agentId: string): boolean {
  const path = workspacePathFor(dataDir, agentId);
  if (!existsSync(path)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

/**
 * Recursive size of one workspace, for the usage sweep and the list route.
 *
 * Symlinks are measured by their own size and never followed: an agent that
 * symlinks a large tree into its workspace should not make the sweep walk the
 * whole volume, and following one out of the workspace would report another
 * agent's bytes as this agent's.
 */
export async function workspaceBytes(
  dataDir: string,
  agentId: string,
): Promise<number> {
  const root = workspacePathFor(dataDir, agentId);
  if (!existsSync(root)) return 0;
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      // `entry.isDirectory()` is already false for a symlink to a directory,
      // so only real directories are descended into.
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        try {
          // lstat, not stat: measure the link itself rather than its target.
          total += (await lstat(full)).size;
        } catch {
          // Raced with the agent deleting it; a usage number is advisory.
        }
      }
    }
  };
  await walk(root);
  return total;
}
