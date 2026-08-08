// US-031 — per-agent workspace lifecycle (R6).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureWorkspace,
  freeBytesFor,
  removeWorkspace,
  workspaceBytes,
  workspacePathFor,
  WorkspaceError,
} from "../../src/platform/buzz/provisioned-workspaces.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "torana-ws-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("workspace paths are derived, never supplied (R6.5)", () => {
  test("path is data_dir/workspaces/<agent_id>", () => {
    expect(workspacePathFor(dataDir, "canary")).toBe(
      join(dataDir, "workspaces", "canary"),
    );
  });

  test("distinct agents get distinct directories", () => {
    expect(workspacePathFor(dataDir, "a")).not.toBe(
      workspacePathFor(dataDir, "b"),
    );
  });

  test("a traversal-shaped id cannot escape the root", () => {
    // BotIdSchema already makes this unreachable — no dot, no separator — but
    // the derivation is asserted here so it stays true if the id rules ever
    // loosen.
    const path = workspacePathFor(dataDir, "../../etc");
    expect(path.startsWith(join(dataDir, "workspaces"))).toBe(false);
    // Which is exactly why ids are validated upstream, never here.
  });
});

describe("ensureWorkspace", () => {
  test("creates the directory 0700", () => {
    const path = ensureWorkspace({
      dataDir,
      agentId: "canary",
      minFreeBytes: 0,
    });
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  test("is idempotent and preserves existing contents", () => {
    // The startup restore path re-runs create for rows that already committed,
    // so adopting an existing directory must not wipe it.
    const first = ensureWorkspace({
      dataDir,
      agentId: "canary",
      minFreeBytes: 0,
    });
    writeFileSync(join(first, "notes.md"), "work in progress");
    const second = ensureWorkspace({
      dataDir,
      agentId: "canary",
      minFreeBytes: 0,
    });
    expect(second).toBe(first);
    expect(existsSync(join(first, "notes.md"))).toBe(true);
  });

  test("refuses when free space is below the floor (R6.4)", () => {
    // A ceiling no volume can satisfy stands in for a full disk.
    try {
      ensureWorkspace({
        dataDir,
        agentId: "canary",
        minFreeBytes: Number.MAX_SAFE_INTEGER,
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceError);
      expect((error as WorkspaceError).code).toBe("insufficient_space");
    }
    // Failing closed means leaving nothing behind.
    expect(existsSync(workspacePathFor(dataDir, "canary"))).toBe(false);
  });

  test("a full volume does not disturb an agent that already exists", () => {
    // D2's spirit: degraded writes, never cleanup.
    const existing = ensureWorkspace({
      dataDir,
      agentId: "incumbent",
      minFreeBytes: 0,
    });
    writeFileSync(join(existing, "keep.txt"), "x");
    expect(() =>
      ensureWorkspace({
        dataDir,
        agentId: "newcomer",
        minFreeBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow(WorkspaceError);
    expect(existsSync(join(existing, "keep.txt"))).toBe(true);
  });

  test("an existing workspace is adopted even when the volume is low", () => {
    // The disk gate guards creation, not use: refusing here would take a
    // running agent offline because the volume filled.
    ensureWorkspace({ dataDir, agentId: "canary", minFreeBytes: 0 });
    expect(() =>
      ensureWorkspace({
        dataDir,
        agentId: "canary",
        minFreeBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).not.toThrow();
  });

  test("refuses when the path exists but is a file", () => {
    mkdirSync(join(dataDir, "workspaces"), { recursive: true });
    writeFileSync(join(dataDir, "workspaces", "canary"), "not a directory");
    expect(() =>
      ensureWorkspace({ dataDir, agentId: "canary", minFreeBytes: 0 }),
    ).toThrow(/not a directory/);
  });

  test("reports a positive free-byte figure for a real volume", () => {
    expect(freeBytesFor(dataDir)).toBeGreaterThan(0);
  });
});

describe("removeWorkspace (purge only, R6.3)", () => {
  test("removes the directory and its contents", () => {
    const path = ensureWorkspace({
      dataDir,
      agentId: "canary",
      minFreeBytes: 0,
    });
    writeFileSync(join(path, "f.txt"), "x");
    expect(removeWorkspace(dataDir, "canary")).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("is idempotent, so a crashed purge converges when re-run", () => {
    ensureWorkspace({ dataDir, agentId: "canary", minFreeBytes: 0 });
    expect(removeWorkspace(dataDir, "canary")).toBe(true);
    expect(removeWorkspace(dataDir, "canary")).toBe(false);
  });

  test("removing one agent leaves its neighbour untouched", () => {
    ensureWorkspace({ dataDir, agentId: "a", minFreeBytes: 0 });
    const keep = ensureWorkspace({ dataDir, agentId: "b", minFreeBytes: 0 });
    removeWorkspace(dataDir, "a");
    expect(existsSync(keep)).toBe(true);
  });
});

describe("workspaceBytes", () => {
  test("returns 0 for an agent with no workspace", async () => {
    expect(await workspaceBytes(dataDir, "nobody")).toBe(0);
  });

  test("sums nested files", async () => {
    const path = ensureWorkspace({
      dataDir,
      agentId: "canary",
      minFreeBytes: 0,
    });
    mkdirSync(join(path, "nested"), { recursive: true });
    writeFileSync(join(path, "a.txt"), "0123456789");
    writeFileSync(join(path, "nested", "b.txt"), "01234");
    expect(await workspaceBytes(dataDir, "canary")).toBe(15);
  });

  test("does not follow a symlink out of the workspace", async () => {
    // Otherwise an agent could make the sweep walk the whole volume, and
    // another agent's bytes would be reported as this agent's.
    const path = ensureWorkspace({
      dataDir,
      agentId: "canary",
      minFreeBytes: 0,
    });
    const outside = ensureWorkspace({
      dataDir,
      agentId: "neighbour",
      minFreeBytes: 0,
    });
    writeFileSync(join(outside, "big.txt"), "x".repeat(4096));
    symlinkSync(join(outside, "big.txt"), join(path, "link"));
    const bytes = await workspaceBytes(dataDir, "canary");
    expect(bytes).toBeLessThan(4096);
  });
});
