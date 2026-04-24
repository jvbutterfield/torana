// Multipart + file-lifecycle integration tests for POST /v1/bots/:id/send.
// Targets the ordering discipline in tasks/impl-agent-api.md §7.1:
//
//   * files are written BEFORE the DB transaction
//   * on error AFTER writing, files are unlinked (orphan cleanup)
//   * on idempotent replay, the new request's files are deleted (the prior
//     turn owns its own first-call files)
//
// Uses a stub registry / pool / orphans — same as test/agent-api/send.test.ts —
// because send only enqueues a turn; dispatch happens through the main
// runner path (not exercised here).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
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
const KEY_A = "idem-key-multipart-0001";
const KEY_B = "idem-key-multipart-0002";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function hash(s: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(s, "utf8").digest());
}

function stubPool(): {
  listForBot: () => unknown[];
  stop: () => Promise<void>;
} {
  return { listForBot: () => [], stop: async () => {} };
}

function stubOrphans(): { attach: () => void; shutdown: () => void } {
  return { attach: () => {}, shutdown: () => {} };
}

interface RegistryStub {
  bot(id: string): unknown;
  botIds: string[];
  dispatchFor(id: string): void;
  dispatchCalls: string[];
}

function stubRegistry(config: Config, botIds: string[]): RegistryStub {
  const dispatchCalls: string[] = [];
  return {
    bot(id: string) {
      if (!botIds.includes(id)) return undefined;
      const botConfig = config.bots.find((b) => b.id === id)!;
      return {
        botConfig,
        runner: { supportsSideSessions: () => true },
      };
    },
    get botIds() {
      return botIds;
    },
    dispatchFor(id: string) {
      dispatchCalls.push(id);
    },
    dispatchCalls,
  };
}

let tmpDir: string;
let db: GatewayDB;
let server: Server;

interface SetupResult {
  base: string;
  config: Config;
  registry: RegistryStub;
}

function setup(
  tokens: ResolvedAgentApiToken[],
  configMutator: (c: Config) => void = () => {},
): SetupResult {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-send-multipart-"));
  applyMigrations(join(tmpDir, "gateway.db"));
  db = new GatewayDB(join(tmpDir, "gateway.db"));

  const config = makeTestConfig([makeTestBotConfig("bot1")], {
    gateway: {
      port: 3000,
      bind_host: "127.0.0.1",
      data_dir: tmpDir,
      db_path: join(tmpDir, "gateway.db"),
      log_level: "info",
    },
  });
  config.agent_api.enabled = true;
  configMutator(config);

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
    log: logger("send-multipart-test"),
    pool: stubPool() as never,
    orphans: stubOrphans() as never,
  });
  return { base: `http://127.0.0.1:${server.port}`, config, registry };
}

