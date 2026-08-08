// US-033 — applying instruction changes to a running Desktop-managed agent.
//
// Two properties carry this phase, and they pull in opposite directions:
//
//   1. A real change must reach the agent (R3.2/R3.3) — otherwise editing
//      instructions in the Desktop does nothing and G2 is unmet.
//   2. A reconcile must not (R2.2) — the Desktop redeploys every
//      provider-backed agent on each community UI load, so an over-eager diff
//      recycles every session of every agent every time somebody opens a
//      window.
//
// The instruction *version* is what separates them: it hashes applied values,
// so two deploys that resolve to the same running configuration are equal even
// when their raw payloads differ.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import { AgentTimeoutRegistry } from "../../src/platform/buzz/agent-timeouts.js";
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

interface Harness {
  service: BuzzProvisioningService;
  db: GatewayDB;
  recycles: Array<{ agentId: string; reason: string }>;
  registrations: string[];
  timeouts: AgentTimeoutRegistry;
  connected: { value: boolean };
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "torana-instr-"));
  dirs.push(dir);
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as Record<string, any>;
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
  upgraded.platforms.buzz = { enabled: true };
  upgraded.provisioning = {
    harnesses: {
      claude: {
        runner: {
          type: "claude-code",
          cli_path: "claude",
          args: [
            "--model",
            "{model}",
            "--append-system-prompt",
            "{system_prompt}",
          ],
          acknowledge_dangerous: true,
        },
        defaults: { model: "claude-sonnet-5" },
        ceilings: {
          turn_timeout_secs: 3600,
          idle_timeout_secs: 86_400,
          max_turn_duration_secs: 3600,
        },
      },
    },
  };
  const loaded = loadConfigFromString(yaml.dump(upgraded), {
    skipInterpolation: true,
  });
  applyMigrations(loaded.config.gateway.db_path!);
  const db = new GatewayDB(loaded.config.gateway.db_path!);
  db.syncNormalizedConfig(loaded.normalized);
  dbs.push(db);

  const recycles: Array<{ agentId: string; reason: string }> = [];
  const registrations: string[] = [];
  const timeouts = new AgentTimeoutRegistry();
  const connected = { value: true };

  const service = new BuzzProvisioningService({
    db,
    configV2: loaded.configV2,
    key: parseProvisioningKey(KEY),
    provisioning: loaded.normalized.provisioning,
    dataDir: dir,
    agentTimeouts: timeouts,
    recycleSessions: (agentId, reason) => {
      recycles.push({ agentId, reason });
      return 2; // pretend two resident sessions were retired
    },
    transport: {
      // A healthy, connected endpoint: the state in which `unchanged` is
      // allowed to short-circuit.
      snapshot: () => ({ connected: connected.value }),
      upsertEndpoint: async () => {},
      removeEndpoint: async () => {},
    } as unknown as BuzzTransport,
    agentRuntime: {
      upsert: (input: { agentId: string }) => {
        registrations.push(input.agentId);
      },
      remove: () => {},
    },
  });
  return { service, db, recycles, registrations, timeouts, connected };
}

function request(agentOverrides: Record<string, unknown> = {}) {
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
      ...agentOverrides,
    },
  });
}

async function create(h: Harness) {
  await h.service.upsert("canary-buzz", request(), "provisioner");
  // Ignore the create's own registration; the tests below care about updates.
  h.registrations.length = 0;
  h.recycles.length = 0;
}

