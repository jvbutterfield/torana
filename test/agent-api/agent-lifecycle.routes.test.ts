// US-034 — the delete pipeline's HTTP surface.
//
// The asymmetry between these routes is the design: `DELETE` stages (a
// reversible grace period), `restore` reverses, and `reconciliation` only
// reads. There is deliberately no route that destroys — the purge sweep in the
// running gateway owns that, so no single admin call can skip the grace window
// or the audit-first ordering.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerAgentApiRoutes } from "../../src/agent-api/router.js";
import type { ResolvedAgentApiToken } from "../../src/config/load.js";
import {
  ConfigV2Schema,
  normalizedV1Model,
  upgradeV1Object,
} from "../../src/config/v2.js";
import {
  parseProvisioningKey,
  singleKeyring,
} from "../../src/config/provisioning-secrets.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { createServer, type Server } from "../../src/server.js";
import { BuzzAgentLifecycleService } from "../../src/platform/buzz/agent-lifecycle.js";
import { BuzzProvisioningService } from "../../src/platform/buzz/provisioning.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const KEY = "11".repeat(32);
const WILDCARD_SECRET = "wildcard-token-secret-0123456789ab";
const SCOPED_SECRET = "scoped-token-secret-0123456789abc";
const ASK_SECRET = "ask-token-secret-0123456789abcdef";

const dirs: string[] = [];
let server: Server | null = null;
let db: GatewayDB | null = null;

