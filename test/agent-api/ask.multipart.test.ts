// Multipart + file-lifecycle tests for POST /v1/bots/:id/ask.
// Focus: rejection paths leave no files behind, and the happy path persists
// the attachment path onto the turn row so the runner receives it.
//
// Uses a real ClaudeCodeRunner with the mock claude binary (same harness
// as ask.test.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer, type Server } from "../../src/server.js";
import {
  registerAgentApiHealthRoute,
  registerAgentApiRoutes,
} from "../../src/agent-api/router.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { SideSessionPool } from "../../src/agent-api/pool.js";
import { OrphanListenerManager } from "../../src/agent-api/orphan-listeners.js";
import { ClaudeCodeRunner } from "../../src/runner/claude-code.js";
import { logger } from "../../src/log.js";
import type { ResolvedAgentApiToken } from "../../src/config/load.js";
import { makeTestConfig, makeTestBotConfig } from "../fixtures/bots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(__dirname, "../runner/fixtures/claude-mock.ts");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function hash(s: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(s, "utf8").digest());
}

function multipartBody(
  parts: Array<
    | { kind: "field"; name: string; value: string }
    | {
        kind: "file";
        name: string;
        filename: string;
        mime: string;
        bytes: Uint8Array;
      }
  >,
): FormData {
  const form = new FormData();
  for (const p of parts) {
    if (p.kind === "field") form.append(p.name, p.value);
    else
      form.append(
        p.name,
        new Blob([p.bytes as unknown as ArrayBuffer], { type: p.mime }),
        p.filename,
      );
  }
  return form;
}

function tokenFor(secret: string): ResolvedAgentApiToken {
  return {
    name: "caller",
    secret,
    hash: hash(secret),
    bot_ids: ["bot1"],
    scopes: ["ask"],
  };
}

let tmpDir: string;
let db: GatewayDB;
let runner: ClaudeCodeRunner | null = null;
let pool: SideSessionPool | null = null;
let orphans: OrphanListenerManager | null = null;
let server: Server;

async function attachmentsOnDisk(): Promise<string[]> {
  try {
    return await readdir(join(tmpDir, "attachments", "bot1"));
  } catch {
    return [];
  }
}

async function setup(
  tokens: ResolvedAgentApiToken[],
  opts: { maxPerBot?: number } = {},
): Promise<{ base: string }> {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-ask-multipart-"));
  applyMigrations(join(tmpDir, "gateway.db"));
  db = new GatewayDB(join(tmpDir, "gateway.db"));

  const bot = makeTestBotConfig("bot1", {
    runner: {
      type: "claude-code",
      cli_path: "bun",
      args: ["run", MOCK, "normal"],
      env: {},
      pass_continue_flag: false,
      acknowledge_dangerous: true,
    },
  });
  const config = makeTestConfig([bot], {
    gateway: {
      port: 3000,
      bind_host: "127.0.0.1",
      data_dir: tmpDir,
      db_path: join(tmpDir, "gateway.db"),
      log_level: "info",
    },
  });
  config.agent_api.enabled = true;
  if (opts.maxPerBot !== undefined) {
    config.agent_api.side_sessions.max_per_bot = opts.maxPerBot;
  }

  runner = new ClaudeCodeRunner({
    botId: "bot1",
    config: bot.runner as Extract<typeof bot.runner, { type: "claude-code" }>,
    logDir: tmpDir,
    protocolFlags: [],
    startupMs: 100,
  });

  const registry = {
    bot(id: string) {
      if (id !== "bot1") return undefined;
      return {
        botConfig: { id: "bot1", runner: { type: "claude-code" } },
        runner,
      };
    },
    get botIds() {
      return ["bot1"];
    },
  };

  pool = new SideSessionPool({
    config,
    db,
    registry: registry as never,
    sweepIntervalMs: 60_000,
  });
  orphans = new OrphanListenerManager(db, pool);

  server = createServer({ port: 0, hostname: "127.0.0.1" });
  registerAgentApiHealthRoute(server.router, { config, uptimeSecs: () => 1 });
  registerAgentApiRoutes(server.router, {
    config,
    db,
    registry: registry as never,
    tokens,
    log: logger("ask-multipart-test"),
    pool,
    orphans,
  });
  return { base: `http://127.0.0.1:${server.port}` };
}

beforeEach(() => {
  /* per-test setup */
});

afterEach(async () => {
  try {
    if (orphans) orphans.shutdown();
    if (pool) await pool.shutdown(1000);
    if (server) await server.stop();
  } finally {
    if (db) db.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    runner = null;
    pool = null;
    orphans = null;
  }
});

describe("POST /v1/bots/:id/ask — multipart happy path", () => {
  test("PNG + text → 200 and attachment path persisted on turn", async () => {
    const secret = "tok-ask-multipart-happy";
    const { base } = await setup([tokenFor(secret)]);
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: multipartBody([
        { kind: "field", name: "text", value: "hello" },
        {
          kind: "file",
          name: "f",
          filename: "a.png",
          mime: "image/png",
          bytes: PNG,
        },
      ]),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { turn_id: number; text: string };
    // Mock echoes the full prompt — the claude protocol encoder appends
    // "[Attached file: <path>]" lines after the text, so we assert on the
    // prompt prefix rather than exact equality.
    expect(body.text).toContain("echo: hello");
    expect(body.text).toContain("[Attached file:");

    const paths = db.getTurnAttachments(body.turn_id);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/agentapi-[a-f0-9-]+-0\.png$/);

    const disk = (await attachmentsOnDisk()).filter((n) =>
      n.startsWith("agentapi-"),
    );
    expect(disk).toHaveLength(1);
  }, 15_000);
});

describe("POST /v1/bots/:id/ask — multipart rejections leave no files", () => {
  test("disallowed MIME → 415 and no files on disk", async () => {
    const secret = "tok-ask-multipart-mime1";
    const { base } = await setup([tokenFor(secret)]);
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: multipartBody([
        { kind: "field", name: "text", value: "hi" },
        {
          kind: "file",
          name: "f",
          filename: "evil.exe",
          mime: "application/x-msdownload",
          bytes: new Uint8Array([0x4d, 0x5a]),
        },
      ]),
    });
    expect(r.status).toBe(415);
    const disk = (await attachmentsOnDisk()).filter((n) =>
      n.startsWith("agentapi-"),
    );
    expect(disk).toEqual([]);
  });

  test("invalid session_id (zod fail AFTER file write) → 400 and cleanup", async () => {
    // parseMultipartRequest writes the file before zod validates the
    // fields. A bad session_id trips zod's regex check, at which point
    // the handler must unlink the just-written file.
    const secret = "tok-ask-multipart-zod123";
    const { base } = await setup([tokenFor(secret)]);
    const r = await fetch(`${base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: multipartBody([
        { kind: "field", name: "text", value: "hi" },
        { kind: "field", name: "session_id", value: "has space" },
        {
          kind: "file",
          name: "f",
          filename: "a.png",
          mime: "image/png",
          bytes: PNG,
        },
      ]),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_body");
    const disk = (await attachmentsOnDisk()).filter((n) =>
      n.startsWith("agentapi-"),
    );
    expect(disk).toEqual([]);
  });
});
