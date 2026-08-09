// US-034 — the staged-delete machine: stage, restore, purge, report.
//
// The properties this file defends, in order of how bad it is to get them
// wrong: nothing is destroyed before its persisted deadline; the deadline
// survives a restart; the purge audit record is committed before destruction
// and outlives the agent; and a purge interrupted anywhere converges when the
// sweep re-runs rather than wedging on the half it finished.

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

import type { AlertManager } from "../../src/alerts.js";
import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import {
  parseProvisioningKey,
  singleKeyring,
} from "../../src/config/provisioning-secrets.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import {
  AUDIT_SIGNAL,
  BuzzAgentLifecycleService,
  sqlTimestamp,
} from "../../src/platform/buzz/agent-lifecycle.js";
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
const GRACE_HOURS = 72;
const HOUR_MS = 3_600_000;

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

function makeLoaded(dir: string) {
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as Record<string, any>;
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
  upgraded.platforms.buzz = { enabled: true };
  upgraded.provisioning = {
    max_agents: 8,
    delete_grace_hours: GRACE_HOURS,
    harnesses: HARNESSES,
  };
  return loadConfigFromString(yaml.dump(upgraded), { skipInterpolation: true });
}

interface Harness {
  db: GatewayDB;
  dataDir: string;
  lifecycle: BuzzAgentLifecycleService;
  provisioning: BuzzProvisioningService;
  drained: Array<{ endpointId: string; reason: string }>;
  removedEndpoints: string[];
  deregistered: string[];
  alerts: Array<{ agentId: string; deadline: string; fanout: number }>;
  clock: { now: number };
  fleetChanges: number;
  reopen: () => Harness;
}

