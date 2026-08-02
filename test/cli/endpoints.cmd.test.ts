import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { loadConfigFromFile } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { decodeSecret, publicKey } from "../../src/platform/buzz/protocol.js";
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
  const process = Bun.spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: globalThis.process.env.PATH ?? "" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout as ReadableStream).text(),
    new Response(process.stderr as ReadableStream).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function phase4Config(): string {
  const dir = mkdtempSync(join(tmpdir(), "torana-endpoints-cli-"));
  tempDirs.push(dir);
  const config = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  const key = "01".padStart(64, "0");
  const owner = publicKey(decodeSecret("04".padStart(64, "0")));
  config.gateway.data_dir = dir;
  config.gateway.db_path = join(dir, "gateway.db");
  config.platforms.buzz.enabled = true;
  config.agents[0].endpoints.push({
    id: "alpha-buzz",
    platform: "buzz",
    enabled: true,
    community_id: "primary",
    relay_url: "wss://relay.example.com",
    private_key: key,
    respond_to: "owner_only",
    owner_pubkey: owner,
  });
  const path = join(dir, "torana.yaml");
  writeFileSync(path, yaml.dump(config), { mode: 0o600 });
  const loaded = loadConfigFromFile(path);
  applyMigrations(loaded.config.gateway.db_path!);
  const db = new GatewayDB(loaded.config.gateway.db_path!);
  db.syncNormalizedConfig(loaded.normalized);
  db.close();
  return path;
}

function parseJsonArray(output: string): unknown[] {
  const start = output.indexOf("[\n");
  const end = output.lastIndexOf("\n]");
  if (start < 0 || end < start)
    throw new Error(`missing JSON array: ${output}`);
  return JSON.parse(output.slice(start, end + 2));
}

test("endpoint status, drain, disable, and resume persist lifecycle state", async () => {
  const config = phase4Config();
  const status = await runCli([
    "endpoints",
    "status",
    "alpha-buzz",
    "--format",
    "json",
    "--config",
    config,
  ]);
  expect(status.exitCode).toBe(0);
  expect(parseJsonArray(status.stdout)[0]).toMatchObject({
    endpointId: "alpha-buzz",
    lifecycleState: "active",
  });

  const drain = await runCli([
    "endpoints",
    "drain",
    "alpha-buzz",
    "--config",
    config,
  ]);
  expect(drain.exitCode).toBe(0);
  expect(drain.stdout).toContain("is draining");

  const disable = await runCli([
    "endpoints",
    "disable",
    "alpha-buzz",
    "--config",
    config,
  ]);
  expect(disable.exitCode).toBe(0);
  expect(disable.stdout).toContain("disabled");

  const resume = await runCli([
    "endpoints",
    "resume",
    "alpha-buzz",
    "--config",
    config,
  ]);
  expect(resume.exitCode).toBe(0);
  expect(resume.stdout).toContain("resumed");

  const finalStatus = await runCli([
    "endpoints",
    "status",
    "alpha-buzz",
    "--format",
    "json",
    "--config",
    config,
  ]);
  expect(finalStatus.exitCode).toBe(0);
  expect(parseJsonArray(finalStatus.stdout)[0]).toMatchObject({
    lifecycleState: "active",
  });
});
