import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerAgentApiRoutes } from "../../src/agent-api/router.js";
import type { ResolvedAgentApiToken } from "../../src/config/load.js";
import { normalizedV1Model } from "../../src/config/v2.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { logger } from "../../src/log.js";
import { createServer, type Server } from "../../src/server.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

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
  scopes: ("ask" | "send" | "admin")[],
): ResolvedAgentApiToken {
  return {
    name,
    secret,
    hash: new Uint8Array(createHash("sha256").update(secret).digest()),
    bot_ids: botIds,
    scopes,
  };
}

function setup(tokens: ResolvedAgentApiToken[]): {
  base: string;
  db: GatewayDB;
} {
  const dir = mkdtempSync(join(tmpdir(), "torana-admin-api-"));
  dirs.push(dir);
  const dbPath = join(dir, "gateway.db");
  applyMigrations(dbPath);
  const config = makeTestConfig([
    makeTestBotConfig("alpha"),
    makeTestBotConfig("beta"),
  ]);
  config.agent_api.enabled = true;
  db = new GatewayDB(dbPath);
  db.syncNormalizedConfig(normalizedV1Model(config));
  const registry = {
    botIds: ["alpha", "beta"],
    bot(id: string) {
      if (!this.botIds.includes(id)) return undefined;
      return {
        botConfig: { id, runner: { type: "claude" } },
        runner: { supportsSideSessions: () => true },
      };
    },
  };
  server = createServer({ port: 0, hostname: "127.0.0.1" });
  registerAgentApiRoutes(server.router, {
    config,
    db,
    registry: registry as never,
    tokens,
    log: logger("admin-api-test"),
    pool: {
      listForBot: () => [],
      stop: async () => {},
    } as never,
    orphans: { attach: () => {}, shutdown: () => {} } as never,
  });
  return { base: `http://127.0.0.1:${server.port}`, db };
}