describe("a real instruction change is applied", () => {
  test("the row, the version, and the runtime all move", async () => {
    const h = makeHarness();
    await create(h);
    const before = h.db.getProvisionedAgent("canary")!.instructionVersion;

    const outcome = await h.service.upsert(
      "canary-buzz",
      request({ system_prompt: "be verbose" }),
      "provisioner",
    );

    const after = h.db.getProvisionedAgent("canary")!;
    expect(after.systemPrompt).toBe("be verbose");
    expect(after.instructionVersion).not.toBe(before);
    // Re-registered, so the next spawn reads the new projection rather than
    // the one we just replaced.
    expect(h.registrations).toEqual(["canary"]);
    // And it is not reported as a no-op.
    expect(outcome.kind).not.toBe("unchanged");
  });

  test("live sessions are recycled, and the reason names both versions", async () => {
    const h = makeHarness();
    await create(h);
    const before = h.db.getProvisionedAgent("canary")!.instructionVersion;
    await h.service.upsert(
      "canary-buzz",
      request({ system_prompt: "be verbose" }),
      "provisioner",
    );
    expect(h.recycles).toHaveLength(1);
    expect(h.recycles[0].agentId).toBe("canary");
    expect(h.recycles[0].reason).toContain(before);
  });

  test("the applied timeouts are refreshed alongside the instructions", async () => {
    const h = makeHarness();
    await create(h);
    await h.service.upsert(
      "canary-buzz",
      request({ turn_timeout_seconds: 120 }),
      "provisioner",
    );
    expect(h.timeouts.get("canary")?.turnTimeoutSecs).toBe(120);
  });

  test("a model change alone is a real change", async () => {
    const h = makeHarness();
    await create(h);
    await h.service.upsert(
      "canary-buzz",
      request({ model: "claude-opus-5" }),
      "provisioner",
    );
    expect(h.db.getProvisionedAgent("canary")?.model).toBe("claude-opus-5");
    expect(h.recycles).toHaveLength(1);
  });

  test("the change is audited with both versions and the recycle count", async () => {
    const h = makeHarness();
    await create(h);
    await h.service.upsert(
      "canary-buzz",
      request({ system_prompt: "be verbose" }),
      "provisioner",
    );
    const audit = h.db.listProvisioningAudit("canary");
    const update = audit.find((row) => row.signal === "update");
    expect(update?.outcome).toBe("instructions_applied");
    expect(update?.detail).toContain("old_version");
    expect(update?.detail).toContain("new_version");
    expect(update?.detail).toContain('"sessions_recycled":2');
  });
});

describe("a reconcile deploy changes nothing (R2.2)", () => {
  test("an identical redeploy recycles nothing and re-registers nothing", async () => {
    // The common case: fires on every community UI load.
    const h = makeHarness();
    await create(h);
    const before = h.db.getProvisionedAgent("canary")!;

    const outcome = await h.service.upsert(
      "canary-buzz",
      request(),
      "provisioner",
    );

    expect(outcome.kind).toBe("unchanged");
    expect(h.recycles).toEqual([]);
    expect(h.registrations).toEqual([]);
    const after = h.db.getProvisionedAgent("canary")!;
    expect(after.instructionVersion).toBe(before.instructionVersion);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  test("ten reconciles in a row are still ten no-ops", async () => {
    // Guards against a diff that is stable per-call but drifts across calls,
    // which would look fine in a single-shot test and churn in production.
    const h = makeHarness();
    await create(h);
    for (let i = 0; i < 10; i += 1) {
      await h.service.upsert("canary-buzz", request(), "provisioner");
    }
    expect(h.recycles).toEqual([]);
  });

  test("a request differing only in a clamped excess is not a change", async () => {
    // 99999 and 50000 both clamp to the 3600s ceiling, so the agent is running
    // identical instructions either way.
    const h = makeHarness();
    await h.service.upsert(
      "canary-buzz",
      request({ turn_timeout_seconds: 99_999 }),
      "provisioner",
    );
    h.recycles.length = 0;
    await h.service.upsert(
      "canary-buzz",
      request({ turn_timeout_seconds: 50_000 }),
      "provisioner",
    );
    expect(h.recycles).toEqual([]);
  });

  test("a deploy carrying no agent block never touches instructions", async () => {
    // An older provider, or an endpoint-only deploy.
    const h = makeHarness();
    await create(h);
    const before = h.db.getProvisionedAgent("canary")!.instructionVersion;
    await h.service.upsert(
      "canary-buzz",
      ProvisionRequestSchema.parse({
        agent_id: "canary",
        relay_url: "wss://relay.example",
        private_key: AGENT_KEY,
        auth_tag: authTagFor(AGENT_KEY),
        owner_pubkey: OWNER_PUBKEY,
      }),
      "provisioner",
    );
    expect(h.db.getProvisionedAgent("canary")!.instructionVersion).toBe(before);
    expect(h.recycles).toEqual([]);
  });
});

describe("refusals during an update", () => {
  test("an unknown harness is refused and the row is left intact", async () => {
    const h = makeHarness();
    await create(h);
    const before = h.db.getProvisionedAgent("canary")!;
    await expect(
      h.service.upsert(
        "canary-buzz",
        request({ harness: "goose" }),
        "provisioner",
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const after = h.db.getProvisionedAgent("canary")!;
    expect(after.harness).toBe(before.harness);
    expect(after.instructionVersion).toBe(before.instructionVersion);
    expect(h.recycles).toEqual([]);
  });

  test("an oversized prompt is refused before anything is recycled", async () => {
    const h = makeHarness();
    await create(h);
    await expect(
      h.service.upsert(
        "canary-buzz",
        request({ system_prompt: "x".repeat(70_000) }),
        "provisioner",
      ),
    ).rejects.toThrow(/prompt/);
    expect(h.recycles).toEqual([]);
    expect(h.db.getProvisionedAgent("canary")!.systemPrompt).toBe("be terse");
  });
});
