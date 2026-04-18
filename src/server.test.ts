import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { GatewayDB } from "./db.js";
import { createServer } from "./server.js";
import type { Config, PersonaName } from "./config.js";
import type { TelegramClient } from "./telegram.js";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testConfig: Config = {
  port: 0, // Will be overridden by Bun
  dataRoot: tmpdir(),
  dbPath: "",
  webhookBaseUrl: "https://test.example.com",
  webhookSecret: "test-secret-123",
  allowedUserId: "8208257729",
  logLevel: "error",
  botTokens: { cato: "t1", harper: "t2", trader: "t3" },
  workerStartupTimeoutMs: 60000,
  workerStallTimeoutMs: 90000,
  workerTurnTimeoutMs: 1200000,
  crashLoopBackoffBaseMs: 5000,
  crashLoopBackoffCapMs: 300000,
  stabilityWindowMs: 600000,
  maxConsecutiveFailures: 10,
  editCadenceMs: 1500,
  messageLengthLimit: 4096,
  messageLengthSafeMargin: 3800,
  outboxMaxAttempts: 5,
  outboxRetryBaseMs: 2000,
  oauthToken: "token",
  githubToken: "ghtoken",
};

let db: GatewayDB;
let dbPath: string;
let server: ReturnType<typeof createServer>;
let baseUrl: string;
let inboundCalls: any[];

function mockClient(): TelegramClient {
  return {
    setMessageReaction: async () => true,
    getFile: async () => null,
    downloadFile: async () => null,
    sendMessage: async () => ({ messageId: 1 }),
    editMessageText: async () => true,
    setWebhook: async () => true,
  } as any;
}

beforeEach(() => {
  dbPath = join(tmpdir(), `gateway-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  testConfig.dbPath = dbPath;
  db = new GatewayDB(dbPath);
  db.initWorkerState("cato");
  db.initWorkerState("harper");
  db.initWorkerState("trader");
  inboundCalls = [];

  const clients = new Map<PersonaName, TelegramClient>();
  clients.set("cato", mockClient());
  clients.set("harper", mockClient());
  clients.set("trader", mockClient());

  server = createServer(
    testConfig,
    db,
    clients,
    (...args) => { inboundCalls.push(args); },
    () => ({
      cato: { worker: "ready", mailbox_depth: 0, last_turn_at: null },
      harper: { worker: "ready", mailbox_depth: 0, last_turn_at: null },
      trader: { worker: "busy", mailbox_depth: 1, last_turn_at: "2026-04-10T00:00:00Z" },
    }),
  );

  baseUrl = `http://localhost:${server.port}`;
});

afterEach(() => {
  server.stop();
  db.close();
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(dbPath + "-wal"); } catch {}
  try { unlinkSync(dbPath + "-shm"); } catch {}
});

describe("health endpoint", () => {
  test("GET /health without auth returns minimal status", async () => {
    const resp = await fetch(`${baseUrl}/health`);
    expect(resp.status).toBe(200);

    const body = await resp.json() as any;
    expect(body.status).toBe("ok");
    expect(body.personas).toBeUndefined();
    expect(body.uptime_secs).toBeUndefined();
  });

  test("GET /health with auth returns full detail", async () => {
    const resp = await fetch(`${baseUrl}/health`, {
      headers: { "Authorization": "Bearer test-secret-123" },
    });
    expect(resp.status).toBe(200);

    const body = await resp.json() as any;
    expect(body.status).toBe("ok");
    expect(body.personas.cato.worker).toBe("ready");
    expect(body.personas.trader.worker).toBe("busy");
    expect(body.uptime_secs).toBeGreaterThanOrEqual(0);
  });

  test("GET /health with wrong auth returns minimal status", async () => {
    const resp = await fetch(`${baseUrl}/health`, {
      headers: { "Authorization": "Bearer wrong-secret" },
    });
    expect(resp.status).toBe(200);

    const body = await resp.json() as any;
    expect(body.status).toBe("ok");
    expect(body.personas).toBeUndefined();
  });
});