function makeHarness(
  options: { dir?: string; failEndpointRemoval?: boolean } = {},
): Harness {
  const dir =
    options.dir ??
    (() => {
      const made = mkdtempSync(join(tmpdir(), "torana-delete-"));
      dirs.push(made);
      return made;
    })();
  const loaded = makeLoaded(dir);
  applyMigrations(loaded.config.gateway.db_path!);
  const db = new GatewayDB(loaded.config.gateway.db_path!);
  db.syncNormalizedConfig(loaded.normalized);
  dbs.push(db);

  const drained: Array<{ endpointId: string; reason: string }> = [];
  const removedEndpoints: string[] = [];
  const deregistered: string[] = [];
  const alertsSeen: Array<{
    agentId: string;
    deadline: string;
    fanout: number;
  }> = [];
  const clock = { now: Date.parse("2026-08-09T00:00:00Z") };
  const state = { fleetChanges: 0 };
  const adapters = new Map<string, unknown>();

  const transport = {
    snapshot: () => null,
    upsertEndpoint: async () => {},
    drainEndpoint: async (endpointId: string, reason: string) => {
      drained.push({ endpointId, reason });
      return true;
    },
    removeEndpoint: async (endpointId: string) => {
      if (options.failEndpointRemoval) throw new Error("transport is wedged");
      removedEndpoints.push(endpointId);
      return true;
    },
  } as unknown as BuzzTransport;

  const provisioning = new BuzzProvisioningService({
    db,
    configV2: loaded.configV2,
    keyring: singleKeyring(parseProvisioningKey(KEY)),
    provisioning: loaded.normalized.provisioning!,
    dataDir: dir,
    transport,
    agentRuntime: {
      upsert: (input: { endpointId: string; endpoint?: unknown }) => {
        if (!adapters.has(input.endpointId) && input.endpoint) {
          adapters.set(input.endpointId, input.endpoint);
        }
      },
      remove: () => {},
    },
  });

  const lifecycle = new BuzzAgentLifecycleService({
    db,
    dataDir: dir,
    provisioning: loaded.normalized.provisioning!,
    transport: () => transport,
    alerts: {
      agentStagedForDeletion: async (
        agentId: string,
        deadline: string,
        fanout: number,
      ) => {
        alertsSeen.push({ agentId, deadline, fanout });
      },
    } as unknown as AlertManager,
    agentRuntime: {
      remove: (agentId: string) => {
        deregistered.push(agentId);
        return true;
      },
    },
    onFleetChanged: () => {
      state.fleetChanges += 1;
    },
    now: () => clock.now,
  });

  const harness: Harness = {
    db,
    dataDir: dir,
    lifecycle,
    provisioning,
    drained,
    removedEndpoints,
    deregistered,
    alerts: alertsSeen,
    clock,
    get fleetChanges() {
      return state.fleetChanges;
    },
    // A second gateway process over the same volume — the only honest way to
    // test "survives restart, redeploy, and container replacement".
    reopen: () => makeHarness({ dir }),
  };
  return harness;
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

async function withAgent(
  options: { failEndpointRemoval?: boolean } = {},
): Promise<Harness> {
  const h = makeHarness(options);
  await h.provisioning.upsert("canary-buzz", createRequest(), "provisioner");
  return h;
}

describe("staging", () => {
  test("drains, announces offline, disables the endpoint, and persists a deadline", async () => {
    const h = await withAgent();
    const result = await h.lifecycle.stage("canary", {
      kind: "tombstone",
      eventId: "e".repeat(64),
      ownerPubkey: OWNER_PUBKEY,
      relayUrl: "wss://relay.example",
    });

    expect(result.kind).toBe("staged");
    expect(h.drained).toEqual([
      { endpointId: "canary-buzz", reason: "staged_delete" },
    ]);
    const endpoint = h.db.getEndpointState("canary-buzz");
    expect(endpoint?.lifecycleState).toBe("disabled");
    expect(endpoint?.stateReason).toBe("staged_delete");

    const row = h.db.getProvisionedAgent("canary");
    expect(row?.lifecycle).toBe("staged_delete");
    expect(row?.stagedAt).toBe(sqlTimestamp(h.clock.now));
    expect(row?.purgeDeadline).toBe(
      sqlTimestamp(h.clock.now + GRACE_HOURS * HOUR_MS),
    );
  });

  test("keeps the workspace and the sealed secrets — stopping is not deleting", async () => {
    const h = await withAgent();
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    expect(existsSync(workspacePathFor(h.dataDir, "canary"))).toBe(true);
    expect(h.db.getProvisionedEndpoint("canary-buzz")).not.toBeNull();
  });

  test("audits the staging tombstone so the purge record can name it", async () => {
    const h = await withAgent();
    await h.lifecycle.stage("canary", {
      kind: "tombstone",
      eventId: "ab".repeat(32),
      ownerPubkey: OWNER_PUBKEY,
      relayUrl: "wss://relay.example",
    });
    const entry = h.db
      .listProvisioningAudit("canary")
      .find((row) => row.signal === AUDIT_SIGNAL.stage);
    expect(entry?.actor).toBe("relay-tombstone");
    expect(JSON.parse(entry!.detail!)).toMatchObject({
      event_id: "ab".repeat(32),
      relay_url: "wss://relay.example",
    });
  });

  test("alerts the operator, because a reversible window nobody sees is not reversible", async () => {
    const h = await withAgent();
    await h.lifecycle.stage("canary", { kind: "operator", via: "cli" });
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ agentId: "canary", fanout: 1 });
  });

  test("a redelivered tombstone does not extend the grace window", async () => {
    const h = await withAgent();
    const first = await h.lifecycle.stage("canary", {
      kind: "operator",
      via: "api",
    });
    h.clock.now += 60_000;
    const second = await h.lifecycle.stage("canary", {
      kind: "operator",
      via: "api",
    });
    expect(second.kind).toBe("already_staged");
    expect(h.db.getProvisionedAgent("canary")?.purgeDeadline).toBe(
      first.purgeDeadline,
    );
    expect(h.alerts).toHaveLength(1);
  });

  test("an unknown agent stages nothing", async () => {
    const h = await withAgent();
    expect(
      (await h.lifecycle.stage("ghost", { kind: "operator", via: "api" })).kind,
    ).toBe("unknown_agent");
  });

  test("a persona cascade escalates: three stages in one window report fanout 3", async () => {
    const h = await withAgent();
    for (const id of ["beta", "gamma"]) {
      await h.provisioning.upsert(
        `${id}-buzz`,
        createRequest({
          agent_id: id,
          private_key: id === "beta" ? "0b".repeat(32) : "0c".repeat(32),
          auth_tag: authTagFor(
            id === "beta" ? "0b".repeat(32) : "0c".repeat(32),
          ),
        }),
        "provisioner",
      );
    }
    for (const id of ["canary", "beta", "gamma"]) {
      await h.lifecycle.stage(id, {
        kind: "tombstone",
        eventId: id.padEnd(64, "0"),
        ownerPubkey: OWNER_PUBKEY,
        relayUrl: "wss://relay.example",
      });
      h.clock.now += 200;
    }
    expect(h.alerts.map((alert) => alert.fanout)).toEqual([1, 2, 3]);
    // All three are still staged, not purged: the cascade is *reported*, never
    // acted on faster.
    for (const id of ["canary", "beta", "gamma"]) {
      expect(h.db.getProvisionedAgent(id)?.lifecycle).toBe("staged_delete");
    }
  });

  test("stages spread beyond the window are counted separately", async () => {
    const h = await withAgent();
    await h.provisioning.upsert(
      "beta-buzz",
      createRequest({
        agent_id: "beta",
        private_key: "0b".repeat(32),
        auth_tag: authTagFor("0b".repeat(32)),
      }),
      "provisioner",
    );
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    h.clock.now += 60_000;
    await h.lifecycle.stage("beta", { kind: "operator", via: "api" });
    expect(h.alerts.map((alert) => alert.fanout)).toEqual([1, 1]);
  });
});

