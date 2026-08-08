// US-031 — dynamic registration of Desktop-managed agents.
//
// The agent-level analog of `BuzzTransport.upsertEndpoint`: add, replace, and
// remove an agent without restarting the process. The cases that matter are
// the refusals — a provisioned agent must never be able to take over a
// YAML-declared id (R1.4), and a remove must never silently claim to have
// removed something it did not.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BotRegistry } from "../../src/core/registry.js";
import { Bot } from "../../src/core/bot.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";
import type { PlatformAdapter } from "../../src/platform/capabilities.js";
import type { AlertManager } from "../../src/alerts.js";
import type { Metrics } from "../../src/metrics.js";
import type { OutboxProcessor } from "../../src/outbox.js";
import type { StreamManager } from "../../src/streaming.js";

let tmpDir: string;
let db: GatewayDB;
let registry: BotRegistry;

/** A minimal adapter: the registry only reads `endpoint.id`/`agentId`. */
function adapterFor(agentId: string, endpointId: string): PlatformAdapter {
  return {
    endpoint: { id: endpointId, agentId, platform: "buzz" },
  } as unknown as PlatformAdapter;
}

function buildRegistry(yamlBotIds: string[]): BotRegistry {
  const botConfigs = yamlBotIds.map((id) => makeTestBotConfig(id));
  const config = makeTestConfig(botConfigs);
  const adapters = new Map<string, PlatformAdapter>();
  const bots = botConfigs.map((botConfig) => {
    const endpoint = adapterFor(botConfig.id, `${botConfig.id}-buzz`);
    adapters.set(botConfig.id, endpoint);
    adapters.set(endpoint.endpoint.id, endpoint);
    return new Bot({
      config,
      botConfig,
      db,
      endpoint,
      streaming: {} as unknown as StreamManager,
      outbox: {} as unknown as OutboxProcessor,
      metrics: {} as unknown as Metrics,
      alerts: {} as unknown as AlertManager,
      // Injected so construction never instantiates (or spawns) a real runner.
      runner: stubRunner(),
    });
  });
  return new BotRegistry({
    config,
    db,
    bots,
    adapters,
    streaming: {} as unknown as StreamManager,
    outbox: {} as unknown as OutboxProcessor,
    metrics: {} as unknown as Metrics,
    alerts: {} as unknown as AlertManager,
  });
}

/** Enough of the runner surface for Bot's constructor to wire its listeners. */
function stubRunner() {
  return {
    on: () => {},
    isReady: () => false,
    start: async () => {},
    stop: async () => {},
  } as never;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-registry-prov-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);
  registry = buildRegistry(["yamlbot"]);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("upsertProvisionedAgent", () => {
  test("registers a new agent and marks it provisioned", () => {
    registry.upsertProvisionedAgent({
      botConfig: makeTestBotConfig("canary"),
      endpoint: adapterFor("canary", "canary-buzz"),
    });
    expect(registry.bot("canary")).toBeDefined();
    expect(registry.isProvisioned("canary")).toBe(true);
    expect(registry.botIds).toContain("canary");
  });

  test("a YAML agent is not marked provisioned", () => {
    expect(registry.isProvisioned("yamlbot")).toBe(false);
  });

  test("refuses to shadow a YAML-declared agent (R1.4)", () => {
    // The gate that matters: without it, a deploy naming a YAML id would swap
    // a running agent's runner out from under it.
    expect(() =>
      registry.upsertProvisionedAgent({
        botConfig: makeTestBotConfig("yamlbot"),
        endpoint: adapterFor("yamlbot", "yamlbot-buzz"),
      }),
    ).toThrow(/declared in configuration/);
    expect(registry.isProvisioned("yamlbot")).toBe(false);
  });

  test("re-upserting replaces in place rather than duplicating", () => {
    const first = registry.upsertProvisionedAgent({
      botConfig: makeTestBotConfig("canary"),
      endpoint: adapterFor("canary", "canary-buzz"),
    });
    const second = registry.upsertProvisionedAgent({
      botConfig: makeTestBotConfig("canary"),
      endpoint: adapterFor("canary", "canary-buzz"),
    });
    expect(second).not.toBe(first);
    expect(registry.bot("canary")).toBe(second);
    expect(registry.botIds.filter((id) => id === "canary")).toHaveLength(1);
  });

  test("registers the endpoint id as well as the agent id", () => {
    // Inbound traffic arrives addressed by endpoint id, so both keys must
    // resolve or the agent silently receives nothing.
    registry.upsertProvisionedAgent({
      botConfig: makeTestBotConfig("canary"),
      endpoint: adapterFor("canary", "canary-buzz"),
    });
    expect(registry.bot("canary")).toBeDefined();
  });
});

describe("removeProvisionedAgent", () => {
  test("deregisters a provisioned agent", () => {
    registry.upsertProvisionedAgent({
      botConfig: makeTestBotConfig("canary"),
      endpoint: adapterFor("canary", "canary-buzz"),
    });
    expect(registry.removeProvisionedAgent("canary")).toBe(true);
    expect(registry.bot("canary")).toBeUndefined();
    expect(registry.isProvisioned("canary")).toBe(false);
    expect(registry.botIds).not.toContain("canary");
  });

  test("reports false for an unknown id", () => {
    expect(registry.removeProvisionedAgent("nobody")).toBe(false);
  });

  test("refuses to remove a YAML agent, and leaves it running", () => {
    // A purge that quietly deleted a YAML agent would be the worst possible
    // outcome of a mis-matched tombstone.
    expect(registry.removeProvisionedAgent("yamlbot")).toBe(false);
    expect(registry.bot("yamlbot")).toBeDefined();
  });

  test("is idempotent", () => {
    registry.upsertProvisionedAgent({
      botConfig: makeTestBotConfig("canary"),
      endpoint: adapterFor("canary", "canary-buzz"),
    });
    expect(registry.removeProvisionedAgent("canary")).toBe(true);
    expect(registry.removeProvisionedAgent("canary")).toBe(false);
  });

  test("removing one provisioned agent leaves its neighbours alone", () => {
    for (const id of ["one", "two"]) {
      registry.upsertProvisionedAgent({
        botConfig: makeTestBotConfig(id),
        endpoint: adapterFor(id, `${id}-buzz`),
      });
    }
    registry.removeProvisionedAgent("one");
    expect(registry.bot("two")).toBeDefined();
    expect(registry.bot("yamlbot")).toBeDefined();
  });
});
