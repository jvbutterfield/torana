// US-034 — `torana agents`, the operator's half of the delete pipeline.
//
// None of these commands destroy anything directly. `purge` moves a persisted
// deadline and hands the destruction to the running gateway, which is the only
// process that holds the agent's runner, its endpoint supervisor, and the
// audit-first ordering. The tests below hold that line: the flag is required,
// the row survives the command, and the message says who actually does it.

import { afterEach, expect, test } from "bun:test";
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

/**
 * Pull the pretty-printed payload out of stdout.
 *
 * The gateway's own single-line JSON log records share the stream, so "find the
 * first brace" would grab a log line. The payload is the only multi-line value,
 * which is what the two-character opener keys off.
 */
function parsePretty<T>(stdout: string, opener: "[" | "{"): T {
  const closer = opener === "[" ? "]" : "}";
  const start = stdout.indexOf(`${opener}\n`);
  const end = stdout.lastIndexOf(`\n${closer}`);
  if (start < 0 || end < start) throw new Error(`missing payload: ${stdout}`);
  return JSON.parse(stdout.slice(start, end + 2)) as T;
}

interface Fixture {
  configPath: string;
  dbPath: string;
  withDb: <T>(fn: (db: GatewayDB) => T) => T;
}

function fixture(options: { staged?: boolean } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "torana-agents-cli-"));
  tempDirs.push(dir);
  const config = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  config.gateway.data_dir = dir;
  config.gateway.db_path = join(dir, "gateway.db");
  config.platforms.buzz.enabled = true;
  config.provisioning = {
    max_agents: 8,
    delete_grace_hours: 72,
    harnesses: {
      claude: {
        runner: {
          type: "claude-code",
          cli_path: "claude",
          args: ["--model", "{model}"],
          acknowledge_dangerous: true,
        },
        ceilings: {
          turn_timeout_secs: 3600,
          idle_timeout_secs: 86_400,
          max_turn_duration_secs: 3600,
        },
      },
    },
  };
  const configPath = join(dir, "torana.yaml");
  writeFileSync(configPath, yaml.dump(config), { mode: 0o600 });

  const loaded = loadConfigFromFile(configPath);
  applyMigrations(loaded.config.gateway.db_path!);
  const db = new GatewayDB(loaded.config.gateway.db_path!);
  db.syncNormalizedConfig(loaded.normalized);
  db.upsertProvisionedAgent({
    agentId: "canary",
    derivedPubkey: "ab".repeat(32),
    harness: "claude",
    systemPrompt: "",
    model: null,
    timeoutsJson: "{}",
    instructionVersion: "abc123def456",
    provisionedBy: "provisioner",
  });
  if (options.staged) {
    db.stageProvisionedAgentDelete({
      agentId: "canary",
      stagedAt: "2026-08-09 00:00:00",
      purgeDeadline: "2026-08-12 00:00:00",
    });
  }
  db.close();

  return {
    configPath,
    dbPath: loaded.config.gateway.db_path!,
    withDb: (fn) => {
      const handle = new GatewayDB(loaded.config.gateway.db_path!);
      try {
        return fn(handle);
      } finally {
        handle.close();
      }
    },
  };
}

test("agents list shows lifecycle, version, and the pending purge deadline", async () => {
  const f = fixture({ staged: true });
  const result = await runCli(["agents", "list", "--config", f.configPath]);
  expect(exitOk(result)).toBe(0);
  expect(result.stdout).toContain("canary");
  expect(result.stdout).toContain("staged_delete");
  expect(result.stdout).toContain("purge_at=2026-08-12 00:00:00");
});

test("agents list --format json emits the rows verbatim", async () => {
  const f = fixture();
  const result = await runCli([
    "agents",
    "list",
    "--format",
    "json",
    "--config",
    f.configPath,
  ]);
  expect(exitOk(result)).toBe(0);
  const rows = parsePretty<Array<Record<string, unknown>>>(result.stdout, "[");
  expect(rows[0]).toMatchObject({ agentId: "canary", lifecycle: "active" });
});

