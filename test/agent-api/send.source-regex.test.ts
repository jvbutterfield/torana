// Boundary tests for the send `source` field regex (PRD US-012 line 306).
// PRD: `source` is "a short caller-chosen label (e.g. 'calendar-prep',
// max 64 chars, [a-z0-9_-])."
//
// send.test.ts already covers the "spaces" rejection but not the length
// boundary or the case-sensitivity assertion. These tests pin both.

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
import { SOURCE_LABEL_RE } from "../../src/agent-api/schemas.js";
import type { ResolvedAgentApiToken } from "../../src/config/load.js";
import { makeTestConfig, makeTestBotConfig } from "../fixtures/bots.js";

const USER_ID = 111_222_333;
const KEY = "idem-key-source-regex-1";

function hash(s: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(s, "utf8").digest());
}

let tmpDir: string;
let db: GatewayDB;
let server: Server;

function setup(secret: string): { base: string; tok: ResolvedAgentApiToken } {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-send-src-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);
  db.upsertUserChat("bot1", String(USER_ID), 555);

  const bot = makeTestBotConfig("bot1");
  const config = makeTestConfig([bot]);
  config.agent_api.enabled = true;
  const tok: ResolvedAgentApiToken = {
    name: "caller",
    secret,
    hash: hash(secret),
    bot_ids: ["bot1"],
    scopes: ["send"],
  };

  const registry = {
    bot(id: string) {
      if (id !== "bot1") return undefined;
      return {
        botConfig: bot,
        runner: { supportsSideSessions: () => true },
      };
    },
    get botIds() {
      return ["bot1"];
    },
    dispatchFor: () => {
      /* no-op */
    },
  };

  server = createServer({ port: 0, hostname: "127.0.0.1" });
  registerAgentApiHealthRoute(server.router, {
    config,
    uptimeSecs: () => 1,
  });
  registerAgentApiRoutes(server.router, {
    config,
    db,
    registry: registry as never,
    tokens: [tok],
    log: logger("send-src-test"),
    pool: { listForBot: () => [], stop: async () => {} } as never,
    orphans: { attach: () => {}, shutdown: () => {} } as never,
  });
  return { base: `http://127.0.0.1:${server.port}`, tok };
}

beforeEach(() => {
  /* setup is per-test */
});

afterEach(async () => {
  if (server) await server.stop();
  if (db) db.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

async function sendWith(
  base: string,
  secret: string,
  source: string,
  key = KEY,
): Promise<Response> {
  return fetch(`${base}/v1/bots/bot1/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({
      text: "hi",
      source,
      user_id: String(USER_ID),
    }),
  });
}

describe("send source regex — pure regex sanity", () => {
  test("regex itself: lowercase + digits + underscore + hyphen ok", () => {
    expect(SOURCE_LABEL_RE.test("calendar-prep")).toBe(true);
    expect(SOURCE_LABEL_RE.test("a")).toBe(true);
    expect(SOURCE_LABEL_RE.test("ok_1-2")).toBe(true);
    expect(SOURCE_LABEL_RE.test("z9_x-y")).toBe(true);
  });

  test("regex itself: rejects uppercase, spaces, dots, and empty", () => {
    expect(SOURCE_LABEL_RE.test("Calendar")).toBe(false);
    expect(SOURCE_LABEL_RE.test("HAS SPACES")).toBe(false);
    expect(SOURCE_LABEL_RE.test("a.b")).toBe(false);
    expect(SOURCE_LABEL_RE.test("")).toBe(false);
  });

  test("regex itself: 64-char max accepted, 65-char rejected", () => {
    expect(SOURCE_LABEL_RE.test("a".repeat(64))).toBe(true);
    expect(SOURCE_LABEL_RE.test("a".repeat(65))).toBe(false);
  });
});

describe("send source regex — HTTP-layer rejection", () => {
  test("64-char source accepted (exactly at the cap)", async () => {
    const secret = "tok-source-64-chars-1234";
    const { base } = setup(secret);
    const source = "a".repeat(64);
    const r = await sendWith(base, secret, source);
    expect(r.status).toBe(202);
    const body = (await r.json()) as { turn_id: number };
    const turn = db.getTurnExtended(body.turn_id)!;
    expect(turn.agent_api_source_label).toBe(source);
  });

  test("65-char source rejected → 400 invalid_body", async () => {
    const secret = "tok-source-65-chars-1234";
    const { base } = setup(secret);
    const r = await sendWith(base, secret, "a".repeat(65));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_body");
  });

  test("uppercase letter in source rejected → 400 invalid_body (PRD: lowercase only)", async () => {
    const secret = "tok-source-uppercase-12345";
    const { base } = setup(secret);
    const r = await sendWith(base, secret, "Calendar-Prep");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_body");
  });

  test("dot in source rejected", async () => {
    const secret = "tok-source-dot-character-1";
    const { base } = setup(secret);
    const r = await sendWith(base, secret, "calendar.prep");
    expect(r.status).toBe(400);
  });

  test("empty source rejected", async () => {
    const secret = "tok-source-empty-string-12";
    const { base } = setup(secret);
    const r = await sendWith(base, secret, "");
    expect(r.status).toBe(400);
  });
});
