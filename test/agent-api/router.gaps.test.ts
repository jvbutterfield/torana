// Coverage gap-fills for the /v1 router surface — pin behaviors the PRD
// explicitly requires that the existing router/turns/sessions tests do
// not fully assert.
//
// Specifically:
//   - CORS: no Access-Control-* response headers when an Origin is sent
//     (PRD US-003 line 105 — "intentionally no CORS in v1").
//   - mapAuthFailure body shape: 403 bot_not_permitted carries the bot_id
//     and 403 scope_not_permitted carries the scope (errors.ts mapping
//     written but no test reads the field today).
//   - GET /v1/turns/:id 410 turn_result_expired with a fast-forward clock
//     after a completed turn ages past TURN_RESULT_TTL_MS (PRD US-010 line 263).
//   - GET /v1/turns/:id 200 done body shape for completed send turns
//     (PRD US-010 — body must NOT carry text for send).
//   - GET /v1/turns/:id status='failed' with error_text (PRD US-010).
//   - GET /v1/turns/:id status='interrupted' surfaces as failed +
//     "interrupted_by_gateway_restart" (PRD US-010 + impl plan §6.2).
//   - GET /v1/bots/:id/sessions returns a snapshot of the live pool with
//     the documented shape, not just an empty array (PRD US-008 + US-015).
//   - DELETE /v1/bots/:id/sessions/:sid returns 204 + entry no longer
//     appears in subsequent GET (PRD US-015 line 382).
//
// All tests use a stub runner / stub pool / stub orphans so they are
// quick and have no subprocess flake.

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
let db: GatewayDB;
let server: Server;
let clockMs: number = Date.now();

function fakeRegistry(botIds: string[], config: Config): {
  bot(id: string): unknown;
  botIds: string[];
} {
  return {
    bot(id: string) {
      if (!botIds.includes(id)) return undefined;
      const botConfig = config.bots.find((b) => b.id === id);
      if (!botConfig) return undefined;
      return {
        botConfig: { id, runner: { type: botConfig.runner.type } },
        runner: { supportsSideSessions: () => true },
      };
    },
    get botIds() {
      return botIds;
    },
  };
}

interface FakePoolEntry {
  sessionId: string;
  ephemeral: boolean;
  startedAtMs: number;
  lastUsedAtMs: number;
  hardExpiresAtMs: number;
  inflight: number;
  state: "starting" | "ready" | "busy" | "stopping";
}

function fakePool(initial: FakePoolEntry[] = []): {
  listForBot: (botId: string) => FakePoolEntry[];
  stop: (bot: string, sid: string) => Promise<void>;
  entries: Map<string, FakePoolEntry>;
} {
  const entries = new Map<string, FakePoolEntry>(
    initial.map((e) => [e.sessionId, e]),
  );
  return {
    entries,
    listForBot(_botId: string) {
      return [...entries.values()];
    },
    async stop(_bot: string, sid: string) {
      entries.delete(sid);
    },
  };
}

function setup(opts: {
  tokens: ResolvedAgentApiToken[];
  pool?: ReturnType<typeof fakePool>;
  clock?: () => number;
}): { base: string; pool: ReturnType<typeof fakePool> } {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-router-gaps-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);

  const bot = makeTestBotConfig("bot1");
  const config = makeTestConfig([bot]);
  config.agent_api.enabled = true;

  const pool = opts.pool ?? fakePool([]);
  server = createServer({ port: 0, hostname: "127.0.0.1" });
  registerAgentApiHealthRoute(server.router, {
    config,
    uptimeSecs: () => 1,
  });
  registerAgentApiRoutes(server.router, {
    config,
    db,
    registry: fakeRegistry(["bot1"], config) as never,
    tokens: opts.tokens,
    log: logger("router-gaps-test"),
    clock: opts.clock,
    pool: pool as never,
    orphans: {
      attach: () => {
        /* no-op */
      },
      shutdown: () => {
        /* no-op */
      },
    } as never,
  });
  return { base: `http://127.0.0.1:${server.port}`, pool };
}

