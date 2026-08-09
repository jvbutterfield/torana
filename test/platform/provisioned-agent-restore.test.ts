// US-032 — restoring Desktop-managed agents at startup (R1.6).
//
// A provisioned agent has no YAML entry, so nothing rebuilds it on restart
// except this path. If it silently did nothing, the endpoint would still come
// up, authenticate, and announce presence — and then drop every message it
// received, because no Bot would be behind it. That failure looks like a
// healthy agent from the relay's side, which is why restore is tested for what
// it *returns to be registered*, not merely for not throwing.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import {
  parseProvisioningKey,
  singleKeyring,
} from "../../src/config/provisioning-secrets.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import {
  BuzzProvisioningService,
  ProvisionRequestSchema,
} from "../../src/platform/buzz/provisioning.js";
import { ensureWorkspace } from "../../src/platform/buzz/provisioned-workspaces.js";
import {
  createOwnerAuthTag,
  decodeSecret,
  publicKey,
} from "../../src/platform/buzz/protocol.js";
import type { BuzzTransport } from "../../src/platform/buzz/transport.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const KEY = "11".repeat(32);
const AGENT_KEY = "0a".repeat(32);
const OWNER_SECRET = decodeSecret("04".padStart(64, "0"));
const OWNER_PUBKEY = publicKey(OWNER_SECRET);

const dirs: string[] = [];
const dbs: GatewayDB[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function authTagFor(privateKey: string): string {
  return JSON.stringify(
    createOwnerAuthTag(
      OWNER_SECRET,
      publicKey(decodeSecret(privateKey)),
      "kind=9",
    ),
  );
}

function harnesses(turnCeiling = 3600) {
  return {
    claude: {
      runner: {
        type: "claude-code",
        cli_path: "claude",
        args: ["--model", "{model}"],
        acknowledge_dangerous: true,
      },
      defaults: { model: "claude-sonnet-5" },
      ceilings: {
        turn_timeout_secs: turnCeiling,
        idle_timeout_secs: 86_400,
        max_turn_duration_secs: turnCeiling,
      },
    },
  };
}

/** One data dir shared across "restarts", as a real volume would be. */
function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), "torana-restore-"));
  dirs.push(dir);
  return dir;
}

function boot(dir: string, options: { turnCeiling?: number } = {}) {
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as Record<string, any>;
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
  upgraded.platforms.buzz = { enabled: true };
  upgraded.provisioning = { harnesses: harnesses(options.turnCeiling) };
  const loaded = loadConfigFromString(yaml.dump(upgraded), {
    skipInterpolation: true,
  });
  applyMigrations(loaded.config.gateway.db_path!);
  const db = new GatewayDB(loaded.config.gateway.db_path!);
  db.syncNormalizedConfig(loaded.normalized);
  dbs.push(db);

  const registered: string[] = [];
  const service = new BuzzProvisioningService({
    db,
    configV2: loaded.configV2,
    keyring: singleKeyring(parseProvisioningKey(KEY)),
    provisioning: loaded.normalized.provisioning,
    dataDir: dir,
    transport: {
      snapshot: () => null,
      upsertEndpoint: async () => {},
      removeEndpoint: async () => {},
    } as unknown as BuzzTransport,
    agentRuntime: {
      upsert: (input: { agentId: string }) => registered.push(input.agentId),
      remove: () => {},
    },
  });
  return { service, db, registered, dir };
}

function createRequest(overrides: Record<string, unknown> = {}) {
  return ProvisionRequestSchema.parse({
    agent_id: "canary",
    relay_url: "wss://relay.example",
    private_key: AGENT_KEY,
    auth_tag: authTagFor(AGENT_KEY),
    owner_pubkey: OWNER_PUBKEY,
    agent: {
      harness: "claude",
      system_prompt: "be terse",
      turn_timeout_seconds: 900,
    },
    ...overrides,
  });
}

