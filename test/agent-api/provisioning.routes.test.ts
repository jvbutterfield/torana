// US-024 — the provisioning admin routes.
//
// These three routes are the only `/v1/*` surface deliberately reachable from
// the public internet, so their authorization is the security boundary rather
// than a formality: a messaging token must never satisfy them, and neither
// must an absent one.

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
import { logger } from "../../src/log.js";
import { createServer, type Server } from "../../src/server.js";
import { BuzzProvisioningService } from "../../src/platform/buzz/provisioning.js";
import {
  createOwnerAuthTag,
  decodeSecret,
  publicKey,
} from "../../src/platform/buzz/protocol.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const PROVISION_SECRET = "provision-token-secret-0123456789";
const ASK_SECRET = "ask-token-secret-0123456789abcd";
const KEY = "11".repeat(32);
const ENDPOINT_KEY = "0a".repeat(32);
const OWNER_SECRET = decodeSecret("04".padStart(64, "0"));
const OWNER_PUBKEY = publicKey(OWNER_SECRET);
const AUTH_TAG = JSON.stringify(
  createOwnerAuthTag(
    OWNER_SECRET,
    publicKey(decodeSecret(ENDPOINT_KEY)),
    "kind=9",
  ),
);

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
  scopes: ("ask" | "send" | "endpoints:admin")[],
): ResolvedAgentApiToken {
  return {
    name,
    secret,
    hash: new Uint8Array(createHash("sha256").update(secret).digest()),
    bot_ids: botIds,
    scopes,
  };
}

function setup(options: { withProvisioning?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "torana-provision-routes-"));
  dirs.push(dir);
  const dbPath = join(dir, "gateway.db");
  applyMigrations(dbPath);
  const config = makeTestConfig([makeTestBotConfig("alpha")]);
  config.agent_api.enabled = true;
  db = new GatewayDB(dbPath);
  db.syncNormalizedConfig(normalizedV1Model(config));

  const upgraded = upgradeV1Object(config) as Record<string, unknown>;
  const configV2 = ConfigV2Schema.parse(upgraded);

  const provisioning =
    options.withProvisioning === false
      ? undefined
      : new BuzzProvisioningService({
          db,
          configV2,
          keyring: singleKeyring(parseProvisioningKey(KEY)),
          // No transport: a deploy should refuse cleanly rather than half
          // succeed when the Buzz platform is off.
          transport: null,
        });

  server = createServer({ port: 0, hostname: "127.0.0.1" });
  registerAgentApiRoutes(server.router, {
    config,
    db,
    registry: {
      botIds: ["alpha"],
      bot: (id: string) =>
        id === "alpha"
          ? {
              botConfig: { id, runner: { type: "claude" } },
              runner: { supportsSideSessions: () => true },
            }
          : undefined,
    } as never,
    tokens: [
      token("provisioner", PROVISION_SECRET, ["alpha"], ["endpoints:admin"]),
      token("messaging", ASK_SECRET, ["alpha"], ["ask"]),
    ],
    log: logger("provision-routes-test"),
    pool: { listForBot: () => [], stop: async () => {} } as never,
    orphans: { attach: () => {}, shutdown: () => {} } as never,
    provisioning,
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    db: db!,
    provisioning,
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    agent_id: "alpha",
    relay_url: "ws://127.0.0.1:1",
    private_key: ENDPOINT_KEY,
    auth_tag: AUTH_TAG,
    owner_pubkey: OWNER_PUBKEY,
    ...overrides,
  });
}

const PATH = "/v1/admin/buzz/endpoints/alpha-provisioned";

