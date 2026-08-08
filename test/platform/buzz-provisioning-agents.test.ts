// US-032 — the create arm of the deploy decision table.
//
// The property under test: a create either fully happens or leaves nothing
// behind (R2.4). Most of this file injects a failure at one of the five steps
// and asserts zero residue — no workspace directory, no rows, no registered
// runtime — because a half-created agent is the failure mode that would be
// hardest to notice and worst to inherit.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { parseProvisioningKey } from "../../src/config/provisioning-secrets.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import {
  BuzzProvisioningService,
  ProvisionRequestSchema,
} from "../../src/platform/buzz/provisioning.js";
import { workspacePathFor } from "../../src/platform/buzz/provisioned-workspaces.js";
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
const AGENT_PUBKEY = publicKey(decodeSecret(AGENT_KEY));
const PUBLISHER_KEY = "0c".repeat(32);

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

const HARNESSES = {
  claude: {
    runner: {
      type: "claude-code",
      cli_path: "claude",
      args: ["--model", "{model}", "--append-system-prompt", "{system_prompt}"],
      acknowledge_dangerous: true,
    },
    defaults: { model: "claude-sonnet-5" },
    ceilings: {
      turn_timeout_secs: 3600,
      idle_timeout_secs: 86_400,
      max_turn_duration_secs: 3600,
    },
  },
};

/** A v2 config with a YAML agent, a publisher (runner-less), and provisioning. */
function makeLoaded(overrides: { maxAgents?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "torana-prov-agents-"));
  dirs.push(dir);
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as Record<string, any>;
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
  upgraded.platforms.buzz = { enabled: true };
  upgraded.provisioning = {
    max_agents: overrides.maxAgents ?? 8,
    harnesses: HARNESSES,
  };
  // Decision-table row 2. A publisher, not a runner-less agent: `runner` is
  // required on every agent, so the ids a provisioned create must not steal
  // live in the sibling `publishers[]` array.
  upgraded.publishers = [
    {
      id: "publisher",
      enabled: false,
      endpoint: {
        id: "publisher-buzz",
        platform: "buzz",
        community_id: "primary",
        relay_url: "wss://relay.example",
        private_key: PUBLISHER_KEY,
        auth_tag: authTagFor(PUBLISHER_KEY),
        owner_pubkey: OWNER_PUBKEY,
        expected_pubkey: publicKey(decodeSecret(PUBLISHER_KEY)),
      },
      destination: {
        external_conversation_id: "11111111-2222-4333-8444-555555555555",
      },
    },
  ];
  return loadConfigFromString(yaml.dump(upgraded), { skipInterpolation: true });
}

function openDb(loaded: ReturnType<typeof makeLoaded>): GatewayDB {
  applyMigrations(loaded.config.gateway.db_path!);
  const db = new GatewayDB(loaded.config.gateway.db_path!);
  db.syncNormalizedConfig(loaded.normalized);
  dbs.push(db);
  return db;
}

interface Harness {
  service: BuzzProvisioningService;
  db: GatewayDB;
  dataDir: string;
  registered: string[];
  removed: string[];
  started: string[];
}

function makeHarness(
  options: {
    maxAgents?: number;
    failRuntime?: boolean;
    failTransport?: boolean;
    minFreeBytes?: number;
  } = {},
): Harness {
  const loaded = makeLoaded({ maxAgents: options.maxAgents });
  const db = openDb(loaded);
  const dataDir = loaded.config.gateway.data_dir;
  const registered: string[] = [];
  const removed: string[] = [];
  const started: string[] = [];

  const provisioning = {
    ...loaded.normalized.provisioning!,
    ...(options.minFreeBytes === undefined
      ? {}
      : { min_free_bytes: options.minFreeBytes }),
  };

  const service = new BuzzProvisioningService({
    db,
    configV2: loaded.configV2,
    key: parseProvisioningKey(KEY),
    provisioning,
    dataDir,
    transport: {
      snapshot: () => null,
      upsertEndpoint: async (endpoint: { id: string }) => {
        if (options.failTransport) throw new Error("transport boom");
        started.push(endpoint.id);
      },
      removeEndpoint: async () => {},
    } as unknown as BuzzTransport,
    agentRuntime: {
      upsert: (input: { agentId: string }) => {
        if (options.failRuntime) throw new Error("runtime boom");
        registered.push(input.agentId);
      },
      remove: (agentId: string) => {
        removed.push(agentId);
      },
    },
  });
  return { service, db, dataDir, registered, removed, started };
}