beforeEach(() => {
  clockMs = Date.now();
});

afterEach(async () => {
  if (server) await server.stop();
  if (db) db.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("/v1 — CORS not enabled in v1 (PRD US-003)", () => {
  test("Origin request gets a response, but no Access-Control-* headers", async () => {
    const secret = "tok-cors-no-headers-1";
    const tok: ResolvedAgentApiToken = {
      name: "caller",
      secret,
      hash: hash(secret),
      bot_ids: ["bot1"],
      scopes: ["ask"],
    };
    const { base } = setup({ tokens: [tok] });

    const r = await fetch(`${base}/v1/health`, {
      headers: { Origin: "https://malicious.example" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(r.headers.get("Access-Control-Allow-Methods")).toBeNull();
    expect(r.headers.get("Access-Control-Allow-Headers")).toBeNull();
    expect(r.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("authenticated /v1/bots also emits no CORS headers", async () => {
    const secret = "tok-cors-bots-route1";
    const tok: ResolvedAgentApiToken = {
      name: "caller",
      secret,
      hash: hash(secret),
      bot_ids: ["bot1"],
      scopes: ["ask"],
    };
    const { base } = setup({ tokens: [tok] });
    const r = await fetch(`${base}/v1/bots`, {
      headers: {
        Authorization: `Bearer ${secret}`,
        Origin: "https://other.example",
      },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("/v1 — mapAuthFailure body fields (errors.ts)", () => {
  test("403 bot_not_permitted body includes bot_id", async () => {
    const secret = "tok-bot-not-perm-12345";
    const tok: ResolvedAgentApiToken = {
      name: "caller",
      secret,
      hash: hash(secret),
      bot_ids: ["other-bot"],
      scopes: ["ask"],
    };
    // Register a bot1 in the registry but the token only authorizes
    // "other-bot". The router checks unknown_bot first; we want bot
    // permission failure, so we need a bot the registry knows about and
    // the token doesn't list. registry knows bot1, token only knows
    // other-bot → bot_not_permitted on /v1/bots/bot1/ask.
    const { base } = setup({ tokens: [tok] });
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string; bot_id?: string };
    expect(body.error).toBe("bot_not_permitted");
    expect(body.bot_id).toBe("bot1");
  });

  test("403 scope_not_permitted body includes scope", async () => {
    const secret = "tok-scope-not-perm-12345";
    const tok: ResolvedAgentApiToken = {
      name: "caller",
      secret,
      hash: hash(secret),
      bot_ids: ["bot1"],
      scopes: ["ask"],
    };
    const { base } = setup({ tokens: [tok] });
    const r = await fetch(`${base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string; scope?: string };
    expect(body.error).toBe("scope_not_permitted");
    expect(body.scope).toBe("send");
  });
});

describe("GET /v1/turns/:id — additional status branches (US-010)", () => {
  const secret = "tok-turns-extra-1234567";
  const tok: ResolvedAgentApiToken = {
    name: "owner",
    secret,
    hash: hash(secret),
    bot_ids: ["bot1"],
    scopes: ["ask", "send"],
  };

  test("410 turn_result_expired when completed_at is older than 24h", async () => {
    // Install a fake clock that reports 25h after the turn completed.
    const now = Date.now();
    const future = now + 25 * 60 * 60 * 1000;
    const { base } = setup({ tokens: [tok], clock: () => future });

    const turnId = db.insertAskTurn({
      botId: "bot1",
      tokenName: "owner",
      sessionId: "s",
      textPreview: "hi",
      attachmentPaths: [],
    });
    db.setTurnFinalText(turnId, "answer", null, 1234);

    const r = await fetch(`${base}/v1/turns/${turnId}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(410);
    expect((await r.json()).error).toBe("turn_result_expired");
  });

  test("just under 24h still returns 200 done — boundary is exclusive of equality", async () => {
    // 23h59m past completion — must still return done, not 410.
    const future = Date.now() + 23 * 60 * 60 * 1000 + 59 * 60 * 1000;
    const { base } = setup({ tokens: [tok], clock: () => future });

    const turnId = db.insertAskTurn({
      botId: "bot1",
      tokenName: "owner",
      sessionId: "s",
      textPreview: "hi",
      attachmentPaths: [],
    });
    db.setTurnFinalText(turnId, "still-fresh", null, 1);

    const r = await fetch(`${base}/v1/turns/${turnId}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; text?: string };
    expect(body.status).toBe("done");
    expect(body.text).toBe("still-fresh");
  });

  test("completed send turn returns done WITHOUT a text field", async () => {
    // For send turns the PRD US-010 says: "text omitted; only status +
    // error" — the user already received the message via Telegram.
    const { base } = setup({ tokens: [tok] });
    db.upsertUserChat("bot1", "111222333", 555);
    const insertResult = db.insertSendTurn({
      botId: "bot1",
      tokenName: "owner",
      chatId: 555,
      markerWrappedText: "[system-message from \"x\"]\n\nhi",
      idempotencyKey: "idem-xxxxxxxxxxxxxxxxx",
      sourceLabel: "x",
      attachmentPaths: [],
    });
    // Mark it completed by hand — no runner needed for this assertion.
    db.setTurnFinalText(insertResult.turnId, "side-effect-text", null, 1);

    const r = await fetch(`${base}/v1/turns/${insertResult.turnId}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      status: string;
      text?: string;
      duration_ms?: number;
    };
    expect(body.status).toBe("done");
    expect(body.text).toBeUndefined();
    expect(body.duration_ms).toBeUndefined();
  });

  test("failed turn returns status='failed' + error", async () => {
    const { base } = setup({ tokens: [tok] });
    const turnId = db.insertAskTurn({
      botId: "bot1",
      tokenName: "owner",
      sessionId: "s",
      textPreview: "hi",
      attachmentPaths: [],
    });
    db.completeTurn(turnId, "model said no");

    const r = await fetch(`${base}/v1/turns/${turnId}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; error?: string };
    expect(body.status).toBe("failed");
    expect(body.error).toBe("model said no");
  });

  test("interrupted turn returns failed + error_text from interruptTurn", async () => {
    const { base } = setup({ tokens: [tok] });
    const turnId = db.insertAskTurn({
      botId: "bot1",
      tokenName: "owner",
      sessionId: "s",
      textPreview: "hi",
      attachmentPaths: [],
    });
    db.interruptTurn(turnId, "Gateway restarted during active turn");

    const r = await fetch(`${base}/v1/turns/${turnId}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; error?: string };
    expect(body.status).toBe("failed");
    expect(body.error).toBe("Gateway restarted during active turn");
  });

  test("interrupted turn with NULL error_text falls back to 'interrupted_by_gateway_restart' (handler default)", async () => {
    const { base } = setup({ tokens: [tok] });
    const turnId = db.insertAskTurn({
      botId: "bot1",
      tokenName: "owner",
      sessionId: "s",
      textPreview: "hi",
      attachmentPaths: [],
    });
    // Force status=interrupted with error_text=NULL via raw SQL — exercises
    // the `?? "interrupted_by_gateway_restart"` fallback in handlers/turns.ts.
    db.query(
      "UPDATE turns SET status = 'interrupted', completed_at = datetime('now'), error_text = NULL WHERE id = ?",
    ).run(turnId);

    const r = await fetch(`${base}/v1/turns/${turnId}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; error?: string };
    expect(body.status).toBe("failed");
    expect(body.error).toBe("interrupted_by_gateway_restart");
  });
});

describe("GET /v1/bots/:id/sessions — live pool snapshot (US-008 + US-015)", () => {
  test("returns the documented session shape for live entries", async () => {
    const secret = "tok-sessions-snapshot-1";
    const tok: ResolvedAgentApiToken = {
      name: "admin",
      secret,
      hash: hash(secret),
      bot_ids: ["bot1"],
      scopes: ["ask"],
    };

    const startedAt = Date.parse("2026-04-19T12:00:00.000Z");
    const lastUsed = Date.parse("2026-04-19T12:01:00.000Z");
    const hardExp = Date.parse("2026-04-20T12:00:00.000Z");

    const pool = fakePool([
      {
        sessionId: "sess-keyed",
        ephemeral: false,
        startedAtMs: startedAt,
        lastUsedAtMs: lastUsed,
        hardExpiresAtMs: hardExp,
        inflight: 0,
        state: "ready",
      },
      {
        sessionId: "eph-abc",
        ephemeral: true,
        startedAtMs: startedAt,
        lastUsedAtMs: lastUsed,
        hardExpiresAtMs: hardExp,
        inflight: 1,
        state: "busy",
      },
    ]);

    const { base } = setup({ tokens: [tok], pool });

    const r = await fetch(`${base}/v1/bots/bot1/sessions`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      sessions: Array<{
        session_id: string;
        started_at: string;
        last_used_at: string;
        hard_expires_at: string;
        state: string;
        inflight: number;
        ephemeral: boolean;
      }>;
    };
    expect(body.sessions.length).toBe(2);
    const keyed = body.sessions.find((s) => s.session_id === "sess-keyed")!;
    expect(keyed.state).toBe("ready");
    expect(keyed.inflight).toBe(0);
    expect(keyed.ephemeral).toBe(false);
    expect(keyed.started_at).toBe("2026-04-19T12:00:00.000Z");
    expect(keyed.hard_expires_at).toBe("2026-04-20T12:00:00.000Z");
    const eph = body.sessions.find((s) => s.session_id === "eph-abc")!;
    expect(eph.ephemeral).toBe(true);
    expect(eph.state).toBe("busy");
    expect(eph.inflight).toBe(1);
  });

  test("requires ask scope — send-only token gets 403", async () => {
    const secret = "tok-sessions-needs-ask-1";
    const tok: ResolvedAgentApiToken = {
      name: "inj",
      secret,
      hash: hash(secret),
      bot_ids: ["bot1"],
      scopes: ["send"],
    };
    const { base } = setup({ tokens: [tok] });
    const r = await fetch(`${base}/v1/bots/bot1/sessions`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("scope_not_permitted");
  });
});

describe("DELETE /v1/bots/:id/sessions/:sid — admin reap (US-015)", () => {
  test("204 on existing live entry; subsequent GET no longer lists it", async () => {
    const secret = "tok-delete-session-12345";
    const tok: ResolvedAgentApiToken = {
      name: "admin",
      secret,
      hash: hash(secret),
      bot_ids: ["bot1"],
      scopes: ["ask"],
    };
    const pool = fakePool([
      {
        sessionId: "sess-1",
        ephemeral: false,
        startedAtMs: Date.now(),
        lastUsedAtMs: Date.now(),
        hardExpiresAtMs: Date.now() + 60_000,
        inflight: 0,
        state: "ready",
      },
    ]);
    const { base } = setup({ tokens: [tok], pool });

    const del = await fetch(`${base}/v1/bots/bot1/sessions/sess-1`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(del.status).toBe(204);
    expect(del.headers.get("Content-Type")).toBeNull();

    const list = await fetch(`${base}/v1/bots/bot1/sessions`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { sessions: unknown[] };
    expect(body.sessions).toEqual([]);
  });

  test("404 session_not_found on missing entry (already covered, but pinned again here for the response body)", async () => {
    const secret = "tok-delete-missing-12345";
    const tok: ResolvedAgentApiToken = {
      name: "admin",
      secret,
      hash: hash(secret),
      bot_ids: ["bot1"],
      scopes: ["ask"],
    };
    const { base } = setup({ tokens: [tok] });
    const r = await fetch(`${base}/v1/bots/bot1/sessions/missing`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("session_not_found");
  });
});
