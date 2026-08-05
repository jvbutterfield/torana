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

// Comparing a bare exit code reports "Expected: 0, Received: 1"
// and throws away the CLI's own error message — precisely what you need when
// one of these fails on a CI runner and not locally. Fold stderr into the
// compared value so the assertion diff carries the reason with it.
function exitOk(result: { exitCode: number; stderr: string }): number | string {
  return result.exitCode === 0
    ? 0
    : `exit ${result.exitCode}: ${result.stderr.trim()}`;
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
  expect(exitOk(status)).toBe(0);
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
  expect(exitOk(drain)).toBe(0);
  expect(drain.stdout).toContain("is draining");

  const disable = await runCli([
    "endpoints",
    "disable",
    "alpha-buzz",
    "--config",
    config,
  ]);
  expect(exitOk(disable)).toBe(0);
  expect(disable.stdout).toContain("disabled");

  const resume = await runCli([
    "endpoints",
    "resume",
    "alpha-buzz",
    "--config",
    config,
  ]);
  expect(exitOk(resume)).toBe(0);
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
  expect(exitOk(finalStatus)).toBe(0);
  expect(parseJsonArray(finalStatus.stdout)[0]).toMatchObject({
    lifecycleState: "active",
  });
});

test("operator lists conversations/sessions and controls exact outbox replay", async () => {
  const configPath = phase4Config();
  const loaded = loadConfigFromFile(configPath);
  const db = new GatewayDB(loaded.config.gateway.db_path!);
  const conversation = {
    platform: "buzz" as const,
    communityId: "primary",
    endpointId: "alpha-buzz",
    channelId: "11111111-2222-4333-8444-555555555555",
    threadRootId: null,
    workflowRunId: null,
    type: "stream" as const,
  };
  db.resolveConversation("alpha", conversation, "owner");
  const outboxId = db.insertOutboundOperation({
    turnId: null,
    agentId: "alpha",
    conversation,
    operation: { kind: "send", text: "durable", files: [] },
    signedPayloadJson: '{"id":"signed"}',
    signedEventId: "ab".repeat(32),
  });
  db.close();

  const conversations = await runCli([
    "conversations",
    "list",
    "--format",
    "json",
    "--config",
    configPath,
  ]);
  expect(exitOk(conversations)).toBe(0);
  expect(parseJsonArray(conversations.stdout)[0]).toMatchObject({
    platform: "buzz",
    endpointId: "alpha-buzz",
  });

  const sessions = await runCli([
    "sessions",
    "list",
    "--format=json",
    "--config",
    configPath,
  ]);
  expect(exitOk(sessions)).toBe(0);
  expect(parseJsonArray(sessions.stdout)[0]).toMatchObject({
    agentId: "alpha",
    state: "stopped",
    bindings: 1,
  });

  const dead = await runCli([
    "outbox",
    "dead-letter",
    String(outboxId),
    "--config",
    configPath,
  ]);
  expect(exitOk(dead)).toBe(0);
  expect(dead.stdout).toContain("dead-lettered");

  const listed = await runCli([
    "outbox",
    "list",
    "--format=json",
    "--config",
    configPath,
  ]);
  expect(exitOk(listed)).toBe(0);
  expect(parseJsonArray(listed.stdout)[0]).toMatchObject({
    id: outboxId,
    status: "dead",
    signedEventId: "ab".repeat(32),
  });
  expect(listed.stdout).not.toContain("durable");

  const replay = await runCli([
    "outbox",
    "replay",
    String(outboxId),
    "--config",
    configPath,
  ]);
  expect(exitOk(replay)).toBe(0);
  expect(replay.stdout).toContain("exact-payload replay");

  const verify = new GatewayDB(loaded.config.gateway.db_path!);
  expect(verify.listOperationalOutbox()[0]).toMatchObject({
    id: outboxId,
    status: "pending",
    attempts: 0,
    signedEventId: "ab".repeat(32),
  });
  verify.close();
});
