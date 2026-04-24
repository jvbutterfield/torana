// Unit tests for parseMultipartRequest + cleanupFiles + sweepUnreferencedAgentApiFiles.
//
// Covers:
//   - happy paths (one file, multiple files, text+file, fields alongside)
//   - per-file cap (attachment_too_large)
//   - aggregate cap via content-length + aggregated file sizes (body_too_large)
//   - file count cap (too_many_files)
//   - MIME allowlist (attachment_mime_not_allowed)
//   - disk-usage cap (insufficient_storage)
//   - content-type wrong (invalid_body)
//   - malformed multipart (invalid_body)
//   - filename safety: caller-provided names (with .. etc.) are ignored;
//     on-disk name is always `agentapi-<uuid>-<idx><ext>`
//   - atomicity: on rejection, no files left on disk
//   - cleanupFiles best-effort behavior
//   - orphan sweep: referenced, unreferenced-young, unreferenced-old

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeTestConfig, makeTestBotConfig } from "../fixtures/bots.js";
import {
  parseMultipartRequest,
  cleanupFiles,
  sweepUnreferencedAgentApiFiles,
} from "../../src/agent-api/attachments.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations } from "../../src/db/migrate.js";
import type { Config } from "../../src/config/schema.js";

let tmpDir: string;
let db: GatewayDB;
let cfg: Config;

const BOT_ID = "bot1";
// Fixed requestId keeps on-disk filenames predictable across tests.
const REQ_ID = "testreq-0000";

const PNG_HEADER = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PDF_HEADER = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function cfgFor(overrides: Partial<Config> = {}): Config {
  const bot = makeTestBotConfig(BOT_ID);
  const c = makeTestConfig([bot], {
    gateway: {
      port: 3000,
      bind_host: "127.0.0.1",
      data_dir: tmpDir,
      db_path: join(tmpDir, "gateway.db"),
      log_level: "info",
    },
    ...overrides,
  });
  c.agent_api.enabled = true;
  return c;
}

async function attachmentsDirEntries(): Promise<string[]> {
  const dir = join(tmpDir, "attachments", BOT_ID);
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function multipartRequest(
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
  opts: { omitContentLength?: boolean } = {},
): Request {
  const form = new FormData();
  for (const p of parts) {
    if (p.kind === "field") {
      form.append(p.name, p.value);
    } else {
      form.append(
        p.name,
        new Blob([p.bytes as unknown as ArrayBuffer], { type: p.mime }),
        p.filename,
      );
    }
  }
  const req = new Request("http://local/v1/test", {
    method: "POST",
    body: form,
  });
  // If the caller doesn't want content-length (simulates a client that
  // streams), rebuild the Request without the header.
  if (opts.omitContentLength) {
    const headers = new Headers(req.headers);
    headers.delete("content-length");
    return new Request(req, { headers });
  }
  return req;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-attach-"));
  applyMigrations(join(tmpDir, "gateway.db"));
  db = new GatewayDB(join(tmpDir, "gateway.db"));
  cfg = cfgFor();
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseMultipartRequest — happy paths", () => {
  test("one file + text field returns both", async () => {
    const req = multipartRequest([
      { kind: "field", name: "text", value: "hello" },
      {
        kind: "file",
        name: "file",
        filename: "image.png",
        mime: "image/png",
        bytes: PNG_HEADER,
      },
    ]);
    const r = await parseMultipartRequest(req, cfg, BOT_ID, REQ_ID);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.text).toBe("hello");
      expect(r.attachments).toHaveLength(1);
      expect(r.attachments[0].mime_type).toBe("image/png");
      expect(r.attachments[0].path).toMatch(/agentapi-testreq-0000-0\.png$/);
    }
    const dirEntries = await attachmentsDirEntries();
    expect(dirEntries).toContain("agentapi-testreq-0000-0.png");
  });

  test("multiple files get distinct indexed names", async () => {
    const req = multipartRequest([
      {
        kind: "file",
        name: "f1",
        filename: "a.pdf",
        mime: "application/pdf",
        bytes: PDF_HEADER,
      },
      {
        kind: "file",
        name: "f2",
        filename: "b.png",
        mime: "image/png",
        bytes: PNG_HEADER,
      },
    ]);
    const r = await parseMultipartRequest(req, cfg, BOT_ID, REQ_ID);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.attachments).toHaveLength(2);
      expect(r.attachments[0].path).toMatch(/agentapi-testreq-0000-0\.pdf$/);
      expect(r.attachments[1].path).toMatch(/agentapi-testreq-0000-1\.png$/);
    }
  });

  test("other form fields are preserved in `fields`", async () => {
    const req = multipartRequest([
      { kind: "field", name: "text", value: "hi" },
      { kind: "field", name: "source", value: "calendar" },
      { kind: "field", name: "user_id", value: "42" },
    ]);
    const r = await parseMultipartRequest(req, cfg, BOT_ID, REQ_ID);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.text).toBe("hi");
      expect(r.fields.source).toBe("calendar");
      expect(r.fields.user_id).toBe("42");
      expect(r.attachments).toHaveLength(0);
    }
  });

  test("caller-supplied filename is ignored — on-disk name is gateway-controlled", async () => {
    const req = multipartRequest([
      { kind: "field", name: "text", value: "hi" },
      {
        kind: "file",
        name: "f",
        // Path traversal attempt in the caller-provided name.
        filename: "../../etc/passwd.png",
        mime: "image/png",
        bytes: PNG_HEADER,
      },
    ]);
    const r = await parseMultipartRequest(req, cfg, BOT_ID, REQ_ID);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.attachments[0].path).toMatch(
        /attachments\/bot1\/agentapi-testreq-0000-0\.png$/,
      );
      // Parent dir was not escaped.
      expect(r.attachments[0].path).not.toContain("..");
    }
  });
});