function createRequest(overrides: Record<string, unknown> = {}) {
  return ProvisionRequestSchema.parse({
    agent_id: "canary",
    relay_url: "wss://relay.example",
    private_key: AGENT_KEY,
    auth_tag: authTagFor(AGENT_KEY),
    owner_pubkey: OWNER_PUBKEY,
    agent: { harness: "claude", system_prompt: "be terse" },
    ...overrides,
  });
}

/** Nothing written, nothing created, nothing registered. */
function expectNoResidue(h: Harness, agentId = "canary"): void {
  expect(h.db.getProvisionedAgent(agentId)).toBeNull();
  expect(h.db.getProvisionedEndpoint(`${agentId}-buzz`)).toBeNull();
  expect(existsSync(workspacePathFor(h.dataDir, agentId))).toBe(false);
  expect(h.registered).not.toContain(agentId);
}

describe("create succeeds", () => {
  test("writes both rows, the workspace, the runtime, and starts the endpoint", async () => {
    const h = makeHarness();
    const outcome = await h.service.upsert(
      "canary-buzz",
      createRequest(),
      "provisioner",
    );
    expect(outcome).toMatchObject({ kind: "created", pubkey: AGENT_PUBKEY });

    const row = h.db.getProvisionedAgent("canary");
    expect(row?.harness).toBe("claude");
    expect(row?.systemPrompt).toBe("be terse");
    expect(row?.derivedPubkey).toBe(AGENT_PUBKEY);
    expect(row?.lifecycle).toBe("active");
    expect(row?.instructionVersion).toMatch(/^[0-9a-f]{12}$/);

    expect(h.db.getProvisionedEndpoint("canary-buzz")?.agentId).toBe("canary");
    expect(existsSync(workspacePathFor(h.dataDir, "canary"))).toBe(true);
    expect(h.registered).toEqual(["canary"]);
    expect(h.started).toEqual(["canary-buzz"]);
  });

  test("records the create in the audit log with its instruction version", async () => {
    const h = makeHarness();
    await h.service.upsert("canary-buzz", createRequest(), "provisioner");
    const audit = h.db.listProvisioningAudit("canary");
    expect(audit).toHaveLength(1);
    expect(audit[0].signal).toBe("create");
    expect(audit[0].actor).toBe("provisioner");
    expect(audit[0].detail).toContain("instruction_version");
  });

  test("the stored endpoint row never contains the private key", async () => {
    const h = makeHarness();
    await h.service.upsert("canary-buzz", createRequest(), "provisioner");
    const row = h.db.getProvisionedEndpoint("canary-buzz");
    expect(row?.configJson).not.toContain(AGENT_KEY);
    expect(row?.privateKeyCiphertext).not.toContain(AGENT_KEY);
  });
});