describe("staged state is durable", () => {
  test("survives a restart mid-grace with exactly the same deadline", async () => {
    const first = await withAgent();
    await first.lifecycle.stage("canary", { kind: "operator", via: "api" });
    const deadline = first.db.getProvisionedAgent("canary")!.purgeDeadline;
    first.db.close();
    dbs.splice(dbs.indexOf(first.db), 1);

    const second = first.reopen();
    const row = second.db.getProvisionedAgent("canary");
    expect(row?.lifecycle).toBe("staged_delete");
    expect(row?.purgeDeadline).toBe(deadline);
    // And a restart inside the window purges nothing.
    second.clock.now = Date.parse("2026-08-09T00:00:00Z") + HOUR_MS;
    expect(await second.lifecycle.sweepPurges()).toEqual([]);
    expect(second.db.getProvisionedAgent("canary")).not.toBeNull();
  });

  test("an ordinary row update cannot silently clear the staging columns", async () => {
    // The instruction-update path writes this row on every real diff. If it
    // touched `lifecycle`, a routine reconcile deploy would cancel a pending
    // deletion without anybody deciding to.
    const h = await withAgent();
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    const before = h.db.getProvisionedAgent("canary")!;
    h.db.upsertProvisionedAgent({
      agentId: "canary",
      derivedPubkey: before.derivedPubkey,
      harness: before.harness,
      systemPrompt: "rewritten",
      model: null,
      timeoutsJson: before.timeoutsJson,
      instructionVersion: "ffffffffffff",
      provisionedBy: "provisioner",
    });
    const after = h.db.getProvisionedAgent("canary")!;
    expect(after.systemPrompt).toBe("rewritten");
    expect(after.lifecycle).toBe("staged_delete");
    expect(after.purgeDeadline).toBe(before.purgeDeadline);
  });

  test("a restart does not bring a staged endpoint back online", async () => {
    const first = await withAgent();
    await first.lifecycle.stage("canary", { kind: "operator", via: "api" });
    first.db.close();
    dbs.splice(dbs.indexOf(first.db), 1);

    const second = first.reopen();
    // The restore path rebuilds every provisioned endpoint at boot. It must not
    // clear the terminal state staging wrote, or the agent would come back
    // online mid-grace and answer messages its owner has already deleted.
    const restored = second.provisioning.loadPersisted();
    expect(restored.errors).toEqual([]);
    expect(second.db.getEndpointState("canary-buzz")).toMatchObject({
      lifecycleState: "disabled",
      stateReason: "staged_delete",
    });
  });

  test("a deploy for a different agent stages nothing (R5.3 anti-reaping)", async () => {
    // Absence from a reconcile set means nothing. The Desktop redeploys
    // provider-backed agents on every community UI load, and a fleet that
    // shrinks between two of those loads is not evidence of a deletion.
    const h = await withAgent();
    await h.provisioning.upsert(
      "beta-buzz",
      createRequest({
        agent_id: "beta",
        private_key: "0b".repeat(32),
        auth_tag: authTagFor("0b".repeat(32)),
      }),
      "provisioner",
    );
    // Reconcile `beta` repeatedly; `canary` never appears in any of them.
    for (let i = 0; i < 3; i += 1) {
      await h.provisioning.upsert(
        "beta-buzz",
        createRequest({
          agent_id: "beta",
          private_key: "0b".repeat(32),
          auth_tag: authTagFor("0b".repeat(32)),
        }),
        "provisioner",
      );
      h.clock.now += HOUR_MS;
    }
    expect(h.db.getProvisionedAgent("canary")?.lifecycle).toBe("active");
    expect(h.alerts).toEqual([]);
    expect(await h.lifecycle.sweepPurges()).toEqual([]);
  });

  test("a deploy of the same identity un-stages loudly, through the audit log", async () => {
    // Decision-table row 7: a deploy is fresh owner intent. The point of this
    // test is that it is never *silent* — the reversal is auditable.
    const h = await withAgent();
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    await h.provisioning.upsert("canary-buzz", createRequest(), "provisioner");

    const row = h.db.getProvisionedAgent("canary");
    expect(row?.lifecycle).toBe("active");
    expect(row?.purgeDeadline).toBeNull();
    expect(
      h.db
        .listProvisioningAudit("canary")
        .some(
          (entry) =>
            entry.signal === "restore" &&
            entry.outcome === "unstaged_by_deploy",
        ),
    ).toBe(true);
  });
});

