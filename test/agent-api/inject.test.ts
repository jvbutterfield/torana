// Integration tests for POST /v1/bots/:id/inject — exercises auth + body
// validation + idempotency + chat resolution + ACL against a real HTTP
// server. Uses a stub registry (no real runner spawn) because inject
// only enqueues a turn; dispatch goes through the main runner path which
// we don't need to exercise here.

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

const USER_ID = 111_222_333;

function hash(s: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(s, "utf8").digest());
}

let tmpDir: string;
let db: GatewayDB;
let server: Server;

function stubPool(): {
  listForBot: () => unknown[];
  stop: () => Promise<void>;
} {
  return {
    listForBot: () => [],
    stop: async () => {
      /* ok */
    },
  };
}

function stubOrphans(): { attach: () => void; shutdown: () => void } {
  return {
    attach: () => {
      /* ok */
    },
    shutdown: () => {
      /* ok */
    },
  };
}

interface RegistryStub {
  bot(id: string): unknown;
  botIds: string[];
  dispatchCalls: string[];
  dispatchFor(id: string): void;
}

function stubRegistry(config: Config, botIds: string[]): RegistryStub {
  const dispatchCalls: string[] = [];
  return {
    bot(id: string) {
      if (!botIds.includes(id)) return undefined;
      const botConfig = config.bots.find((b) => b.id === id);
      if (!botConfig) return undefined;
      return {
        botConfig,
        runner: { supportsSideSessions: () => true },
      };
    },
    get botIds() {
      return botIds;
    },
    dispatchCalls,
    dispatchFor(id: string) {
      dispatchCalls.push(id);
    },
  };
}

interface SetupResult {
  base: string;
  registry: RegistryStub;
  config: Config;
}

function setup(tokens: ResolvedAgentApiToken[]): SetupResult {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-inject-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);

  const bot = makeTestBotConfig("bot1");
  const config = makeTestConfig([bot]);
  config.agent_api.enabled = true;

  const registry = stubRegistry(config, ["bot1"]);

  server = createServer({ port: 0, hostname: "127.0.0.1" });
  registerAgentApiHealthRoute(server.router, {
    config,
    uptimeSecs: () => 1,
  });
  registerAgentApiRoutes(server.router, {
    config,
    db,
    registry: registry as never,
    tokens,
    log: logger("inject-test"),
    pool: stubPool() as never,
    orphans: stubOrphans() as never,
  });
  return { base: `http://127.0.0.1:${server.port}`, registry, config };
}

function tokenWith(
  secret: string,
  scopes: ("ask" | "inject")[],
  name = "caller",
): ResolvedAgentApiToken {
  return {
    name,
    secret,
    hash: hash(secret),
    bot_ids: ["bot1"],
    scopes,
  };
}

const KEY_A = "idem-key-aaaaaaaaaaaaaa";
const KEY_B = "idem-key-bbbbbbbbbbbbbb";

afterEach(async () => {
  if (server) await server.stop();
  if (db) db.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  /* per-test setup */
});

describe("POST /v1/bots/:id/inject — happy path", () => {
  test("user_id resolves via user_chats and enqueues a turn", async () => {
    const secret = "tok-inject-happy-1234";
    const { base, registry } = setup([tokenWith(secret, ["inject"])]);
    db.upsertUserChat("bot1", String(USER_ID), 555);

    const r = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": KEY_A,
      },
      body: JSON.stringify({
        text: "hello there",
        source: "calendar-prep",
        user_id: String(USER_ID),
      }),
    });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { turn_id: number; status: string };
    expect(body.turn_id).toBeGreaterThan(0);
    expect(body.status).toBe("queued");

    // Turn is in the DB as queued with the right source metadata.
    const turn = db.getTurnExtended(body.turn_id)!;
    expect(turn.status).toBe("queued");
    expect(turn.source).toBe("agent_api_inject");
    expect(turn.agent_api_source_label).toBe("calendar-prep");
    expect(turn.idempotency_key).toBe(KEY_A);
    expect(turn.chat_id).toBe(555);

    // Marker-wrapped prompt round-trips via getTurnText.
    const text = db.getTurnText(body.turn_id);
    expect(text).toBe(
      '[system-injected from "calendar-prep"]\n\nhello there',
    );

    // Dispatch was woken for this bot.
    expect(registry.dispatchCalls).toContain("bot1");
  });

  test("chat_id pass-through is accepted when chat is known for this bot", async () => {
    const secret = "tok-inject-chatid-123";
    const { base } = setup([tokenWith(secret, ["inject"])]);
    db.upsertUserChat("bot1", String(USER_ID), 555);

    const r = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": KEY_A,
      },
      body: JSON.stringify({
        text: "hi",
        source: "tick",
        chat_id: 555,
      }),
    });
    expect(r.status).toBe(202);
  });
});