function tokenWith(
  secret: string,
  scopes: ("ask" | "send")[],
): ResolvedAgentApiToken {
  return {
    name: "caller",
    secret,
    hash: hash(secret),
    bot_ids: ["bot1"],
    scopes,
  };
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

async function attachmentsOnDisk(): Promise<string[]> {
  try {
    return await readdir(join(tmpDir, "attachments", "bot1"));
  } catch {
    return [];
  }
}

afterEach(async () => {
  if (server) await server.stop();
  if (db) db.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  /* per-test setup */
});

describe("send multipart — happy path", () => {
  test("PDF + text → turn queued, attachment on disk, path recorded", async () => {
    const secret = "tok-multipart-happy-123";
    const { base } = setup([tokenWith(secret, ["send"])]);
    db.upsertUserChat("bot1", String(USER_ID), 555);

    const r = await fetch(`${base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": KEY_A,
      },
      body: multipartBody([
        { kind: "field", name: "text", value: "please review" },
        { kind: "field", name: "source", value: "calendar-prep" },
        { kind: "field", name: "user_id", value: String(USER_ID) },
        {
          kind: "file",
          name: "attachment",
          filename: "doc.pdf",
          mime: "application/pdf",
          bytes: PDF,
        },
      ]),
    });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { turn_id: number; status: string };

    const turn = db.getTurnExtended(body.turn_id)!;
    expect(turn.status).toBe("queued");

    const paths = db.getTurnAttachments(body.turn_id);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/agentapi-[a-f0-9-]+-0\.pdf$/);

    const disk = await attachmentsOnDisk();
    expect(disk.filter((n) => n.startsWith("agentapi-"))).toHaveLength(1);
  });
});

describe("send multipart — rejection paths leave no files on disk", () => {
  test("disallowed MIME → 415 and zero agentapi files", async () => {
    const secret = "tok-multipart-badmime-1";
    const { base } = setup([tokenWith(secret, ["send"])]);
    db.upsertUserChat("bot1", String(USER_ID), 555);

    const r = await fetch(`${base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": KEY_A,
      },
      body: multipartBody([
        { kind: "field", name: "text", value: "hi" },
        { kind: "field", name: "source", value: "x" },
        { kind: "field", name: "user_id", value: String(USER_ID) },
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
    expect((await r.json()).error).toBe("attachment_mime_not_allowed");
    const disk = await attachmentsOnDisk();
    expect(disk.filter((n) => n.startsWith("agentapi-"))).toEqual([]);
  });

  test("missing target field (no user_id/chat_id) → 400 and files cleaned up", async () => {
    const secret = "tok-multipart-notarget-";
    const { base } = setup([tokenWith(secret, ["send"])]);

    const r = await fetch(`${base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": KEY_A,
      },
      body: multipartBody([
        { kind: "field", name: "text", value: "hi" },
        { kind: "field", name: "source", value: "x" },
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
    expect((await r.json()).error).toBe("missing_target");
    const disk = await attachmentsOnDisk();
    expect(disk.filter((n) => n.startsWith("agentapi-"))).toEqual([]);
  });

  test("ACL bypass (user removed) → 403 and files cleaned up", async () => {
    const secret = "tok-multipart-acl-1234";
    const { base, config } = setup([tokenWith(secret, ["send"])]);
    db.upsertUserChat("bot1", String(USER_ID), 555);
    config.access_control.allowed_user_ids = []; // admin removed the user

    const r = await fetch(`${base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": KEY_A,
      },
      body: multipartBody([
        { kind: "field", name: "text", value: "hi" },
        { kind: "field", name: "source", value: "x" },
        { kind: "field", name: "user_id", value: String(USER_ID) },
        {
          kind: "file",
          name: "f",
          filename: "a.png",
          mime: "image/png",
          bytes: PNG,
        },
      ]),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("target_not_authorized");
    const disk = await attachmentsOnDisk();
    expect(disk.filter((n) => n.startsWith("agentapi-"))).toEqual([]);
  });
});

describe("send multipart — idempotent replay file rollback", () => {
  test("replay path does NOT leave a second copy on disk", async () => {
    const secret = "tok-multipart-replay-12";
    const { base } = setup([tokenWith(secret, ["send"])]);
    db.upsertUserChat("bot1", String(USER_ID), 555);

    // First call writes a file and a turn.
    const r1 = await fetch(`${base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Idempotency-Key": KEY_A },
      body: multipartBody([
        { kind: "field", name: "text", value: "first" },
        { kind: "field", name: "source", value: "x" },
        { kind: "field", name: "user_id", value: String(USER_ID) },
        {
          kind: "file",
          name: "f",
          filename: "a.png",
          mime: "image/png",
          bytes: PNG,
        },
      ]),
    });
    expect(r1.status).toBe(202);
    const body1 = (await r1.json()) as { turn_id: number };

    const afterFirst = (await attachmentsOnDisk()).filter((n) =>
      n.startsWith("agentapi-"),
    );
    expect(afterFirst).toHaveLength(1);

    // Second call with the SAME key but different content — should replay.
    const r2 = await fetch(`${base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Idempotency-Key": KEY_A },
      body: multipartBody([
        { kind: "field", name: "text", value: "second" },
        { kind: "field", name: "source", value: "y" },
        { kind: "field", name: "user_id", value: String(USER_ID) },
        {
          kind: "file",
          name: "f",
          filename: "b.pdf",
          mime: "application/pdf",
          bytes: PDF,
        },
      ]),
    });
    expect(r2.status).toBe(202);
    const body2 = (await r2.json()) as { turn_id: number };
    expect(body2.turn_id).toBe(body1.turn_id);

    // Disk state: still only the first call's file.
    const afterSecond = (await attachmentsOnDisk()).filter((n) =>
      n.startsWith("agentapi-"),
    );
    expect(afterSecond).toEqual(afterFirst);
  });
});

describe("send multipart — aggregate + count caps", () => {
  test("over max_files_per_request → 413 and no writes", async () => {
    const secret = "tok-multipart-toomany-1";
    const { base } = setup([tokenWith(secret, ["send"])], (c) => {
      c.agent_api.ask.max_files_per_request = 1;
    });
    db.upsertUserChat("bot1", String(USER_ID), 555);

    const r = await fetch(`${base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Idempotency-Key": KEY_A },
      body: multipartBody([
        { kind: "field", name: "text", value: "hi" },
        { kind: "field", name: "source", value: "x" },
        { kind: "field", name: "user_id", value: String(USER_ID) },
        {
          kind: "file",
          name: "a",
          filename: "a.png",
          mime: "image/png",
          bytes: PNG,
        },
        {
          kind: "file",
          name: "b",
          filename: "b.png",
          mime: "image/png",
          bytes: PNG,
        },
      ]),
    });
    expect(r.status).toBe(413);
    expect((await r.json()).error).toBe("too_many_files");
    const disk = await attachmentsOnDisk();
    expect(disk.filter((n) => n.startsWith("agentapi-"))).toEqual([]);
  });
});

describe("send — idempotency key is NOT consumed by pre-commit errors", () => {
  test("bad MIME with same key → subsequent clean call succeeds and gets a fresh turn", async () => {
    const secret = "tok-multipart-keysafe-1";
    const { base } = setup([tokenWith(secret, ["send"])]);
    db.upsertUserChat("bot1", String(USER_ID), 555);

    // First call: bad MIME → 415, key NOT consumed.
    const r1 = await fetch(`${base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Idempotency-Key": KEY_B },
      body: multipartBody([
        { kind: "field", name: "text", value: "hi" },
        { kind: "field", name: "source", value: "x" },
        { kind: "field", name: "user_id", value: String(USER_ID) },
        {
          kind: "file",
          name: "f",
          filename: "evil.exe",
          mime: "application/x-msdownload",
          bytes: new Uint8Array([0x4d, 0x5a]),
        },
      ]),
    });
    expect(r1.status).toBe(415);

    // Second call: same key, valid body → new turn created.
    const r2 = await fetch(`${base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Idempotency-Key": KEY_B },
      body: multipartBody([
        { kind: "field", name: "text", value: "hi" },
        { kind: "field", name: "source", value: "x" },
        { kind: "field", name: "user_id", value: String(USER_ID) },
      ]),
    });
    expect(r2.status).toBe(202);
    const body2 = (await r2.json()) as { turn_id: number };
    expect(body2.turn_id).toBeGreaterThan(0);
  });
});