describe("restore", () => {
  test("returns a staged agent to active and clears both staging columns", async () => {
    const h = await withAgent();
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    expect(h.lifecycle.restore("canary", "operator-cli")).toBe("restored");
    const row = h.db.getProvisionedAgent("canary")!;
    expect(row.lifecycle).toBe("active");
    expect(row.stagedAt).toBeNull();
    expect(row.purgeDeadline).toBeNull();
  });

  test("a restored agent is no longer due for purge, whatever the clock says", async () => {
    const h = await withAgent();
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    h.lifecycle.restore("canary", "operator-cli");
    h.clock.now += (GRACE_HOURS + 1) * HOUR_MS;
    expect(await h.lifecycle.sweepPurges()).toEqual([]);
    expect(h.db.getProvisionedAgent("canary")).not.toBeNull();
  });

  test("refuses an agent that is not staged, and an unknown one", async () => {
    const h = await withAgent();
    expect(h.lifecycle.restore("canary", "operator-cli")).toBe("not_staged");
    expect(h.lifecycle.restore("ghost", "operator-cli")).toBe("unknown_agent");
  });

  test("records the deadline it cancelled", async () => {
    const h = await withAgent();
    const staged = await h.lifecycle.stage("canary", {
      kind: "operator",
      via: "api",
    });
    h.lifecycle.restore("canary", "operator-cli");
    const entry = h.db
      .listProvisioningAudit("canary")
      .find((row) => row.signal === AUDIT_SIGNAL.restore);
    expect(JSON.parse(entry!.detail!)).toMatchObject({
      cancelled_purge_deadline: staged.purgeDeadline,
    });
  });
});

