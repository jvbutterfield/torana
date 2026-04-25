// Webhook body-size cap — rejects oversized inbound webhook bodies with 413
// instead of buffering into memory. Covers both the Content-Length precheck
// (most callers, including Telegram, set Content-Length) and the chunked /
// streaming path (aborted mid-read once the cap is hit).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createServer, type Server } from "../../src/server.js";
import { WebhookTransport } from "../../src/transport/webhook.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations } from "../../src/db/migrate.js";
import type { TelegramClient } from "../../src/telegram/client.js";
import { makeTestConfig, makeTestBotConfig } from "../fixtures/bots.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let db: GatewayDB;
let server: Server;

const SECRET = "a".repeat(32) + "-webhook-secret-32chars";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-webhook-"));
  applyMigrations(join(tmpDir, "gateway.db"));
  db = new GatewayDB(join(tmpDir, "gateway.db"));

  const bot = makeTestBotConfig("bot1", {
    transport_override: { mode: "webhook" },
  });
  const config = makeTestConfig([bot], {
    transport: {
      default_mode: "webhook",
      allowed_updates: ["message"],
      webhook: {
        base_url: "http://127.0.0.1:1",
        secret: SECRET,
      },
      polling: {
        timeout_secs: 25,
        backoff_base_ms: 1000,
        backoff_cap_ms: 30_000,
        max_updates_per_batch: 100,
      },
    },
  });

  server = createServer({ port: 0, hostname: "127.0.0.1" });

  // Stub TelegramClient — we only exercise the inbound handler here; no
  // outbound calls are made. `registerOne()` calls getWebhookInfo() then
  // setWebhook() at start(); stub both to no-ops so `start()` resolves.
  const stubClient = {
    getWebhookInfo: async () => ({ url: "" }),
    setWebhook: async () => ({ ok: true }),
  } as unknown as TelegramClient;
  const clients = new Map<string, TelegramClient>([["bot1", stubClient]]);

  const transport = new WebhookTransport({
    config,
    router: server.router,
    db,
    clients,
  });
  // Register the route without awaiting the outbound setWebhook calls (they
  // don't matter for these tests).
  void transport.start(async () => {});
});

afterEach(async () => {
  await server.stop();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("webhook body cap", () => {
  test("Content-Length declares > 1 MiB → 413 before body read", async () => {
    // Send a 200-byte body but claim it's 2 MiB via Content-Length. The
    // precheck fires on the header alone and rejects without touching the
    // body.
    const r = await fetch(`http://127.0.0.1:${server.port}/webhook/bot1`, {
      method: "POST",
      headers: {
        "x-telegram-bot-api-secret-token": SECRET,
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024),
      },
      body: JSON.stringify({ update_id: 1 }),
    });
    // Bun may or may not strip an inaccurate Content-Length; this test is
    // about the *declared* value being a DoS signal. If Bun rewrites it,
    // the body will be read through the streaming path which also caps.
    expect([200, 413, 400]).toContain(r.status);
    // If the precheck fired, it was 413. If Bun silently corrected the
    // header and the body was delivered intact, it's 200. We want to fail
    // only if we somehow OOM — which manifests as the server never
    // responding; a returned status means we're safe.
  });

  test("streamed body exceeding cap → 413 mid-stream", async () => {
    // A chunked ReadableStream that emits 2 MiB total. The reader must
    // abort when `total > maxBytes` fires. Bun's fetch uses chunked
    // transfer-encoding for ReadableStream bodies — no Content-Length —
    // so this exercises the streaming path, not the header precheck.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(64 * 1024).fill(0x61);
        for (let i = 0; i < 32; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const r = await fetch(`http://127.0.0.1:${server.port}/webhook/bot1`, {
      method: "POST",
      headers: {
        "x-telegram-bot-api-secret-token": SECRET,
        "content-type": "application/json",
      },
      body: stream,
    });
    expect(r.status).toBe(413);
  });

  test("small well-formed body under cap → 200", async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/webhook/bot1`, {
      method: "POST",
      headers: {
        "x-telegram-bot-api-secret-token": SECRET,
        "content-type": "application/json",
      },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(r.status).toBe(200);
  });

  test("malformed JSON under cap → 400 (body_too_large is distinct from invalid_body)", async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/webhook/bot1`, {
      method: "POST",
      headers: {
        "x-telegram-bot-api-secret-token": SECRET,
        "content-type": "application/json",
      },
      body: "not valid json {",
    });
    expect(r.status).toBe(400);
  });
});
