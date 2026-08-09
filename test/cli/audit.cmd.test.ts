// US-035 — audit retention and `torana audit prune` (R12.5).
//
// The rule this defends: the purge record outlives the agent it describes. A
// purge log deleted along with the agent proves nothing, so retention pruning
// skips purge records by default and needs two explicit flags to touch them.
// Nothing here runs on a timer — pruning is an operator act, always.

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";

import { loadConfigFromFile } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const CLI_ENTRY = resolve(import.meta.dir, "../../src/cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const child = Bun.spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: globalThis.process.env.PATH ?? "" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function exitOk(result: { exitCode: number; stderr: string }): number | string {
  return result.exitCode === 0
    ? 0
    : `exit ${result.exitCode}: ${result.stderr.trim()}`;
}

interface Fixture {
  configPath: string;
  dbPath: string;
  rows: () => Array<{ signal: string; created_at: string }>;
}

/**
 * Seed audit rows at chosen ages. `created_at` defaults to `datetime('now')`,
 * so backdating needs a direct write — the whole point of retention is what
 * happens to rows written months ago.
 */
function fixture(options: { auditDays?: number } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "torana-audit-cli-"));
  tempDirs.push(dir);
  const config = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  config.gateway.data_dir = dir;
  config.gateway.db_path = join(dir, "gateway.db");
  if (options.auditDays !== undefined) {
    config.retention = { provisioning_audit_days: options.auditDays };
  }
  const configPath = join(dir, "torana.yaml");
  writeFileSync(configPath, yaml.dump(config), { mode: 0o600 });

  const loaded = loadConfigFromFile(configPath);
  applyMigrations(loaded.config.gateway.db_path!);
  const db = new GatewayDB(loaded.config.gateway.db_path!);
  db.syncNormalizedConfig(loaded.normalized);
  db.close();

  const raw = new Database(loaded.config.gateway.db_path!);
  const insert = raw.prepare(
    `INSERT INTO provisioning_audit
       (agent_id, signal, actor, outcome, detail, created_at)
     VALUES (?, ?, 'test', 'ok', NULL, ?)`,
  );
  const at = (daysAgo: number): string =>
    new Date(Date.now() - daysAgo * 86_400_000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
  insert.run("canary", "create", at(500));
  insert.run("canary", "update", at(400));
  insert.run("canary", "purge", at(450));
  insert.run("canary", "stage_delete", at(10));
  raw.close();

  return {
    configPath,
    dbPath: loaded.config.gateway.db_path!,
    rows: () => {
      const probe = new Database(loaded.config.gateway.db_path!, {
        readonly: true,
      });
      try {
        return probe
          .query(
            "SELECT signal, created_at FROM provisioning_audit ORDER BY id",
          )
          .all() as Array<{ signal: string; created_at: string }>;
      } finally {
        probe.close();
      }
    },
  };
}

describe("torana audit prune", () => {
  test("deletes rows past the retention default and keeps purge records", async () => {
    const f = fixture();
    const result = await runCli(["audit", "prune", "--config", f.configPath]);
    expect(exitOk(result)).toBe(0);

    const signals = f.rows().map((row) => row.signal);
    // 500d create and 400d update are past the 365d default; the 10d stage is
    // not; the 450d purge record is exempt.
    expect(signals.sort()).toEqual(["purge", "stage_delete"]);
    expect(result.stdout).toContain("deleted 2 audit row(s)");
    expect(result.stdout).toContain("kept 1 purge record(s)");
  });

  test("--dry-run reports the same count and deletes nothing", async () => {
    const f = fixture();
    const result = await runCli([
      "audit",
      "prune",
      "--dry-run",
      "--config",
      f.configPath,
    ]);
    expect(exitOk(result)).toBe(0);
    expect(result.stdout).toContain("would delete 2 audit row(s)");
    expect(f.rows()).toHaveLength(4);
  });

  test("--before overrides the configured window", async () => {
    const f = fixture();
    // A cutoff before every seeded row: nothing qualifies.
    const result = await runCli([
      "audit",
      "prune",
      "--before",
      "2000-01-01",
      "--config",
      f.configPath,
    ]);
    expect(exitOk(result)).toBe(0);
    expect(result.stdout).toContain("deleted 0 audit row(s)");
    expect(f.rows()).toHaveLength(4);
  });

  test("a shorter configured window prunes more", async () => {
    const f = fixture({ auditDays: 30 });
    await runCli(["audit", "prune", "--config", f.configPath]);
    // Everything but the 10-day stage row, purge record still exempt.
    expect(
      f
        .rows()
        .map((row) => row.signal)
        .sort(),
    ).toEqual(["purge", "stage_delete"]);
  });

  test("--include-purge-records alone is refused", async () => {
    const f = fixture();
    const result = await runCli([
      "audit",
      "prune",
      "--include-purge-records",
      "--config",
      f.configPath,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--acknowledge-data-loss");
    expect(f.rows()).toHaveLength(4);
  });

  test("both flags together do remove purge records", async () => {
    const f = fixture();
    const result = await runCli([
      "audit",
      "prune",
      "--include-purge-records",
      "--acknowledge-data-loss",
      "--config",
      f.configPath,
    ]);
    expect(exitOk(result)).toBe(0);
    expect(f.rows().map((row) => row.signal)).toEqual(["stage_delete"]);
    // No "kept" line: nothing was spared.
    expect(result.stdout).not.toContain("kept");
  });

  test("rejects a malformed --before rather than guessing a cutoff", async () => {
    const f = fixture();
    for (const bad of ["yesterday", "2026-8-1", "2026-08-01T00:00:00Z"]) {
      const result = await runCli([
        "audit",
        "prune",
        "--before",
        bad,
        "--config",
        f.configPath,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("YYYY-MM-DD");
    }
    expect(f.rows()).toHaveLength(4);
  });

  test("--format json reports the cutoff it used", async () => {
    const f = fixture();
    const result = await runCli([
      "audit",
      "prune",
      "--dry-run",
      "--format",
      "json",
      "--config",
      f.configPath,
    ]);
    expect(exitOk(result)).toBe(0);
    const start = result.stdout.indexOf("{\n");
    const payload = JSON.parse(
      result.stdout.slice(start, result.stdout.lastIndexOf("\n}") + 2),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      matched: 2,
      purgeRecordsKept: 1,
      deleted: 0,
    });
    expect(String(payload.before)).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  test("an unknown action prints the usage line", async () => {
    const f = fixture();
    const result = await runCli(["audit", "nuke", "--config", f.configPath]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("usage: torana audit prune");
  });

  test("prune with no audit rows at all is a clean no-op", async () => {
    const f = fixture();
    await runCli([
      "audit",
      "prune",
      "--include-purge-records",
      "--acknowledge-data-loss",
      "--before",
      "2100-01-01",
      "--config",
      f.configPath,
    ]);
    const second = await runCli(["audit", "prune", "--config", f.configPath]);
    expect(exitOk(second)).toBe(0);
    expect(second.stdout).toContain("deleted 0 audit row(s)");
  });
});