describe("purge", () => {
  test("destroys nothing before the deadline", async () => {
    const h = await withAgent();
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    h.clock.now += (GRACE_HOURS - 1) * HOUR_MS;
    expect(await h.lifecycle.sweepPurges()).toEqual([]);
    expect(h.db.getProvisionedAgent("canary")).not.toBeNull();
    expect(existsSync(workspacePathFor(h.dataDir, "canary"))).toBe(true);
  });

  test("removes row, endpoint, and workspace once the deadline passes", async () => {
    const h = await withAgent();
    writeFileSync(join(workspacePathFor(h.dataDir, "canary"), "notes.md"), "x");
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    h.clock.now += (GRACE_HOURS + 1) * HOUR_MS;

    const [result] = await h.lifecycle.sweepPurges();
    expect(result).toMatchObject({ agentId: "canary", destroyed: true });
    expect(h.db.getProvisionedAgent("canary")).toBeNull();
    expect(h.db.getProvisionedEndpoint("canary-buzz")).toBeNull();
    expect(existsSync(workspacePathFor(h.dataDir, "canary"))).toBe(false);
    expect(h.removedEndpoints).toContain("canary-buzz");
    expect(h.deregistered).toContain("canary");
  });

  test("the purge record is written before destruction and outlives the agent", async () => {
    const h = await withAgent();
    writeFileSync(
      join(workspacePathFor(h.dataDir, "canary"), "notes.md"),
      "0123456789",
    );
    await h.lifecycle.stage("canary", {
      kind: "tombstone",
      eventId: "cd".repeat(32),
      ownerPubkey: OWNER_PUBKEY,
      relayUrl: "wss://relay.example",
    });
    h.clock.now += (GRACE_HOURS + 1) * HOUR_MS;
    await h.lifecycle.sweepPurges();

    const entry = h.db
      .listProvisioningAudit("canary")
      .find((row) => row.signal === AUDIT_SIGNAL.purge);
    expect(entry).toBeDefined();
    const detail = JSON.parse(entry!.detail!);
    expect(detail).toMatchObject({
      endpoint_id: "canary-buzz",
      harness: "claude",
      staging_event_id: "cd".repeat(32),
      workspace_path: workspacePathFor(h.dataDir, "canary"),
    });
    expect(detail.workspace_bytes).toBe(10);
    expect(detail.pubkey).toBe(publicKey(decodeSecret(AGENT_KEY)));
  });

  test("a purge record exists even when destruction itself fails", async () => {
    // Audit-first is not a nicety: a transport that refuses to release the
    // endpoint must not also cost us the evidence of what we tried to destroy.
    const h = await withAgent({ failEndpointRemoval: true });
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    h.clock.now += (GRACE_HOURS + 1) * HOUR_MS;
    await h.lifecycle.sweepPurges();
    expect(
      h.db
        .listProvisioningAudit("canary")
        .some((row) => row.signal === AUDIT_SIGNAL.purge),
    ).toBe(true);
    // And the rows still went, because the endpoint failure is not a reason to
    // leave a half-deleted agent behind.
    expect(h.db.getProvisionedAgent("canary")).toBeNull();
  });

  test("converges after a crash mid-purge: workspace gone, rows still present", async () => {
    const h = await withAgent();
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    h.clock.now += (GRACE_HOURS + 1) * HOUR_MS;
    // Simulate a process that died after removing the workspace.
    rmSync(workspacePathFor(h.dataDir, "canary"), {
      recursive: true,
      force: true,
    });

    const [result] = await h.lifecycle.sweepPurges();
    expect(result?.destroyed).toBe(true);
    expect(result?.workspaceRemoved).toBe(false);
    expect(h.db.getProvisionedAgent("canary")).toBeNull();
  });

  test("re-running the sweep on an already-purged agent is a clean no-op", async () => {
    const h = await withAgent();
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    h.clock.now += (GRACE_HOURS + 1) * HOUR_MS;
    await h.lifecycle.sweepPurges();
    expect(await h.lifecycle.sweepPurges()).toEqual([]);
    expect(await h.lifecycle.purge("canary", "test")).toMatchObject({
      destroyed: false,
    });
  });

  test("purges an agent whose endpoint was already removed by the manual hatch", async () => {
    // R5.7: `DELETE /v1/admin/buzz/endpoints/:id` stays available, and using it
    // mid-grace must not wedge the sweep on a missing row.
    const h = await withAgent();
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    await h.provisioning.remove("canary-buzz");
    h.clock.now += (GRACE_HOURS + 1) * HOUR_MS;

    const [result] = await h.lifecycle.sweepPurges();
    expect(result?.destroyed).toBe(true);
    expect(h.db.getProvisionedAgent("canary")).toBeNull();
    expect(existsSync(workspacePathFor(h.dataDir, "canary"))).toBe(false);
  });

  test("only the agent past its deadline is destroyed", async () => {
    const h = await withAgent();
    await h.provisioning.upsert(
      "beta-buzz",
      createRequest({
        agent_id: "beta",
        private_key: "0b".repeat(32),
        auth_tag: authTagFor("0b".repeat(32)),
      }),
      "provisioner",
    );
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    h.clock.now += 2 * HOUR_MS;
    await h.lifecycle.stage("beta", { kind: "operator", via: "api" });
    h.clock.now += (GRACE_HOURS + 1) * HOUR_MS - 2 * HOUR_MS;

    const results = await h.lifecycle.sweepPurges();
    expect(results.map((item) => item.agentId)).toEqual(["canary"]);
    expect(h.db.getProvisionedAgent("beta")?.lifecycle).toBe("staged_delete");
  });

  test("an active agent is never swept, however old it is", async () => {
    // D2: no TTL, no idle timer, no age heuristic. Only a persisted deadline.
    const h = await withAgent();
    h.clock.now += 365 * 24 * HOUR_MS;
    expect(await h.lifecycle.sweepPurges()).toEqual([]);
    expect(h.db.getProvisionedAgent("canary")).not.toBeNull();
  });
});