describe("operator admin API", () => {
  const adminSecret = "admin-scope-secret-123456";
  const askSecret = "admin-ask-secret-123456";
  const sendSecret = "admin-send-secret-12345";

  test("requires admin scope and filters all listings to permitted agents", async () => {
    const { base, db } = setup([
      token("alpha-ops", adminSecret, ["alpha"], ["admin"]),
      token("send-only", sendSecret, ["alpha"], ["send"]),
    ]);
    db.persistConversationSession({
      sessionKey: "alpha-session",
      agentId: "alpha",
      runnerSessionId: "alpha-runner",
      runnerType: "claude",
      providerState: null,
      state: "ready",
    });
    db.persistConversationSession({
      sessionKey: "beta-session",
      agentId: "beta",
      runnerSessionId: "beta-runner",
      runnerType: "claude",
      providerState: null,
      state: "ready",
    });

    const unauthenticated = await fetch(`${base}/v1/admin/endpoints`);
    expect(unauthenticated.status).toBe(401);
    const forbidden = await fetch(`${base}/v1/admin/endpoints`, {
      headers: { Authorization: `Bearer ${sendSecret}` },
    });
    expect(forbidden.status).toBe(403);

    const headers = { Authorization: `Bearer ${adminSecret}` };
    const endpoints = (await (
      await fetch(`${base}/v1/admin/endpoints`, { headers })
    ).json()) as { endpoints: Array<{ agentId: string }> };
    expect(endpoints.endpoints.map((row) => row.agentId)).toEqual(["alpha"]);
    const sessions = (await (
      await fetch(`${base}/v1/admin/sessions`, { headers })
    ).json()) as { sessions: Array<{ agentId: string }> };
    expect(sessions.sessions.map((row) => row.agentId)).toEqual(["alpha"]);
  });

  test("a messaging token cannot reach the admin routes, read or write", async () => {
    // The property this scope split exists for: `ask` is what agents and
    // scripts carry, and it must not enumerate operational state or destroy
    // durable rows. Every admin route is checked, not just a sample.
    const { base, db } = setup([
      token("messaging", askSecret, ["alpha"], ["ask", "send"]),
      token("alpha-ops", adminSecret, ["alpha"], ["admin"]),
    ]);
    const endpointId = db.getEndpointId("alpha", "telegram");
    const headers = {
      Authorization: `Bearer ${askSecret}`,
      "Content-Type": "application/json",
    };

    const reads = [
      "/v1/admin/endpoints",
      "/v1/admin/conversations",
      "/v1/admin/sessions",
      "/v1/admin/outbox",
    ];
    for (const path of reads) {
      const res = await fetch(`${base}${path}`, { headers });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(
        "scope_not_permitted",
      );
    }

    const writes = [
      "/v1/admin/sessions/alpha-session/rotate",
      "/v1/admin/outbox/1/replay",
      "/v1/admin/outbox/1/dead-letter",
      `/v1/admin/endpoints/${endpointId}/drain`,
      `/v1/admin/endpoints/${endpointId}/resume`,
      `/v1/admin/endpoints/${endpointId}/dead-letter`,
    ];
    for (const path of writes) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ acknowledge_data_loss: true }),
      });
      expect(res.status).toBe(403);
    }

    // The endpoint the messaging token tried to drain is untouched.
    expect(db.getEndpointState(endpointId)?.lifecycleState).toBe("active");
  });

  test("rotates sessions and controls outbox without exposing payloads", async () => {
    const { base, db } = setup([
      token("alpha-ops", adminSecret, ["alpha"], ["admin"]),
    ]);
    const endpointId = db.getEndpointId("alpha", "telegram");
    const conversation = {
      platform: "telegram" as const,
      communityId: null,
      endpointId,
      channelId: "1234",
      threadRootId: null,
      workflowRunId: null,
      type: "direct" as const,
    };
    db.resolveConversation("alpha", conversation, "owner");
    const session = db.listOperationalSessions()[0]!;
    const outboxId = db.insertOutboundOperation({
      turnId: null,
      agentId: "alpha",
      conversation,
      operation: { kind: "send", text: "must-not-leak", files: [] },
      signedPayloadJson: '{"signed":"exact"}',
      signedEventId: "ab".repeat(32),
    });
    const headers = { Authorization: `Bearer ${adminSecret}` };

    const rotated = await fetch(
      `${base}/v1/admin/sessions/${encodeURIComponent(session.sessionKey)}/rotate`,
      { method: "POST", headers },
    );
    expect(rotated.status).toBe(200);
    expect(db.getConversationSession(session.sessionKey)?.generation).toBe(1);

    const listed = await fetch(`${base}/v1/admin/outbox`, { headers });
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(listedText).not.toContain("must-not-leak");
    expect(listedText).not.toContain("exact");

    const dead = await fetch(
      `${base}/v1/admin/outbox/${outboxId}/dead-letter`,
      { method: "POST", headers },
    );
    expect(dead.status).toBe(200);
    expect(db.getOperationalOutbox(outboxId)?.status).toBe("dead");
    const replay = await fetch(`${base}/v1/admin/outbox/${outboxId}/replay`, {
      method: "POST",
      headers,
    });
    expect(replay.status).toBe(200);
    expect(db.getOperationalOutbox(outboxId)).toMatchObject({
      status: "pending",
      signedEventId: "ab".repeat(32),
    });
  });

  test("requires explicit data-loss acknowledgement for forced endpoint dead-letter", async () => {
    const { base, db } = setup([
      token("alpha-ops", adminSecret, ["alpha"], ["admin"]),
    ]);
    const endpointId = db.getEndpointId("alpha", "telegram");
    const headers = {
      Authorization: `Bearer ${adminSecret}`,
      "Content-Type": "application/json",
    };
    expect(
      (
        await fetch(`${base}/v1/admin/endpoints/${endpointId}/drain`, {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${base}/v1/admin/endpoints/${endpointId}/dead-letter`, {
          method: "POST",
          headers,
          body: JSON.stringify({ acknowledge_data_loss: false }),
        })
      ).status,
    ).toBe(400);
    const accepted = await fetch(
      `${base}/v1/admin/endpoints/${endpointId}/dead-letter`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ acknowledge_data_loss: true }),
      },
    );
    expect(accepted.status).toBe(200);
    expect(db.getEndpointState(endpointId)?.lifecycleState).toBe("disabled");
  });
});