afterEach(async () => {
  if (server) await server.stop();
  db?.close();
  server = null;
  db = null;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function token(
  name: string,
  secret: string,
  botIds: string[],
  scopes: string[] = ["endpoints:admin"],
): ResolvedAgentApiToken {
  return {
    name,
    secret,
    hash: new Uint8Array(createHash("sha256").update(secret).digest()),
    bot_ids: botIds,
    scopes,
  } as ResolvedAgentApiToken;
}

function setup(options: { withLifecycle?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "torana-delete-routes-"));
  dirs.push(dir);
  const dbPath = join(dir, "gateway.db");
  applyMigrations(dbPath);
  const config = makeTestConfig([makeTestBotConfig("alpha")]);
  config.agent_api.enabled = true;
  config.gateway.data_dir = dir;
  db = new GatewayDB(dbPath);
  db.syncNormalizedConfig(normalizedV1Model(config));
  const configV2 = ConfigV2Schema.parse(
    upgradeV1Object(config) as Record<string, unknown>,
  );

  const provisioning = new BuzzProvisioningService({
    db,
    configV2,
    keyring: singleKeyring(parseProvisioningKey(KEY)),
    transport: null,
  });
  const clock = { now: Date.parse("2026-08-09T00:00:00Z") };
  const agentLifecycle = new BuzzAgentLifecycleService({
    db,
    dataDir: dir,
    provisioning: {
      max_agents: 8,
      delete_grace_hours: 72,
      min_free_bytes: 0,
      workspace_quota_bytes: 0,
      buzz_tools_default: {
        policy: "read_only",
        allowed_commands: [],
        expose_private_key_to_runner: false,
        acknowledge_dangerous: false,
      },
      harnesses: {},
    } as never,
    transport: () => null,
    now: () => clock.now,
  });

  server = createServer({ port: 0, hostname: "127.0.0.1" });
  registerAgentApiRoutes(server.router, {
    config,
    db,
    registry: { botIds: ["alpha"], bot: () => undefined } as never,
    tokens: [
      token("wildcard", WILDCARD_SECRET, ["*"]),
      token("scoped", SCOPED_SECRET, ["alpha"]),
      token("asker", ASK_SECRET, ["*"], ["ask"]),
    ],
    provisioning,
    ...(options.withLifecycle === false ? {} : { agentLifecycle }),
  } as never);
  return {
    base: `http://127.0.0.1:${server.port}`,
    db: db!,
    lifecycle: agentLifecycle,
    clock,
  };
}

function seedAgent(database: GatewayDB, agentId: string): void {
  database.upsertProvisionedAgent({
    agentId,
    derivedPubkey: `pub-${agentId}`,
    harness: "claude",
    systemPrompt: "",
    model: null,
    timeoutsJson: "{}",
    instructionVersion: "abc123def456",
    provisionedBy: "provisioner",
  });
}

const auth = (secret: string) => ({
  headers: { Authorization: `Bearer ${secret}` },
});

describe("DELETE /v1/admin/buzz/agents/:agent_id", () => {
  test("stages rather than destroys, and reports the deadline", async () => {
    const { base, db: database } = setup();
    seedAgent(database, "canary");
    const res = await fetch(`${base}/v1/admin/buzz/agents/canary`, {
      method: "DELETE",
      ...auth(WILDCARD_SECRET),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.result).toBe("staged");
    expect(body.purge_deadline).toBe("2026-08-12 00:00:00");
    // The row is still here — a delete call is the start of a grace period.
    expect(database.getProvisionedAgent("canary")?.lifecycle).toBe(
      "staged_delete",
    );
  });

  test("is idempotent: a second call reports already_staged", async () => {
    const { base, db: database } = setup();
    seedAgent(database, "canary");
    await fetch(`${base}/v1/admin/buzz/agents/canary`, {
      method: "DELETE",
      ...auth(WILDCARD_SECRET),
    });
    const res = await fetch(`${base}/v1/admin/buzz/agents/canary`, {
      method: "DELETE",
      ...auth(WILDCARD_SECRET),
    });
    expect((await res.json()).result).toBe("already_staged");
  });

  test("404s an unknown agent", async () => {
    const { base } = setup();
    const res = await fetch(`${base}/v1/admin/buzz/agents/ghost`, {
      method: "DELETE",
      ...auth(WILDCARD_SECRET),
    });
    expect(res.status).toBe(404);
  });

  test("a scoped token cannot stage an agent it does not cover", async () => {
    const { base, db: database } = setup();
    seedAgent(database, "canary");
    const res = await fetch(`${base}/v1/admin/buzz/agents/canary`, {
      method: "DELETE",
      ...auth(SCOPED_SECRET),
    });
    expect(res.status).toBe(404);
    expect(database.getProvisionedAgent("canary")?.lifecycle).toBe("active");
  });

  test("an `ask` token cannot reach the route at all", async () => {
    const { base, db: database } = setup();
    seedAgent(database, "canary");
    const res = await fetch(`${base}/v1/admin/buzz/agents/canary`, {
      method: "DELETE",
      ...auth(ASK_SECRET),
    });
    expect(res.status).toBe(403);
    expect(database.getProvisionedAgent("canary")?.lifecycle).toBe("active");
  });

  test("requires authentication", async () => {
    const { base, db: database } = setup();
    seedAgent(database, "canary");
    const res = await fetch(`${base}/v1/admin/buzz/agents/canary`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
    expect(database.getProvisionedAgent("canary")?.lifecycle).toBe("active");
  });
});

describe("POST /v1/admin/buzz/agents/:agent_id/restore", () => {
  test("reverses a staged deletion during its grace period", async () => {
    const { base, db: database } = setup();
    seedAgent(database, "canary");
    await fetch(`${base}/v1/admin/buzz/agents/canary`, {
      method: "DELETE",
      ...auth(WILDCARD_SECRET),
    });
    const res = await fetch(`${base}/v1/admin/buzz/agents/canary/restore`, {
      method: "POST",
      ...auth(WILDCARD_SECRET),
    });
    expect(res.status).toBe(200);
    const row = database.getProvisionedAgent("canary")!;
    expect(row.lifecycle).toBe("active");
    expect(row.purgeDeadline).toBeNull();
  });

  test("409s an agent that is not staged", async () => {
    const { base, db: database } = setup();
    seedAgent(database, "canary");
    const res = await fetch(`${base}/v1/admin/buzz/agents/canary/restore`, {
      method: "POST",
      ...auth(WILDCARD_SECRET),
    });
    expect(res.status).toBe(409);
  });

  test("404s an unknown agent, and a token that does not cover it", async () => {
    const { base, db: database } = setup();
    seedAgent(database, "canary");
    expect(
      (
        await fetch(`${base}/v1/admin/buzz/agents/ghost/restore`, {
          method: "POST",
          ...auth(WILDCARD_SECRET),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${base}/v1/admin/buzz/agents/canary/restore`, {
          method: "POST",
          ...auth(SCOPED_SECRET),
        })
      ).status,
    ).toBe(404);
  });

  test("records the reversal against the token that made it", async () => {
    const { base, db: database } = setup();
    seedAgent(database, "canary");
    await fetch(`${base}/v1/admin/buzz/agents/canary`, {
      method: "DELETE",
      ...auth(WILDCARD_SECRET),
    });
    await fetch(`${base}/v1/admin/buzz/agents/canary/restore`, {
      method: "POST",
      ...auth(WILDCARD_SECRET),
    });
    const entry = database
      .listProvisioningAudit("canary")
      .find((row) => row.signal === "restore");
    expect(entry?.actor).toBe("token:wildcard");
  });
});

describe("GET /v1/admin/buzz/agents/:agent_id", () => {
  test("returns lifecycle and deadline for a staged agent", async () => {
    const { base, db: database } = setup();
    seedAgent(database, "canary");
    await fetch(`${base}/v1/admin/buzz/agents/canary`, {
      method: "DELETE",
      ...auth(WILDCARD_SECRET),
    });
    const res = await fetch(
      `${base}/v1/admin/buzz/agents/canary`,
      auth(WILDCARD_SECRET),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      agent_id: "canary",
      lifecycle: "staged_delete",
      purge_deadline: "2026-08-12 00:00:00",
      instruction_version: "abc123def456",
    });
  });

  test("404s an id the token does not cover, without revealing existence", async () => {
    const { base, db: database } = setup();
    seedAgent(database, "canary");
    const covered = await fetch(
      `${base}/v1/admin/buzz/agents/canary`,
      auth(SCOPED_SECRET),
    );
    const missing = await fetch(
      `${base}/v1/admin/buzz/agents/ghost`,
      auth(SCOPED_SECRET),
    );
    expect(covered.status).toBe(404);
    expect(missing.status).toBe(404);
  });
});

describe("GET /v1/admin/buzz/reconciliation", () => {
  test("is advisory: it reports a long-overdue agent and destroys nothing", async () => {
    const { base, db: database, clock } = setup();
    seedAgent(database, "canary");
    await fetch(`${base}/v1/admin/buzz/agents/canary`, {
      method: "DELETE",
      ...auth(WILDCARD_SECRET),
    });
    clock.now += 365 * 24 * 3_600_000;

    const res = await fetch(
      `${base}/v1/admin/buzz/reconciliation`,
      auth(WILDCARD_SECRET),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: Array<Record<string, unknown>>;
      record_probe: string;
    };
    expect(body.agents[0]).toMatchObject({
      agent_id: "canary",
      lifecycle: "staged_delete",
      record_state: "unknown",
    });
    expect(body.record_probe).toBe("unavailable");
    expect(database.getProvisionedAgent("canary")).not.toBeNull();
  });

  test("lists rejected tombstones, which have no agent id to scope by", async () => {
    const { base, lifecycle } = setup();
    lifecycle.recordRejectedTombstone({
      reason: "yaml_identity",
      eventId: "ee".repeat(32),
      agentPubkey: "ab".repeat(32),
      ownerPubkey: "cd".repeat(32),
      relayUrl: "wss://relay.example",
      message: "names a YAML-declared identity",
    });
    const res = await fetch(
      `${base}/v1/admin/buzz/reconciliation`,
      auth(SCOPED_SECRET),
    );
    const body = (await res.json()) as {
      rejected_tombstones: Array<Record<string, unknown>>;
    };
    expect(body.rejected_tombstones).toHaveLength(1);
    expect(body.rejected_tombstones[0]).toMatchObject({
      reason: "yaml_identity",
      relay_url: "wss://relay.example",
    });
  });

  test("filters agent rows by the token's bot_ids", async () => {
    const { base, db: database } = setup();
    seedAgent(database, "canary");
    const res = await fetch(
      `${base}/v1/admin/buzz/reconciliation`,
      auth(SCOPED_SECRET),
    );
    expect(((await res.json()) as { agents: unknown[] }).agents).toHaveLength(
      0,
    );
  });

  test("requires the endpoints:admin scope", async () => {
    const { base } = setup();
    expect(
      (await fetch(`${base}/v1/admin/buzz/reconciliation`, auth(ASK_SECRET)))
        .status,
    ).toBe(403);
    expect((await fetch(`${base}/v1/admin/buzz/reconciliation`)).status).toBe(
      401,
    );
  });
});

describe("without a lifecycle service", () => {
  test("the delete routes answer 503 rather than 404", async () => {
    // A probe has to be able to tell "this build has no delete pipeline" from
    // "this path is not routed", which is the same contract the endpoint
    // provisioning routes already keep.
    const { base, db: database } = setup({ withLifecycle: false });
    seedAgent(database, "canary");
    for (const [method, path] of [
      ["DELETE", "/v1/admin/buzz/agents/canary"],
      ["POST", "/v1/admin/buzz/agents/canary/restore"],
      ["GET", "/v1/admin/buzz/reconciliation"],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method,
        ...auth(WILDCARD_SECRET),
      });
      expect(res.status).toBe(503);
    }
    expect(database.getProvisionedAgent("canary")?.lifecycle).toBe("active");
  });
});