describe("provisioning route authorization", () => {
  test("every method rejects a missing, wrong, or messaging token", async () => {
    const { base } = setup();
    for (const method of ["PUT", "GET", "DELETE"] as const) {
      const init = method === "PUT" ? { method, body: body() } : { method };

      const anonymous = await fetch(`${base}${PATH}`, init);
      expect({ method, status: anonymous.status }).toEqual({
        method,
        status: 401,
      });

      const wrong = await fetch(`${base}${PATH}`, {
        ...init,
        headers: { Authorization: "Bearer not-the-right-token-value-000" },
      });
      expect({ method, status: wrong.status }).toEqual({
        method,
        status: 401,
      });

      // The important one: an agent's own messaging token is authenticated
      // but must not be authorized here.
      const messaging = await fetch(`${base}${PATH}`, {
        ...init,
        headers: { Authorization: `Bearer ${ASK_SECRET}` },
      });
      expect({ method, status: messaging.status }).toEqual({
        method,
        status: 403,
      });
    }
  });

  test("a token cannot provision for an agent outside its bot_ids", async () => {
    const { base } = setup();
    const response = await fetch(`${base}${PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${PROVISION_SECRET}` },
      body: body({ agent_id: "beta" }),
    });
    expect(response.status).toBe(403);
  });
});

describe("provisioning route contract", () => {
  test("an oversized body is refused before it is parsed", async () => {
    const { base } = setup();
    const huge = body({ deploy_nonce: "n".repeat(70 * 1024) });
    const response = await fetch(`${base}${PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${PROVISION_SECRET}` },
      body: huge,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain("exceeds");
  });

  test("malformed JSON and unknown fields are 400, not 500", async () => {
    const { base } = setup();
    const headers = { Authorization: `Bearer ${PROVISION_SECRET}` };

    const notJson = await fetch(`${base}${PATH}`, {
      method: "PUT",
      headers,
      body: "{oops",
    });
    expect(notJson.status).toBe(400);

    const unknownField = await fetch(`${base}${PATH}`, {
      method: "PUT",
      headers,
      body: body({ runner: { type: "command" } }),
    });
    expect(unknownField.status).toBe(400);

    const missingAgent = await fetch(`${base}${PATH}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ relay_url: "ws://x", private_key: ENDPOINT_KEY }),
    });
    expect(missingAgent.status).toBe(400);
  });

  test("a deploy with the Buzz platform off reports unavailable, not success", async () => {
    const { base } = setup();
    const response = await fetch(`${base}${PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${PROVISION_SECRET}` },
      body: body(),
    });
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain("Buzz platform");
  });

  test("GET and DELETE on an unknown endpoint are 404", async () => {
    const { base } = setup();
    const headers = { Authorization: `Bearer ${PROVISION_SECRET}` };
    expect((await fetch(`${base}${PATH}`, { headers })).status).toBe(404);
    expect(
      (await fetch(`${base}${PATH}`, { method: "DELETE", headers })).status,
    ).toBe(404);
  });

  test("routes answer 503 when the build has no provisioning service", async () => {
    const { base } = setup({ withProvisioning: false });
    const response = await fetch(`${base}${PATH}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${PROVISION_SECRET}` },
      body: body(),
    });
    expect(response.status).toBe(503);
  });

  test("neighbouring admin routes still require their own scope", async () => {
    // The provisioning token is deliberately narrow: it must not become a
    // skeleton key for the rest of the admin surface just because the edge
    // lets its path through.
    const { base } = setup();
    const response = await fetch(`${base}/v1/admin/sessions`, {
      headers: { Authorization: `Bearer ${PROVISION_SECRET}` },
    });
    expect(response.status).toBe(403);
  });
});

describe("the provisioning token is structurally dedicated", () => {
  test("endpoints:admin cannot be combined with a messaging scope", () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")]) as Record<
      string,
      unknown
    > & { agent_api: { enabled: boolean; tokens: unknown[] } };
    config.agent_api.enabled = true;
    const withToken = (scopes: string[]) => ({
      ...config,
      agent_api: {
        ...config.agent_api,
        tokens: [
          {
            name: "provisioner",
            secret_ref: "a-very-long-provisioning-secret-value",
            bot_ids: ["alpha"],
            scopes,
          },
        ],
      },
    });

    expect(ConfigSchema.safeParse(withToken(["endpoints:admin"])).success).toBe(
      true,
    );
    const mixed = ConfigSchema.safeParse(withToken(["endpoints:admin", "ask"]));
    expect(mixed.success).toBe(false);
    expect(
      mixed.error!.issues.some((issue) => issue.message.includes("only scope")),
    ).toBe(true);
    expect(ConfigSchema.safeParse(withToken(["ask", "send"])).success).toBe(
      true,
    );
  });
});
