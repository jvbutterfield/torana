// US-032 — the wildcard admin token and the Desktop-managed agent list route.
//
// The wildcard exists because Desktop-managed agent ids are created at deploy
// time and cannot be enumerated when a token is written. It is safe only
// because `endpoints:admin` is structurally barred from combining with
// messaging scopes, so "any provisioned agent" can never mean "message as any
// agent". These tests hold both halves of that: the wildcard works where it
// should, and buys nothing where it should not.

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
import { parseProvisioningKey } from "../../src/config/provisioning-secrets.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { createServer, type Server } from "../../src/server.js";
import { BuzzProvisioningService } from "../../src/platform/buzz/provisioning.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const KEY = "11".repeat(32);
const WILDCARD_SECRET = "wildcard-token-secret-0123456789ab";
const SCOPED_SECRET = "scoped-token-secret-0123456789abc";

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
): ResolvedAgentApiToken {
  return {
    name,
    secret,
    hash: new Uint8Array(createHash("sha256").update(secret).digest()),
    bot_ids: botIds,
    scopes: ["endpoints:admin"],
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "torana-prov-agent-routes-"));
  dirs.push(dir);
  const dbPath = join(dir, "gateway.db");
  applyMigrations(dbPath);
  const config = makeTestConfig([makeTestBotConfig("alpha")]);
  config.agent_api.enabled = true;
  db = new GatewayDB(dbPath);
  db.syncNormalizedConfig(normalizedV1Model(config));
  const configV2 = ConfigV2Schema.parse(
    upgradeV1Object(config) as Record<string, unknown>,
  );

  const provisioning = new BuzzProvisioningService({
    db,
    configV2,
    key: parseProvisioningKey(KEY),
    transport: null,
  });

  server = createServer({ port: 0, hostname: "127.0.0.1" });
  registerAgentApiRoutes(server.router, {
    config,
    db,
    registry: { botIds: ["alpha"], bot: () => undefined } as never,
    tokens: [
      token("wildcard", WILDCARD_SECRET, ["*"]),
      token("scoped", SCOPED_SECRET, ["alpha"]),
    ],
    provisioning,
  } as never);
  return { base: `http://127.0.0.1:${server.port}`, db: db!, provisioning };
}

/** Seed a provisioned agent directly; the create path is tested elsewhere. */
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

async function listAgents(base: string, secret: string) {
  const res = await fetch(`${base}/v1/admin/buzz/agents`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  return { status: res.status, body: (await res.json()) as { agents?: any[] } };
}

describe("GET /v1/admin/buzz/agents", () => {
  test("requires a token", async () => {
    const { base } = setup();
    const res = await fetch(`${base}/v1/admin/buzz/agents`);
    expect(res.status).toBe(401);
  });

  test("lists provisioned agents with lifecycle and instruction version", async () => {
    const { base, db: database } = setup();
    seedAgent(database, "canary");
    const { status, body } = await listAgents(base, WILDCARD_SECRET);
    expect(status).toBe(200);
    expect(body.agents).toHaveLength(1);
    expect(body.agents![0]).toMatchObject({
      agent_id: "canary",
      harness: "claude",
      lifecycle: "active",
      instruction_version: "abc123def456",
      purge_deadline: null,
    });
  });

  test("returns an empty list rather than 404 when nothing is provisioned", async () => {
    const { base } = setup();
    const { status, body } = await listAgents(base, WILDCARD_SECRET);
    expect(status).toBe(200);
    expect(body.agents).toEqual([]);
  });

  test("a narrowly scoped token sees only the agents it names", async () => {
    // The wildcard is a grant, not a default: a token scoped to `alpha` must
    // not learn that Desktop-managed agents exist.
    const { base, db: database } = setup();
    seedAgent(database, "canary");
    const { status, body } = await listAgents(base, SCOPED_SECRET);
    expect(status).toBe(200);
    expect(body.agents).toEqual([]);
  });

  test("never exposes secret material", async () => {
    const { base, db: database } = setup();
    seedAgent(database, "canary");
    const { body } = await listAgents(base, WILDCARD_SECRET);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("nsec");
    expect(serialized).not.toContain("private_key");
    expect(serialized).not.toContain("ciphertext");
  });
});

describe("wildcard token on the endpoint routes", () => {
  const PATH = "/v1/admin/buzz/endpoints/canary-buzz";

  test("a wildcard token reaches an agent it does not literally name", async () => {
    // Without the wildcard this is a 403 for every Desktop-managed agent,
    // because none of their ids existed when the token was written.
    const { base, db: database } = setup();
    database.upsertProvisionedEndpoint({
      endpointId: "canary-buzz",
      agentId: "canary",
      derivedPubkey: "pub-canary",
      configJson: "{}",
      privateKeyCiphertext: "sealed",
      authTagCiphertext: null,
      provisionedBy: "provisioner",
      deployNonce: null,
    });
    const res = await fetch(`${base}${PATH}`, {
      headers: { Authorization: `Bearer ${WILDCARD_SECRET}` },
    });
    // 200 or 404 depending on endpoint state — the point is that it is not the
    // 403 a non-matching `bot_ids` would produce.
    expect(res.status).not.toBe(403);
  });

  test("a scoped token still cannot reach an agent it does not name", async () => {
    const { base, db: database } = setup();
    database.upsertProvisionedEndpoint({
      endpointId: "canary-buzz",
      agentId: "canary",
      derivedPubkey: "pub-canary",
      configJson: "{}",
      privateKeyCiphertext: "sealed",
      authTagCiphertext: null,
      provisionedBy: "provisioner",
      deployNonce: null,
    });
    const res = await fetch(`${base}${PATH}`, {
      headers: { Authorization: `Bearer ${SCOPED_SECRET}` },
    });
    expect(res.status).toBe(404);
  });

  test("an asterisk is a literal, not a pattern", async () => {
    // `bot_ids: ["alpha"]` must not match anything by prefix or glob; the only
    // wildcard is the exact string "*".
    const { base, db: database } = setup();
    database.upsertProvisionedEndpoint({
      endpointId: "alpha-extra-buzz",
      agentId: "alpha-extra",
      derivedPubkey: "pub-alpha-extra",
      configJson: "{}",
      privateKeyCiphertext: "sealed",
      authTagCiphertext: null,
      provisionedBy: "provisioner",
      deployNonce: null,
    });
    const res = await fetch(
      `${base}/v1/admin/buzz/endpoints/alpha-extra-buzz`,
      { headers: { Authorization: `Bearer ${SCOPED_SECRET}` } },
    );
    expect(res.status).toBe(404);
  });
});
