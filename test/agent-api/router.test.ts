// Router-level integration tests for the agent-api surface. Exercises auth +
// scope + unknown-bot + DELETE method handling against a real HTTP server.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer, type Server } from "../../src/server.js";
import {
  registerAgentApiHealthRoute,
  registerAgentApiRoutes,
} from "../../src/agent-api/router.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { logger } from "../../src/log.js";
import type { ResolvedAgentApiToken } from "../../src/config/load.js";
import type { Config } from "../../src/config/schema.js";
import { makeTestConfig, makeTestBotConfig } from "../fixtures/bots.js";

function hash(s: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(s, "utf8").digest());
}

let tmpDir: string;
let dbPath: string;
let db: GatewayDB;
let server: Server;

function fakeRegistry(botIds: string[], config: Config): {
  bot(id: string): { botConfig: { id: string; runner: { type: string } } } | undefined;
  botIds: string[];
} {
  const reg = {
    bot(id: string) {
      if (!botIds.includes(id)) return undefined;
      const botConfig = config.bots.find((b) => b.id === id);
      if (!botConfig) return undefined;
      return {
        botConfig: { id, runner: { type: botConfig.runner.type } },
      };
    },
    botIds,
  };
  return reg;
}

function setup(tokens: ResolvedAgentApiToken[]): string {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-router-"));
  dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);

  const bot = makeTestBotConfig("bot1");
  const config = makeTestConfig([bot]);
  config.agent_api.enabled = true;

  server = createServer({ port: 0, hostname: "127.0.0.1" });
  registerAgentApiHealthRoute(server.router, {
    config,
    uptimeSecs: () => 1,
  });
  registerAgentApiRoutes(server.router, {
    config,
    db,
    registry: fakeRegistry(["bot1"], config) as never,
    tokens,
    log: logger("agent-api-test"),
  });
  return `http://127.0.0.1:${server.port}`;
}

beforeEach(() => {
  /* setup is per-test below so each test can pass custom tokens */
});

afterEach(async () => {
  if (server) await server.stop();
  if (db) db.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("/v1/health (public, no auth)", () => {
  test("returns version + agent_api_enabled", async () => {
    const base = setup([]);
    const r = await fetch(`${base}/v1/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; agent_api_enabled: boolean };
    expect(body.ok).toBe(true);
    expect(body.agent_api_enabled).toBe(true);
  });
});

describe("/v1 auth preamble", () => {
  const secret = "s3cret-cos-value-1234";
  const token: ResolvedAgentApiToken = {
    name: "cos",
    secret,
    hash: hash(secret),
    bot_ids: ["bot1"],
    scopes: ["ask"],
  };

  test("missing Authorization → 401 missing_auth", async () => {
    const base = setup([token]);
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("missing_auth");
  });

  test("wrong token → 401 invalid_token", async () => {
    const base = setup([token]);
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("invalid_token");
  });

  test("unknown bot → 404 unknown_bot (before auth probe)", async () => {
    const base = setup([token]);
    const r = await fetch(`${base}/v1/bots/nope/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("unknown_bot");
  });

  test("right token, wrong scope → 403 scope_not_permitted", async () => {
    const base = setup([token]);
    const r = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("scope_not_permitted");
  });

  test("valid ask → reaches stub handler (501 from stub placeholder)", async () => {
    const base = setup([token]);
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ text: "hi" }),
    });
    // Phase 1 returns internal_error from the stub — real body filled in Phase 4.
    expect([500, 501]).toContain(r.status);
  });
});

describe("/v1/turns/:id timing-safe lookup", () => {
  const secret = "tok-a-value-1234567";
  const token: ResolvedAgentApiToken = {
    name: "cos",
    secret,
    hash: hash(secret),
    bot_ids: ["bot1"],
    scopes: ["ask"],
  };

  test("nonexistent id → 404 turn_not_found", async () => {
    const base = setup([token]);
    const r = await fetch(`${base}/v1/turns/999999`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("turn_not_found");
  });

  test("another caller's turn → same 404 turn_not_found", async () => {
    const base = setup([token]);
    // Seed an ask turn owned by a different token name.
    const turnId = db.insertAskTurn({
      botId: "bot1",
      tokenName: "someone-else",
      sessionId: "s",
      textPreview: "hi",
      attachmentPaths: [],
    });
    const r = await fetch(`${base}/v1/turns/${turnId}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("turn_not_found");
  });

  test("own turn + right scope → 200", async () => {
    const base = setup([token]);
    const turnId = db.insertAskTurn({
      botId: "bot1",
      tokenName: "cos",
      sessionId: "s",
      textPreview: "hi",
      attachmentPaths: [],
    });
    const r = await fetch(`${base}/v1/turns/${turnId}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { turn_id: number; status: string };
    expect(body.turn_id).toBe(turnId);
    expect(body.status).toBe("in_progress");
  });

  test("malformed id → 404 turn_not_found", async () => {
    const base = setup([token]);
    const r = await fetch(`${base}/v1/turns/abc`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(404);
  });
});

describe("/v1/bots listing is caller-scoped", () => {
  test("only returns bots the token has access to", async () => {
    const secret = "caller-one-value-abc";
    const token: ResolvedAgentApiToken = {
      name: "caller",
      secret,
      hash: hash(secret),
      bot_ids: ["bot1"],
      scopes: ["ask"],
    };
    const base = setup([token]);
    const r = await fetch(`${base}/v1/bots`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { bots: Array<{ bot_id: string }> };
    expect(body.bots.map((b) => b.bot_id)).toEqual(["bot1"]);
  });
});

describe("DELETE method dispatch", () => {
  test("DELETE /v1/bots/:id/sessions/:sid routes to handler", async () => {
    const secret = "admin-value-abcdefg";
    const token: ResolvedAgentApiToken = {
      name: "admin",
      secret,
      hash: hash(secret),
      bot_ids: ["bot1"],
      scopes: ["ask"],
    };
    const base = setup([token]);
    const r = await fetch(`${base}/v1/bots/bot1/sessions/sess-1`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${secret}` },
    });
    // Phase 1 stub — no live pool, returns session_not_found.
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("session_not_found");
  });

  test("PUT against /v1 route → 405 from server", async () => {
    const secret = "admin-value-abcdefg";
    const token: ResolvedAgentApiToken = {
      name: "admin",
      secret,
      hash: hash(secret),
      bot_ids: ["bot1"],
      scopes: ["ask"],
    };
    const base = setup([token]);
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${secret}` },
      body: "{}",
    });
    expect(r.status).toBe(405);
  });
});