describe("expedite (the operator hatch)", () => {
  test("brings a staged deadline forward to now", async () => {
    const h = await withAgent();
    await h.lifecycle.stage("canary", { kind: "operator", via: "cli" });
    expect(h.lifecycle.expedite("canary", "operator-cli")).toBe("scheduled");
    expect(h.db.getProvisionedAgent("canary")?.purgeDeadline).toBe(
      sqlTimestamp(h.clock.now),
    );
    expect((await h.lifecycle.sweepPurges()).map((r) => r.agentId)).toEqual([
      "canary",
    ]);
  });

  test("stages an active agent with an immediate deadline", async () => {
    const h = await withAgent();
    expect(h.lifecycle.expedite("canary", "operator-cli")).toBe("scheduled");
    const row = h.db.getProvisionedAgent("canary")!;
    expect(row.lifecycle).toBe("staged_delete");
    expect(row.purgeDeadline).toBe(sqlTimestamp(h.clock.now));
  });

  test("refuses an unknown agent", async () => {
    const h = await withAgent();
    expect(h.lifecycle.expedite("ghost", "operator-cli")).toBe("unknown_agent");
  });
});

describe("reconciliation report", () => {
  test("is advisory: computing it destroys nothing and stages nothing", async () => {
    const h = await withAgent();
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    h.clock.now += (GRACE_HOURS + 10) * HOUR_MS;
    const report = await h.lifecycle.reconciliationReport();
    expect(report.agents).toHaveLength(1);
    // Well past the deadline, and the report still purged nothing.
    expect(h.db.getProvisionedAgent("canary")).not.toBeNull();
    expect(existsSync(workspacePathFor(h.dataDir, "canary"))).toBe(true);
  });

  test("carries lifecycle, deadline, endpoint state, and the record coordinate", async () => {
    const h = await withAgent();
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    const report = await h.lifecycle.reconciliationReport();
    expect(report.agents[0]).toMatchObject({
      agentId: "canary",
      lifecycle: "staged_delete",
      endpointId: "canary-buzz",
      endpointState: "disabled",
      ownerPubkey: OWNER_PUBKEY,
      relayUrl: "wss://relay.example",
      recordState: "unknown",
    });
    expect(report.agents[0]!.coordinate).toBe(
      `30177:${OWNER_PUBKEY}:${publicKey(decodeSecret(AGENT_KEY))}`,
    );
  });

  test("an unreachable relay leaves record states unknown, never absent", async () => {
    const h = await withAgent();
    const report = await h.lifecycle.reconciliationReport();
    expect(report.recordProbe).toBe("unavailable");
    expect(report.agents[0]!.recordState).toBe("unknown");
  });

  test("lists rejected tombstones, and they survive a restart", async () => {
    const first = await withAgent();
    first.lifecycle.recordRejectedTombstone({
      reason: "unmatched_pubkey",
      eventId: "ee".repeat(32),
      agentPubkey: "ab".repeat(32),
      ownerPubkey: OWNER_PUBKEY,
      relayUrl: "wss://relay.example",
      message: "no provisioned agent has that identity",
    });
    first.db.close();
    dbs.splice(dbs.indexOf(first.db), 1);

    const second = first.reopen();
    const report = await second.lifecycle.reconciliationReport();
    expect(report.rejectedTombstones).toHaveLength(1);
    expect(report.rejectedTombstones[0]).toMatchObject({
      reason: "unmatched_pubkey",
      eventId: "ee".repeat(32),
      relayUrl: "wss://relay.example",
    });
  });
});