describe("webhook endpoint", () => {
  test("rejects missing webhook secret", async () => {
    const resp = await fetch(`${baseUrl}/webhook/cato`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1, message: { text: "hi", chat: { id: 123 }, message_id: 1, from: { id: 8208257729 } } }),
    });
    expect(resp.status).toBe(403);
  });

  test("rejects invalid webhook secret", async () => {
    const resp = await fetch(`${baseUrl}/webhook/cato`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong-secret",
      },
      body: JSON.stringify({ update_id: 1, message: { text: "hi", chat: { id: 123 }, message_id: 1, from: { id: 8208257729 } } }),
    });
    expect(resp.status).toBe(403);
  });

  test("rejects unauthorized sender", async () => {
    const resp = await fetch(`${baseUrl}/webhook/cato`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "test-secret-123",
      },
      body: JSON.stringify({
        update_id: 1,
        message: { text: "hi", chat: { id: 123 }, message_id: 1, from: { id: 999999 } },
      }),
    });
    expect(resp.status).toBe(403);
  });

  test("accepts valid webhook and stores update", async () => {
    const resp = await fetch(`${baseUrl}/webhook/cato`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "test-secret-123",
      },
      body: JSON.stringify({
        update_id: 42,
        message: { text: "hello", chat: { id: 123 }, message_id: 1, from: { id: 8208257729 } },
      }),
    });
    expect(resp.status).toBe(200);

    // Wait briefly for async processing
    await new Promise(r => setTimeout(r, 100));

    // Inbound handler should have been called
    expect(inboundCalls.length).toBe(1);
    expect(inboundCalls[0][0]).toBe("cato"); // persona
  });

  test("deduplicates same update_id", async () => {
    const payload = {
      update_id: 42,
      message: { text: "hello", chat: { id: 123 }, message_id: 1, from: { id: 8208257729 } },
    };
    const headers = {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": "test-secret-123",
    };

    await fetch(`${baseUrl}/webhook/cato`, { method: "POST", headers, body: JSON.stringify(payload) });
    await fetch(`${baseUrl}/webhook/cato`, { method: "POST", headers, body: JSON.stringify(payload) });

    await new Promise(r => setTimeout(r, 100));

    // Should only process once
    expect(inboundCalls.length).toBe(1);
  });

  test("returns 404 for unknown routes", async () => {
    const resp = await fetch(`${baseUrl}/webhook/unknown`, { method: "POST" });
    expect(resp.status).toBe(404);
  });

  test("returns 404 for GET on webhook", async () => {
    const resp = await fetch(`${baseUrl}/webhook/cato`);
    expect(resp.status).toBe(404);
  });

  test("handles non-message update (e.g. edited_message) gracefully", async () => {
    const resp = await fetch(`${baseUrl}/webhook/cato`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "test-secret-123",
      },
      body: JSON.stringify({
        update_id: 50,
        edited_message: { text: "edited", chat: { id: 123 }, message_id: 1, from: { id: 8208257729 } },
      }),
    });
    expect(resp.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(inboundCalls.length).toBe(0);
  });

  test("handles malformed JSON body", async () => {
    const resp = await fetch(`${baseUrl}/webhook/cato`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "test-secret-123",
      },
      body: "not json {{{",
    });
    expect(resp.status).toBe(400);
  });

  test("handles message with missing chat.id", async () => {
    const resp = await fetch(`${baseUrl}/webhook/cato`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "test-secret-123",
      },
      body: JSON.stringify({
        update_id: 60,
        message: { text: "hi", message_id: 1, from: { id: 8208257729 } },
        // chat is missing entirely
      }),
    });
    expect(resp.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(inboundCalls.length).toBe(0);
  });

  test("handles message with missing from.id", async () => {
    const resp = await fetch(`${baseUrl}/webhook/cato`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "test-secret-123",
      },
      body: JSON.stringify({
        update_id: 70,
        message: { text: "hi", chat: { id: 123 }, message_id: 1 },
        // from is missing
      }),
    });
    expect(resp.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(inboundCalls.length).toBe(0);
  });

  test("handles caption-only message (photo with caption)", async () => {
    const resp = await fetch(`${baseUrl}/webhook/cato`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "test-secret-123",
      },
      body: JSON.stringify({
        update_id: 80,
        message: {
          caption: "look at this photo",
          chat: { id: 123 },
          message_id: 1,
          from: { id: 8208257729 },
          photo: [{ file_id: "small", width: 90 }, { file_id: "large", width: 800 }],
        },
      }),
    });
    expect(resp.status).toBe(200);
    await new Promise(r => setTimeout(r, 200));
    expect(inboundCalls.length).toBe(1);
    // The server extracts message.text || message.caption, so caption should come through
    // But text param (index 5) is extracted before async processing, while inbound is called async
    // The text is passed as "" because the inbound handler receives _text which comes from the sync path
  });

  test("same update_id for different personas is not a duplicate", async () => {
    const headers = {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": "test-secret-123",
    };
    const payload = (persona: string) => ({
      update_id: 99,
      message: { text: "hello", chat: { id: 123 }, message_id: 1, from: { id: 8208257729 } },
    });

    await fetch(`${baseUrl}/webhook/cato`, { method: "POST", headers, body: JSON.stringify(payload("cato")) });
    await fetch(`${baseUrl}/webhook/harper`, { method: "POST", headers, body: JSON.stringify(payload("harper")) });

    await new Promise(r => setTimeout(r, 200));
    expect(inboundCalls.length).toBe(2);
    expect(inboundCalls[0][0]).toBe("cato");
    expect(inboundCalls[1][0]).toBe("harper");
  });
});

describe("health endpoint edge cases", () => {
  test("returns 503 when a worker is degraded", async () => {
    // Recreate server with degraded health provider
    server.stop();
    db.close();

    dbPath = join(tmpdir(), `gateway-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    testConfig.dbPath = dbPath;
    db = new GatewayDB(dbPath);

    const clients = new Map<PersonaName, TelegramClient>();
    clients.set("cato", mockClient());
    clients.set("harper", mockClient());
    clients.set("trader", mockClient());

    server = createServer(
      testConfig, db, clients,
      (...args) => { inboundCalls.push(args); },
      () => ({
        cato: { worker: "ready", mailbox_depth: 0, last_turn_at: null },
        harper: { worker: "degraded", mailbox_depth: 0, last_turn_at: null, error: "auth failure" },
        trader: { worker: "ready", mailbox_depth: 0, last_turn_at: null },
      }),
    );
    baseUrl = `http://localhost:${server.port}`;

    // Unauthenticated: still returns 503 but minimal body
    const resp = await fetch(`${baseUrl}/health`);
    expect(resp.status).toBe(503);
    const body = await resp.json() as any;
    expect(body.status).toBe("degraded");
    expect(body.personas).toBeUndefined();

    // Authenticated: returns full detail including error
    const authResp = await fetch(`${baseUrl}/health`, {
      headers: { "Authorization": "Bearer test-secret-123" },
    });
    expect(authResp.status).toBe(503);
    const authBody = await authResp.json() as any;
    expect(authBody.status).toBe("degraded");
    expect(authBody.personas.harper.error).toBe("auth failure");
  });
});