describe("restoring provisioned agents", () => {
  test("an agent created before a restart comes back with its runner", async () => {
    const dir = makeWorld();
    const first = boot(dir);
    await first.service.upsert("canary-buzz", createRequest(), "provisioner");
    const versionBefore =
      first.db.getProvisionedAgent("canary")!.instructionVersion;

    // "Restart": a fresh service over the same volume and database.
    const second = boot(dir);
    const restored = second.service.loadPersisted();

    expect(restored.errors).toEqual([]);
    expect(restored.agents.map((a) => a.agentId)).toEqual(["canary"]);
    const agent = restored.agents[0];
    expect(agent.endpointId).toBe("canary-buzz");
    expect(agent.botConfig.runner.type).toBe("claude-code");
    // The projection survived the round trip through the row, instructions
    // included — a restore that produced a runner with no prompt would look
    // fine here without this assertion.
    expect(JSON.stringify(agent.botConfig.runner)).toContain("claude-sonnet-5");
    expect(second.db.getProvisionedAgent("canary")!.instructionVersion).toBe(
      versionBefore,
    );
  });

  test("the endpoint is restored alongside the agent", async () => {
    const dir = makeWorld();
    const first = boot(dir);
    await first.service.upsert("canary-buzz", createRequest(), "provisioner");
    const restored = boot(dir).service.loadPersisted();
    expect(restored.endpoints.map((e) => e.id)).toContain("canary-buzz");
  });

  test("a harness ceiling change re-persists the instruction version (R3.6)", async () => {
    // The row did not move, but what the agent actually runs did: 900s was
    // inside the old ceiling and is clamped by the new one. A digest that
    // stayed put would misreport a live agent.
    const dir = makeWorld();
    const first = boot(dir);
    await first.service.upsert("canary-buzz", createRequest(), "provisioner");
    const before = first.db.getProvisionedAgent("canary")!.instructionVersion;

    const second = boot(dir, { turnCeiling: 60 });
    const restored = second.service.loadPersisted();
    expect(restored.errors).toEqual([]);
    const after = second.db.getProvisionedAgent("canary")!.instructionVersion;
    expect(after).not.toBe(before);
  });

  test("an agent whose harness was removed is reported, not silently dropped", async () => {
    const dir = makeWorld();
    const first = boot(dir);
    await first.service.upsert("canary-buzz", createRequest(), "provisioner");

    // Reboot with an allowlist that no longer contains `claude`.
    const upgraded = upgradeV1Object(
      makeTestConfig([makeTestBotConfig("alpha")]),
    ) as Record<string, any>;
    upgraded.gateway.data_dir = dir;
    upgraded.gateway.db_path = join(dir, "gateway.db");
    upgraded.platforms.buzz = { enabled: true };
    upgraded.provisioning = {
      harnesses: {
        other: {
          runner: { type: "codex", cli_path: "codex", args: [] },
          ceilings: {
            turn_timeout_secs: 600,
            idle_timeout_secs: 600,
            max_turn_duration_secs: 600,
          },
        },
      },
    };
    const loaded = loadConfigFromString(yaml.dump(upgraded), {
      skipInterpolation: true,
    });
    const db = new GatewayDB(loaded.config.gateway.db_path!);
    dbs.push(db);
    const service = new BuzzProvisioningService({
      db,
      configV2: loaded.configV2,
      keyring: singleKeyring(parseProvisioningKey(KEY)),
      provisioning: loaded.normalized.provisioning,
      dataDir: dir,
      transport: null,
    });

    const restored = service.loadPersisted();
    // The merge itself fails, because the synthesized agent cannot be built —
    // and that is reported rather than starting an endpoint with no agent.
    expect(restored.errors.join(" ")).toContain("claude");
    expect(restored.agents).toEqual([]);
  });

  test("nothing to restore is not an error", () => {
    const dir = makeWorld();
    const restored = boot(dir).service.loadPersisted();
    expect(restored).toMatchObject({ endpoints: [], agents: [], errors: [] });
  });

  test("the workspace survives the restart", async () => {
    const dir = makeWorld();
    const first = boot(dir);
    await first.service.upsert("canary-buzz", createRequest(), "provisioner");
    // Re-running create's workspace step must adopt, not replace (R6.3).
    const path = ensureWorkspace({
      dataDir: dir,
      agentId: "canary",
      minFreeBytes: 0,
    });
    expect(path).toContain("canary");
    const restored = boot(dir).service.loadPersisted();
    expect(restored.agents).toHaveLength(1);
  });
});