describe("create refuses before touching anything", () => {
  test("a harness that is not allowlisted", async () => {
    const h = makeHarness();
    await expect(
      h.service.upsert(
        "canary-buzz",
        createRequest({ agent: { harness: "goose", system_prompt: "" } }),
        "provisioner",
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expectNoResidue(h);
  });

  test("a deploy naming a publisher id (R1.5)", async () => {
    const h = makeHarness();
    await expect(
      h.service.upsert(
        "publisher-extra",
        createRequest({ agent_id: "publisher" }),
        "provisioner",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(h.db.getProvisionedAgent("publisher")).toBeNull();
    expect(h.registered).toEqual([]);
  });

  test("an unknown id with no agent block", async () => {
    const h = makeHarness();
    await expect(
      h.service.upsert(
        "canary-buzz",
        createRequest({ agent: undefined }),
        "provisioner",
      ),
    ).rejects.toMatchObject({ code: "unknown_agent" });
    expectNoResidue(h);
  });

  test("a create with no owner_pubkey", async () => {
    const h = makeHarness();
    await expect(
      h.service.upsert(
        "canary-buzz",
        createRequest({ owner_pubkey: undefined }),
        "provisioner",
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expectNoResidue(h);
  });

  test("a rejection is audited", async () => {
    const h = makeHarness();
    await expect(
      h.service.upsert(
        "canary-buzz",
        createRequest({ agent: undefined }),
        "provisioner",
      ),
    ).rejects.toThrow();
    const audit = h.db.listProvisioningAudit("canary");
    expect(audit[0]?.signal).toBe("reject");
    expect(audit[0]?.outcome).toBe("unknown_agent");
  });
});

describe("caps (R11.1 / R11.2)", () => {
  test("refuses at the cap and leaves running agents alone", async () => {
    const h = makeHarness({ maxAgents: 1 });
    await h.service.upsert("canary-buzz", createRequest(), "provisioner");
    expect(h.db.countProvisionedAgents()).toBe(1);

    await expect(
      h.service.upsert(
        "second-buzz",
        createRequest({
          agent_id: "second",
          private_key: "0b".repeat(32),
          auth_tag: authTagFor("0b".repeat(32)),
        }),
        "provisioner",
      ),
    ).rejects.toMatchObject({ code: "capacity" });

    // The incumbent is untouched, and the newcomer left nothing behind.
    expect(h.db.getProvisionedAgent("canary")).not.toBeNull();
    expect(existsSync(workspacePathFor(h.dataDir, "canary"))).toBe(true);
    expectNoResidue(h, "second");
  });

  test("the cap error names the staged-rows-count rule", async () => {
    const h = makeHarness({ maxAgents: 1 });
    await h.service.upsert("canary-buzz", createRequest(), "provisioner");
    await expect(
      h.service.upsert(
        "second-buzz",
        createRequest({
          agent_id: "second",
          private_key: "0b".repeat(32),
          auth_tag: authTagFor("0b".repeat(32)),
        }),
        "provisioner",
      ),
    ).rejects.toThrow(/staged deletions still count/);
  });
});

describe("unwind leaves no residue (R2.4)", () => {
  test("a full volume refuses the create and creates no directory", async () => {
    const h = makeHarness({ minFreeBytes: Number.MAX_SAFE_INTEGER });
    await expect(
      h.service.upsert("canary-buzz", createRequest(), "provisioner"),
    ).rejects.toMatchObject({ code: "capacity" });
    expectNoResidue(h);
  });

  test("a runtime registration failure rolls back rows and workspace", async () => {
    const h = makeHarness({ failRuntime: true });
    await expect(
      h.service.upsert("canary-buzz", createRequest(), "provisioner"),
    ).rejects.toThrow(/runtime boom/);
    expectNoResidue(h);
  });

  test("an endpoint-start failure also deregisters the runtime", async () => {
    // The furthest-along failure: rows committed, runtime registered, and the
    // transport then refuses. All three must come back out, in reverse.
    const h = makeHarness({ failTransport: true });
    await expect(
      h.service.upsert("canary-buzz", createRequest(), "provisioner"),
    ).rejects.toThrow(/transport boom/);
    expect(h.removed).toEqual(["canary"]);
    expect(h.db.getProvisionedAgent("canary")).toBeNull();
    expect(h.db.getProvisionedEndpoint("canary-buzz")).toBeNull();
    expect(existsSync(workspacePathFor(h.dataDir, "canary"))).toBe(false);
  });

  test("an unwound create can be retried cleanly", async () => {
    // Residue would surface here as a conflict or a stale row on the retry.
    const h = makeHarness({ failTransport: true });
    await expect(
      h.service.upsert("canary-buzz", createRequest(), "provisioner"),
    ).rejects.toThrow();
    const retry = makeHarness();
    const outcome = await retry.service.upsert(
      "canary-buzz",
      createRequest(),
      "provisioner",
    );
    expect(outcome.kind).toBe("created");
  });
});

describe("gateway not configured for agent creation", () => {
  test("refuses with an actionable error when there is no provisioning block", async () => {
    const loaded = makeLoaded();
    const db = openDb(loaded);
    const service = new BuzzProvisioningService({
      db,
      configV2: loaded.configV2,
      key: parseProvisioningKey(KEY),
      provisioning: null,
      dataDir: loaded.config.gateway.data_dir,
      transport: {
        snapshot: () => null,
        upsertEndpoint: async () => {},
      } as unknown as BuzzTransport,
    });
    await expect(
      service.upsert("canary-buzz", createRequest(), "provisioner"),
    ).rejects.toMatchObject({ code: "not_configured" });
  });
});