test("agents report runs with no relay and leaves every record state unknown", async () => {
  const f = fixture({ staged: true });
  const result = await runCli([
    "agents",
    "report",
    "--format",
    "json",
    "--config",
    f.configPath,
  ]);
  expect(exitOk(result)).toBe(0);
  const report = parsePretty<{
    recordProbe: string;
    agents: Array<Record<string, unknown>>;
  }>(result.stdout, "{");
  expect(report.recordProbe).toBe("unavailable");
  expect(report.agents[0]).toMatchObject({
    agentId: "canary",
    lifecycle: "staged_delete",
    recordState: "unknown",
  });
});

test("agents restore reverses a staged deletion and says what it did not do", async () => {
  const f = fixture({ staged: true });
  const result = await runCli([
    "agents",
    "restore",
    "canary",
    "--config",
    f.configPath,
  ]);
  expect(exitOk(result)).toBe(0);
  // The honest half of restore: the endpoint does not come back, and the agent
  // is now running with no Desktop record behind it.
  expect(result.stdout).toContain("endpoint stays down");
  expect(result.stdout).toContain("reconciliation report");
  f.withDb((db) => {
    const row = db.getProvisionedAgent("canary")!;
    expect(row.lifecycle).toBe("active");
    expect(row.purgeDeadline).toBeNull();
  });
});

test("agents restore refuses an agent that is not staged", async () => {
  const f = fixture();
  const result = await runCli([
    "agents",
    "restore",
    "canary",
    "--config",
    f.configPath,
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("not staged for deletion");
});

test("agents restore refuses an unknown agent", async () => {
  const f = fixture();
  const result = await runCli([
    "agents",
    "restore",
    "ghost",
    "--config",
    f.configPath,
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("not a Desktop-managed agent");
});

test("agents purge refuses without --acknowledge-data-loss, and changes nothing", async () => {
  const f = fixture({ staged: true });
  const result = await runCli([
    "agents",
    "purge",
    "canary",
    "--config",
    f.configPath,
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("--acknowledge-data-loss");
  f.withDb((db) => {
    expect(db.getProvisionedAgent("canary")?.purgeDeadline).toBe(
      "2026-08-12 00:00:00",
    );
  });
});

test("agents purge brings the deadline forward without destroying anything itself", async () => {
  const f = fixture({ staged: true });
  const result = await runCli([
    "agents",
    "purge",
    "canary",
    "--acknowledge-data-loss",
    "--config",
    f.configPath,
  ]);
  expect(exitOk(result)).toBe(0);
  expect(result.stdout).toContain("running gateway destroys it");
  f.withDb((db) => {
    const row = db.getProvisionedAgent("canary");
    // Still present: the CLI schedules, the gateway destroys.
    expect(row).not.toBeNull();
    expect(row!.lifecycle).toBe("staged_delete");
    expect(row!.purgeDeadline! <= "2026-08-12 00:00:00").toBe(true);
  });
});

test("agents purge on an active agent stages it with an immediate deadline", async () => {
  const f = fixture();
  const result = await runCli([
    "agents",
    "purge",
    "canary",
    "--acknowledge-data-loss",
    "--config",
    f.configPath,
  ]);
  expect(exitOk(result)).toBe(0);
  f.withDb((db) => {
    expect(db.getProvisionedAgent("canary")?.lifecycle).toBe("staged_delete");
  });
});

test("an unknown action prints the usage line", async () => {
  const f = fixture();
  const result = await runCli(["agents", "nuke", "--config", f.configPath]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("usage: torana agents");
});

test("restore and purge both require an agent id", async () => {
  const f = fixture();
  for (const action of ["restore", "purge"]) {
    const result = await runCli(["agents", action, "--config", f.configPath]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("usage: torana agents");
  }
});