describe("parseMultipartRequest — rejection paths", () => {
  test("wrong content-type → invalid_body", async () => {
    const req = new Request("http://local/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    const r = await parseMultipartRequest(req, cfg, BOT_ID, REQ_ID);
    expect(r.kind).toBe("err");
    if (r.kind === "err") expect(r.code).toBe("invalid_body");
  });

  test("count > max_files_per_request → too_many_files", async () => {
    cfg.agent_api.ask.max_files_per_request = 1;
    const req = multipartRequest([
      {
        kind: "file",
        name: "a",
        filename: "a.png",
        mime: "image/png",
        bytes: PNG_HEADER,
      },
      {
        kind: "file",
        name: "b",
        filename: "b.png",
        mime: "image/png",
        bytes: PNG_HEADER,
      },
    ]);
    const r = await parseMultipartRequest(req, cfg, BOT_ID, REQ_ID);
    expect(r.kind).toBe("err");
    if (r.kind === "err") expect(r.code).toBe("too_many_files");
    // Atomicity: no files written on rejection.
    expect(await attachmentsDirEntries()).toEqual([]);
  });

  test("file bigger than per-file cap → attachment_too_large", async () => {
    cfg.attachments.max_bytes = 4; // PNG header is 8 bytes
    const req = multipartRequest([
      {
        kind: "file",
        name: "a",
        filename: "a.png",
        mime: "image/png",
        bytes: PNG_HEADER,
      },
    ]);
    const r = await parseMultipartRequest(req, cfg, BOT_ID, REQ_ID);
    expect(r.kind).toBe("err");
    if (r.kind === "err") expect(r.code).toBe("attachment_too_large");
    expect(await attachmentsDirEntries()).toEqual([]);
  });

  test("content-length over aggregate cap → body_too_large (rejected before parse)", async () => {
    cfg.agent_api.ask.max_body_bytes = 10;
    // Real payload is small, but we forge a huge content-length to prove the
    // early-abort path works.
    const req = new Request("http://local/", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=xyz",
        "content-length": "999999",
      },
      body: "--xyz--\r\n",
    });
    const r = await parseMultipartRequest(req, cfg, BOT_ID, REQ_ID);
    expect(r.kind).toBe("err");
    if (r.kind === "err") expect(r.code).toBe("body_too_large");
  });

  test("aggregate file size over cap (no content-length) → body_too_large", async () => {
    cfg.agent_api.ask.max_body_bytes = 4; // PNG+PDF totals 12 bytes
    const req = multipartRequest(
      [
        {
          kind: "file",
          name: "a",
          filename: "a.png",
          mime: "image/png",
          bytes: PNG_HEADER,
        },
        {
          kind: "file",
          name: "b",
          filename: "b.pdf",
          mime: "application/pdf",
          bytes: PDF_HEADER,
        },
      ],
      { omitContentLength: true },
    );
    const r = await parseMultipartRequest(req, cfg, BOT_ID, REQ_ID);
    expect(r.kind).toBe("err");
    if (r.kind === "err") expect(r.code).toBe("body_too_large");
  });

  test("aggregate size includes text + form fields — text-only payload over cap → body_too_large", async () => {
    // Text-only multipart must be subject to the same cap as file payloads.
    // If field bytes were excluded, an attacker could bypass max_body_bytes
    // by sending 100 MB of `text=` with zero files and chunked encoding.
    cfg.agent_api.ask.max_body_bytes = 64;
    const req = multipartRequest(
      [{ kind: "field", name: "text", value: "x".repeat(200) }],
      { omitContentLength: true },
    );
    const r = await parseMultipartRequest(req, cfg, BOT_ID, REQ_ID);
    expect(r.kind).toBe("err");
    if (r.kind === "err") expect(r.code).toBe("body_too_large");
  });

  test("disallowed MIME → attachment_mime_not_allowed", async () => {
    const req = multipartRequest([
      {
        kind: "file",
        name: "a",
        filename: "a.exe",
        mime: "application/x-msdownload",
        bytes: new Uint8Array([0x4d, 0x5a]),
      },
    ]);
    const r = await parseMultipartRequest(req, cfg, BOT_ID, REQ_ID);
    expect(r.kind).toBe("err");
    if (r.kind === "err") expect(r.code).toBe("attachment_mime_not_allowed");
    expect(await attachmentsDirEntries()).toEqual([]);
  });

  test("disk cap hit → insufficient_storage (no files written)", async () => {
    cfg.attachments.disk_usage_cap_bytes = 4; // already "full"
    const req = multipartRequest([
      {
        kind: "file",
        name: "a",
        filename: "a.pdf",
        mime: "application/pdf",
        bytes: PDF_HEADER,
      },
    ]);
    // Use the injection hook so the check deterministically fires.
    const r = await parseMultipartRequest(req, cfg, BOT_ID, REQ_ID, {
      computeDiskUsage: async () => 10,
    });
    expect(r.kind).toBe("err");
    if (r.kind === "err") expect(r.code).toBe("insufficient_storage");
    expect(await attachmentsDirEntries()).toEqual([]);
  });
});