describe("POST /v1/bots/:id/inject — validation", () => {
  test("missing Idempotency-Key → 400 missing_idempotency_key", async () => {
    const secret = "tok-missing-key-12345";
    const { base } = setup([tokenWith(secret, ["inject"])]);
    const r = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "hi",
        source: "x",
        user_id: String(USER_ID),
      }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("missing_idempotency_key");
  });

  test("malformed Idempotency-Key → 400 invalid_idempotency_key", async () => {
    const secret = "tok-bad-key-123456789";
    const { base } = setup([tokenWith(secret, ["inject"])]);
    const r = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "too-short",
      },
      body: JSON.stringify({
        text: "hi",
        source: "x",
        user_id: String(USER_ID),
      }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_idempotency_key");
  });

  test("missing user_id AND chat_id → 400 missing_target", async () => {
    const secret = "tok-no-target-1234567";
    const { base } = setup([tokenWith(secret, ["inject"])]);
    const r = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": KEY_A,
      },
      body: JSON.stringify({ text: "hi", source: "x" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("missing_target");
  });

  test("bad source regex → 400 invalid_body", async () => {
    const secret = "tok-bad-source-123456";
    const { base } = setup([tokenWith(secret, ["inject"])]);
    const r = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": KEY_A,
      },
      body: JSON.stringify({
        text: "hi",
        source: "HAS SPACES",
        user_id: String(USER_ID),
      }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_body");
  });

  test("malformed JSON body → 400 invalid_body", async () => {
    const secret = "tok-bad-json-12345678";
    const { base } = setup([tokenWith(secret, ["inject"])]);
    const r = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": KEY_A,
      },
      body: "{not json",
    });
    expect(r.status).toBe(400);
  });
});

describe("POST /v1/bots/:id/inject — target resolution", () => {
  test("user_id that never DMed the bot → 409 user_not_opened_bot", async () => {
    const secret = "tok-no-open-123456789";
    const { base } = setup([tokenWith(secret, ["inject"])]);
    // No upsertUserChat — user has never DMed.
    const r = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": KEY_A,
      },
      body: JSON.stringify({
        text: "hi",
        source: "x",
        user_id: String(USER_ID),
      }),
    });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("user_not_opened_bot");
  });

  test("chat_id forgery (chat belongs to another bot) → 403 chat_not_permitted", async () => {
    const secret = "tok-chat-forgery-1234";
    const { base } = setup([tokenWith(secret, ["inject"])]);
    db.upsertUserChat("other-bot", String(USER_ID), 555);
    const r = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": KEY_A,
      },
      body: JSON.stringify({
        text: "hi",
        source: "x",
        chat_id: 555,
      }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("chat_not_permitted");
  });

  test("user no longer in ACL → 403 target_not_authorized", async () => {
    const secret = "tok-acl-bypass-123456";
    const { base, config } = setup([tokenWith(secret, ["inject"])]);
    db.upsertUserChat("bot1", String(USER_ID), 555);
    // Admin removed the user from the ACL between their last DM and the inject call.
    config.access_control.allowed_user_ids = [];

    const r = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": KEY_A,
      },
      body: JSON.stringify({
        text: "hi",
        source: "x",
        user_id: String(USER_ID),
      }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("target_not_authorized");
  });
});

describe("POST /v1/bots/:id/inject — idempotency", () => {
  test("duplicate key returns the same turn_id; body is ignored on replay", async () => {
    const secret = "tok-idem-replay-12345";
    const { base } = setup([tokenWith(secret, ["inject"])]);
    db.upsertUserChat("bot1", String(USER_ID), 555);

    const r1 = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": KEY_A,
      },
      body: JSON.stringify({
        text: "first",
        source: "x",
        user_id: String(USER_ID),
      }),
    });
    expect(r1.status).toBe(202);
    const body1 = (await r1.json()) as { turn_id: number };

    const r2 = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": KEY_A,
      },
      // Intentionally different body — must be ignored.
      body: JSON.stringify({
        text: "second (different!)",
        source: "y",
        user_id: String(USER_ID),
      }),
    });
    expect(r2.status).toBe(202);
    const body2 = (await r2.json()) as { turn_id: number };

    expect(body2.turn_id).toBe(body1.turn_id);

    // Persisted text comes from the first call.
    const stored = db.getTurnText(body1.turn_id);
    expect(stored).toBe('[system-injected from "x"]\n\nfirst');
  });

  test("a second call with a different key creates a new turn", async () => {
    const secret = "tok-idem-fresh-123456";
    const { base } = setup([tokenWith(secret, ["inject"])]);
    db.upsertUserChat("bot1", String(USER_ID), 555);

    const r1 = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": KEY_A,
      },
      body: JSON.stringify({
        text: "first",
        source: "x",
        user_id: String(USER_ID),
      }),
    });
    const body1 = (await r1.json()) as { turn_id: number };

    const r2 = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": KEY_B,
      },
      body: JSON.stringify({
        text: "second",
        source: "y",
        user_id: String(USER_ID),
      }),
    });
    const body2 = (await r2.json()) as { turn_id: number };

    expect(body2.turn_id).not.toBe(body1.turn_id);
  });
});

describe("POST /v1/bots/:id/inject — scope enforcement", () => {
  test("token with only ask scope → 403 scope_not_permitted", async () => {
    const secret = "tok-ask-only-12345678";
    const { base } = setup([tokenWith(secret, ["ask"])]);
    const r = await fetch(`${base}/v1/bots/bot1/inject`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": KEY_A,
      },
      body: JSON.stringify({
        text: "hi",
        source: "x",
        user_id: String(USER_ID),
      }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("scope_not_permitted");
  });
});