describe("watch targets derived from live rows", () => {
  test("carry the relay, the owner, and a key that opens to the agent identity", async () => {
    const h = await withAgent();
    const [target] = h.provisioning.tombstoneTargets();
    expect(target).toMatchObject({
      relayUrl: "wss://relay.example",
      ownerPubkeys: [OWNER_PUBKEY],
    });
    expect(target!.auth.endpointId).toBe("canary-buzz");
    // The sealed key really opened: NIP-42 has to authenticate as a real
    // identity, and a target carrying ciphertext would fail at connect time.
    expect(publicKey(decodeSecret(target!.auth.privateKey))).toBe(
      publicKey(decodeSecret(AGENT_KEY)),
    );
  });

  test("keep watching a relay whose only agent is staged", async () => {
    // The staged agent's tombstone has already arrived, but a second one for a
    // cascade sibling may not have — and after the last purge there is nothing
    // left on that relay to watch anyway.
    const h = await withAgent();
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    const [target] = h.provisioning.tombstoneTargets();
    expect(target?.auth.endpointId).toBe("canary-buzz");
    expect(target?.agents[0]?.lifecycle).toBe("staged_delete");
  });

  test("drop away entirely once the last agent is purged", async () => {
    const h = await withAgent();
    await h.lifecycle.stage("canary", { kind: "operator", via: "api" });
    h.clock.now += (GRACE_HOURS + 1) * HOUR_MS;
    await h.lifecycle.sweepPurges();
    expect(h.provisioning.tombstoneTargets()).toEqual([]);
  });
});

describe("without a provisioning block", () => {
  test("staging is inert rather than half-applied", () => {
    const dir = mkdtempSync(join(tmpdir(), "torana-delete-bare-"));
    dirs.push(dir);
    mkdirSync(join(dir, "workspaces"), { recursive: true });
    const loaded = makeLoaded(dir);
    applyMigrations(loaded.config.gateway.db_path!);
    const db = new GatewayDB(loaded.config.gateway.db_path!);
    dbs.push(db);
    const lifecycle = new BuzzAgentLifecycleService({
      db,
      dataDir: dir,
      provisioning: null,
      transport: () => null,
    });
    return lifecycle
      .stage("canary", { kind: "operator", via: "api" })
      .then((result) => {
        expect(result.kind).toBe("not_configured");
        expect(lifecycle.expedite("canary", "cli")).toBe("not_configured");
      });
  });
});