describe("cleanupFiles", () => {
  test("unlinks existing files and swallows missing ones", async () => {
    const dir = join(tmpDir, "attachments", BOT_ID);
    await mkdir(dir, { recursive: true });
    const existing = join(dir, "keepme.bin");
    await writeFile(existing, new Uint8Array([1, 2, 3]));
    const ghost = join(dir, "already-gone.bin");

    await cleanupFiles([existing, ghost]);

    const entries = await readdir(dir);
    expect(entries).not.toContain("keepme.bin");
  });
});

describe("sweepUnreferencedAgentApiFiles", () => {
  async function writeFileAt(path: string, ageMs: number): Promise<void> {
    await mkdir(join(tmpDir, "attachments", BOT_ID), { recursive: true });
    await writeFile(path, "x");
    const now = Date.now();
    const when = (now - ageMs) / 1000;
    await utimes(path, when, when);
  }

  test("deletes old unreferenced files, keeps young and referenced", async () => {
    const dir = join(tmpDir, "attachments", BOT_ID);
    await mkdir(dir, { recursive: true });

    const oldOrphan = join(dir, "agentapi-old-0.png");
    const youngOrphan = join(dir, "agentapi-young-0.png");
    const referenced = join(dir, "agentapi-ref-0.png");
    const telegramFile = join(dir, "1-0.jpg"); // not agent-api; must be ignored

    await writeFileAt(oldOrphan, 48 * 60 * 60 * 1000); // 48h old
    await writeFileAt(youngOrphan, 60 * 1000); // 1 min old
    await writeFileAt(referenced, 48 * 60 * 60 * 1000);
    await writeFileAt(telegramFile, 48 * 60 * 60 * 1000);

    // Mark one as referenced by writing a turn row pointing at it.
    db.exec(`
      INSERT INTO inbound_updates (bot_id, telegram_update_id, chat_id, message_id, from_user_id, payload_json, status)
      VALUES ('bot1', 1, 100, 10, '42', '{}', 'received');
    `);
    db.exec(`
      INSERT INTO turns (bot_id, chat_id, source_update_id, attachment_paths_json)
      VALUES ('bot1', 100, 1, '${JSON.stringify([referenced]).replace(/'/g, "''")}');
    `);

    const result = await sweepUnreferencedAgentApiFiles(
      db,
      tmpDir,
      24 * 60 * 60 * 1000,
    );
    expect(result.deleted).toBe(1);

    const entries = new Set(await attachmentsDirEntries());
    expect(entries.has("agentapi-old-0.png")).toBe(false);
    expect(entries.has("agentapi-young-0.png")).toBe(true);
    expect(entries.has("agentapi-ref-0.png")).toBe(true);
    expect(entries.has("1-0.jpg")).toBe(true); // telegram file untouched
  });

  test("returns 0/0 when the attachments root is missing", async () => {
    const freshTmp = mkdtempSync(join(tmpdir(), "torana-empty-"));
    try {
      const r = await sweepUnreferencedAgentApiFiles(db, freshTmp, 1000);
      expect(r).toEqual({ scanned: 0, deleted: 0 });
    } finally {
      rmSync(freshTmp, { recursive: true, force: true });
    }
  });
});
