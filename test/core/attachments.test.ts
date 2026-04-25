// Attachment download + disk-usage + sweep tests.
//
// Uses a fake TelegramClient that returns canned file metadata + bytes.
// Focus: security properties (filename derived from mime, never file_path;
// path traversal rejected); size/count enforcement; disk-cap accounting;
// sweeper cleanup.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  readdirSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeAttachmentsDiskUsage,
  downloadAttachments,
  sweepAttachmentsForTurns,
  sweepExpiredAttachments,
} from "../../src/core/attachments.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import type { TelegramClient } from "../../src/telegram/client.js";
import type { TelegramMessage } from "../../src/telegram/types.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";
import type { Config } from "../../src/config/schema.js";

const __dirname_att = dirname(fileURLToPath(import.meta.url));

interface FakeFileSpec {
  fileId: string;
  filePath: string;
  bytes: Uint8Array;
  fileSize?: number;
}

/** Minimal TelegramClient stub — only the methods attachments.ts uses. */
function makeFakeClient(files: FakeFileSpec[]): TelegramClient {
  const byId = new Map(files.map((f) => [f.fileId, f]));
  const byPath = new Map(files.map((f) => [f.filePath, f]));
  return {
    async getFile(fileId: string) {
      const f = byId.get(fileId);
      if (!f) return null;
      return { file_path: f.filePath, file_size: f.fileSize ?? f.bytes.length };
    },
    async downloadFile(filePath: string) {
      const f = byPath.get(filePath);
      if (!f) return null;
      return f.bytes.buffer.slice(
        f.bytes.byteOffset,
        f.bytes.byteOffset + f.bytes.byteLength,
      );
    },
  } as unknown as TelegramClient;
}

let tmpDir: string;
let config: Config;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-att-"));
  config = makeTestConfig([makeTestBotConfig("alpha")], {
    gateway: {
      port: 3000,
      bind_host: "127.0.0.1",
      data_dir: tmpDir,
      db_path: join(tmpDir, "gateway.db"),
      log_level: "warn",
    },
    attachments: {
      max_bytes: 1024,
      max_per_turn: 2,
      retention_secs: 86_400,
      disk_usage_cap_bytes: 4096,
    },
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("downloadAttachments", () => {
  test("photo: saves highest-res with jpg extension derived from mime (not file_path)", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]); // JPEG magic
    // Deliberately evil file_path on Telegram's side — attachments.ts should ignore it.
    const client = makeFakeClient([
      {
        fileId: "fid-lo",
        filePath: "photos/evil.sh",
        bytes: new Uint8Array(10),
      },
      {
        fileId: "fid-hi",
        filePath: "photos/../../etc/passwd",
        bytes,
        fileSize: bytes.length,
      },
    ]);
    const message: TelegramMessage = {
      message_id: 1,
      date: 1,
      chat: { id: 111, type: "private" },
      photo: [
        {
          file_id: "fid-lo",
          file_unique_id: "u1",
          width: 10,
          height: 10,
          file_size: 10,
        },
        {
          file_id: "fid-hi",
          file_unique_id: "u2",
          width: 100,
          height: 100,
          file_size: bytes.length,
        },
      ],
    };

    const result = await downloadAttachments(
      config,
      "alpha",
      42,
      message,
      client,
    );
    expect(result.errors).toHaveLength(0);
    expect(result.attachments).toHaveLength(1);

    const a = result.attachments[0];
    expect(a.kind).toBe("photo");
    expect(a.mime_type).toBe("image/jpeg");
    expect(a.bytes).toBe(bytes.length);
    // Filename is <update_id>-<index><ext>, NEVER derived from file_path.
    expect(a.path).toMatch(/42-0\.jpg$/);
    expect(a.path.includes("etc/passwd")).toBe(false);
    expect(a.path.includes("..")).toBe(false);
    // File exists on disk.
    expect(existsSync(a.path)).toBe(true);
  });

  test("document: extension is derived from mime type, allowlist only", async () => {
    // Valid PDF magic bytes — matches mime_type: application/pdf below.
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const client = makeFakeClient([
      {
        fileId: "doc1",
        filePath: "docs/whatever.xyz",
        bytes,
        fileSize: bytes.length,
      },
    ]);
    const message: TelegramMessage = {
      message_id: 1,
      date: 1,
      chat: { id: 111, type: "private" },
      document: {
        file_id: "doc1",
        file_unique_id: "u",
        file_name: "user-supplied-name.xyz", // Must NOT affect on-disk name.
        mime_type: "application/pdf",
        file_size: bytes.length,
      },
    };
    const result = await downloadAttachments(
      config,
      "alpha",
      99,
      message,
      client,
    );
    expect(result.errors).toHaveLength(0);
    expect(result.attachments).toHaveLength(1);
    const a = result.attachments[0];
    expect(a.path).toMatch(/99-0\.pdf$/);
    expect(a.original_filename).toBe("user-supplied-name.xyz"); // Preserved for metadata.
  });

  test("document: unknown mime → .bin extension", async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const client = makeFakeClient([
      { fileId: "doc1", filePath: "x", bytes, fileSize: bytes.length },
    ]);
    const message: TelegramMessage = {
      message_id: 1,
      date: 1,
      chat: { id: 111, type: "private" },
      document: {
        file_id: "doc1",
        file_unique_id: "u",
        mime_type: "application/octet-stream", // not in allowlist
        file_size: bytes.length,
      },
    };
    const result = await downloadAttachments(
      config,
      "alpha",
      7,
      message,
      client,
    );
    expect(result.attachments[0].path).toMatch(/7-0\.bin$/);
  });

  test("photo: file_size > max_bytes is rejected pre-download", async () => {
    const client = makeFakeClient([
      {
        fileId: "fid",
        filePath: "p",
        bytes: new Uint8Array(5000),
        fileSize: 5000,
      },
    ]);
    const message: TelegramMessage = {
      message_id: 1,
      date: 1,
      chat: { id: 111, type: "private" },
      photo: [
        {
          file_id: "fid",
          file_unique_id: "u",
          width: 100,
          height: 100,
          file_size: 5000,
        },
      ],
    };
    const result = await downloadAttachments(
      config,
      "alpha",
      1,
      message,
      client,
    );
    expect(result.attachments).toHaveLength(0);
    expect(result.errors.some((e) => e.includes("too large"))).toBe(true);
  });

  test("photo: post-download byte check catches a lying file_size", async () => {
    // file_size says 10, but bytes are 5000 → should reject.
    const bytes = new Uint8Array(5000);
    const client = makeFakeClient([
      { fileId: "fid", filePath: "p", bytes, fileSize: 10 },
    ]);
    const message: TelegramMessage = {
      message_id: 1,
      date: 1,
      chat: { id: 111, type: "private" },
      photo: [
        {
          file_id: "fid",
          file_unique_id: "u",
          width: 100,
          height: 100,
          file_size: 10,
        },
      ],
    };
    const result = await downloadAttachments(
      config,
      "alpha",
      1,
      message,
      client,
    );
    expect(result.attachments).toHaveLength(0);
    expect(result.errors.some((e) => e.includes("exceeded"))).toBe(true);
  });

  test("getFile failure → error recorded, no file written", async () => {
    // Pass an empty client: getFile returns null for any id.
    const client = makeFakeClient([]);
    const message: TelegramMessage = {
      message_id: 1,
      date: 1,
      chat: { id: 111, type: "private" },
      document: {
        file_id: "missing",
        file_unique_id: "u",
        mime_type: "image/png",
        file_size: 10,
      },
    };
    const result = await downloadAttachments(
      config,
      "alpha",
      1,
      message,
      client,
    );
    expect(result.attachments).toHaveLength(0);
    expect(
      result.errors.some((e) => e.includes("getFile") || e.includes("resolve")),
    ).toBe(true);
  });

  test("downloadFile returns null → error recorded", async () => {
    // getFile succeeds but bytes map is empty.
    const client = {
      async getFile() {
        return { file_path: "p", file_size: 10 };
      },
      async downloadFile() {
        return null;
      },
    } as unknown as TelegramClient;
    const message: TelegramMessage = {
      message_id: 1,
      date: 1,
      chat: { id: 111, type: "private" },
      document: {
        file_id: "any",
        file_unique_id: "u",
        mime_type: "image/png",
        file_size: 10,
      },
    };
    const result = await downloadAttachments(
      config,
      "alpha",
      1,
      message,
      client,
    );
    expect(result.attachments).toHaveLength(0);
    expect(result.errors.some((e) => e.includes("download"))).toBe(true);
  });

  test("no attachments in message → empty result, no errors", async () => {
    const client = makeFakeClient([]);
    const message: TelegramMessage = {
      message_id: 1,
      date: 1,
      chat: { id: 111, type: "private" },
      text: "just text",
    };
    const result = await downloadAttachments(
      config,
      "alpha",
      1,
      message,
      client,
    );
    expect(result.attachments).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  // O_EXCL: pre-existing file at the destination path must NOT be
  // overwritten. We retry with a UUID-suffixed filename instead.
  test("EEXIST collision: regenerates filename with UUID and retries", async () => {
    const dir = join(tmpDir, "attachments", "alpha");
    mkdirSync(dir, { recursive: true });
    const collidePath = join(dir, "55-0.jpg");
    writeFileSync(collidePath, "preexisting");

    const bytes = new Uint8Array([0xff, 0xd8, 0xff]); // JPEG magic
    const client = makeFakeClient([
      { fileId: "fid", filePath: "p", bytes, fileSize: bytes.length },
    ]);
    const message: TelegramMessage = {
      message_id: 1,
      date: 1,
      chat: { id: 111, type: "private" },
      photo: [
        {
          file_id: "fid",
          file_unique_id: "u",
          width: 100,
          height: 100,
          file_size: bytes.length,
        },
      ],
    };
    const result = await downloadAttachments(
      config,
      "alpha",
      55,
      message,
      client,
    );

    expect(result.errors).toHaveLength(0);
    expect(result.attachments).toHaveLength(1);
    // Pre-existing file is untouched (no overwrite).
    expect(readFileSync(collidePath, "utf8")).toBe("preexisting");
    // Written path differs from the colliding one and carries a UUID suffix.
    const written = result.attachments[0].path;
    expect(written).not.toBe(collidePath);
    expect(written).toMatch(
      /55-0-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/,
    );
    // Bytes were actually written.
    expect(readFileSync(written)).toEqual(Buffer.from(bytes));
  });

  // O_NOFOLLOW: a symlink staged at the destination path must be rejected
  // outright — we do not follow it (which would let an attacker who can
  // write into the attachments dir redirect our writes outside it).
  test.if(process.platform !== "win32")(
    "symlink at target: refuses to follow (O_NOFOLLOW)",
    async () => {
      const dir = join(tmpDir, "attachments", "alpha");
      mkdirSync(dir, { recursive: true });
      const decoy = join(tmpDir, "outside-decoy.txt");
      writeFileSync(decoy, "should-not-be-overwritten");
      const symlinkPath = join(dir, "77-0.jpg");
      symlinkSync(decoy, symlinkPath);

      const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
      const client = makeFakeClient([
        { fileId: "fid", filePath: "p", bytes, fileSize: bytes.length },
      ]);
      const message: TelegramMessage = {
        message_id: 1,
        date: 1,
        chat: { id: 111, type: "private" },
        photo: [
          {
            file_id: "fid",
            file_unique_id: "u",
            width: 100,
            height: 100,
            file_size: bytes.length,
          },
        ],
      };
      const result = await downloadAttachments(
        config,
        "alpha",
        77,
        message,
        client,
      );

      // No attachment recorded; a symlink-specific error is reported.
      expect(result.attachments).toHaveLength(0);
      expect(result.errors.some((e) => e.includes("symlink"))).toBe(true);
      // Decoy target is untouched — the write didn't follow the symlink.
      expect(readFileSync(decoy, "utf8")).toBe("should-not-be-overwritten");
      // The symlink itself is left in place for ops to inspect.
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    },
  );
});

describe("computeAttachmentsDiskUsage", () => {
  test("sums all files under attachments/", () => {
    const root = join(tmpDir, "attachments");
    mkdirSync(join(root, "alpha"), { recursive: true });
    mkdirSync(join(root, "beta"), { recursive: true });
    writeFileSync(join(root, "alpha", "1.bin"), "hello"); // 5 bytes
    writeFileSync(join(root, "alpha", "2.bin"), "world!"); // 6 bytes
    writeFileSync(join(root, "beta", "3.bin"), "xyz"); // 3 bytes
    return computeAttachmentsDiskUsage(tmpDir).then((bytes) => {
      expect(bytes).toBe(14);
    });
  });

  test("returns 0 for missing attachments dir", async () => {
    const bytes = await computeAttachmentsDiskUsage(tmpDir);
    expect(bytes).toBe(0);
  });

  test("ignores unreadable entries without throwing", async () => {
    const root = join(tmpDir, "attachments");
    mkdirSync(root, { recursive: true });
    // Empty but existing dir.
    const bytes = await computeAttachmentsDiskUsage(tmpDir);
    expect(bytes).toBe(0);
  });
});

describe("sweepAttachmentsForTurns", () => {
  test("deletes listed files under attachments dir, leaves others intact", async () => {
    const root = join(tmpDir, "attachments");
    const dir = join(root, "alpha");
    mkdirSync(dir, { recursive: true });
    const keeperPath = join(dir, "keeper.bin");
    const sweepPath = join(dir, "sweepme.bin");
    writeFileSync(keeperPath, "k");
    writeFileSync(sweepPath, "s");

    await sweepAttachmentsForTurns(tmpDir, [sweepPath]);

    expect(existsSync(keeperPath)).toBe(true);
    expect(existsSync(sweepPath)).toBe(false);
  });

  test("refuses to delete outside attachments/ root", async () => {
    const outside = join(tmpDir, "outside.bin");
    writeFileSync(outside, "evil");
    await sweepAttachmentsForTurns(tmpDir, [outside]);
    expect(existsSync(outside)).toBe(true);
  });

  test("tolerates missing / already-deleted files", async () => {
    const root = join(tmpDir, "attachments", "alpha");
    mkdirSync(root, { recursive: true });
    const p = join(root, "does-not-exist.bin");
    await sweepAttachmentsForTurns(tmpDir, [p]);
    // Should not throw.
  });
});

// --- sweepExpiredAttachments ---

function loadDbSchema(dbPath: string): void {
  const sqlPath = resolve(__dirname_att, "../../src/db/schema.sql");
  const raw = new Database(dbPath, { create: true });
  raw.exec(readFileSync(sqlPath, "utf8") + "\nPRAGMA user_version = 1;");
  raw.close();
}

describe("sweepExpiredAttachments", () => {
  let db: GatewayDB;

  beforeEach(() => {
    loadDbSchema(join(tmpDir, "gateway.db"));
    db = new GatewayDB(join(tmpDir, "gateway.db"));
  });

  afterEach(() => {
    db.close();
  });

  /** Insert a completed turn whose `completed_at` is `secondsAgo` back. */
  function insertCompletedTurn(
    attachmentPaths: string[],
    secondsAgo: number,
  ): number {
    const inboundId = db.insertUpdate(
      "alpha",
      Math.floor(Math.random() * 1_000_000),
      1,
      1,
      "42",
      "{}",
      "enqueued",
    );
    const turnId = db.createTurn("alpha", 1, inboundId!, attachmentPaths);
    // Mark completed with a backdated timestamp.
    db.query(
      `UPDATE turns SET status='completed',
                       completed_at=datetime('now', '-' || ? || ' seconds')
       WHERE id = ?`,
    ).run(secondsAgo, turnId);
    return turnId;
  }

  test("sweeps files + clears attachment_paths_json for expired turns", async () => {
    const attDir = join(tmpDir, "attachments", "alpha");
    mkdirSync(attDir, { recursive: true });
    const p1 = join(attDir, "1-0.jpg");
    const p2 = join(attDir, "2-0.pdf");
    writeFileSync(p1, "a");
    writeFileSync(p2, "b");

    // Older than retention (86_400s default; use 100s for brevity).
    const oldTurn = insertCompletedTurn([p1, p2], 200);
    // Recent turn — should be untouched.
    const attKeep = join(attDir, "3-0.jpg");
    writeFileSync(attKeep, "k");
    const recentTurn = insertCompletedTurn([attKeep], 10);

    const result = await sweepExpiredAttachments(db, tmpDir, 100);

    expect(result.turns).toBe(1);
    expect(result.files).toBe(2);
    expect(existsSync(p1)).toBe(false);
    expect(existsSync(p2)).toBe(false);
    expect(existsSync(attKeep)).toBe(true);

    // attachment_paths_json is cleared only for the old turn.
    const oldRow = db
      .query("SELECT attachment_paths_json FROM turns WHERE id=?")
      .get(oldTurn) as { attachment_paths_json: string | null } | null;
    expect(oldRow?.attachment_paths_json).toBeNull();
    const recentRow = db
      .query("SELECT attachment_paths_json FROM turns WHERE id=?")
      .get(recentTurn) as { attachment_paths_json: string | null } | null;
    expect(recentRow?.attachment_paths_json).not.toBeNull();
  });

  test("idempotent: re-running finds nothing to sweep", async () => {
    const attDir = join(tmpDir, "attachments", "alpha");
    mkdirSync(attDir, { recursive: true });
    const p = join(attDir, "1-0.jpg");
    writeFileSync(p, "x");
    insertCompletedTurn([p], 200);

    const first = await sweepExpiredAttachments(db, tmpDir, 100);
    expect(first.turns).toBe(1);
    const second = await sweepExpiredAttachments(db, tmpDir, 100);
    expect(second.turns).toBe(0);
    expect(second.files).toBe(0);
  });

  test("skips turns that are not yet completed (status='running')", async () => {
    const attDir = join(tmpDir, "attachments", "alpha");
    mkdirSync(attDir, { recursive: true });
    const p = join(attDir, "1-0.jpg");
    writeFileSync(p, "x");

    const inboundId = db.insertUpdate("alpha", 1, 1, 1, "42", "{}", "enqueued");
    const turnId = db.createTurn("alpha", 1, inboundId!, [p]);
    db.query("UPDATE turns SET status='running' WHERE id=?").run(turnId);
    // No completed_at — must not be swept.

    const result = await sweepExpiredAttachments(db, tmpDir, 100);
    expect(result.turns).toBe(0);
    expect(existsSync(p)).toBe(true);
  });

  test("tolerates malformed attachment_paths_json without throwing (and still clears it)", async () => {
    const inboundId = db.insertUpdate("alpha", 1, 1, 1, "42", "{}", "enqueued");
    const turnId = db.createTurn("alpha", 1, inboundId!, []);
    db.query(
      `UPDATE turns SET status='completed',
                       completed_at=datetime('now', '-200 seconds'),
                       attachment_paths_json='{not json'
       WHERE id=?`,
    ).run(turnId);

    const result = await sweepExpiredAttachments(db, tmpDir, 100);
    expect(result.turns).toBe(1);
    expect(result.files).toBe(0);
    const row = db
      .query("SELECT attachment_paths_json FROM turns WHERE id=?")
      .get(turnId) as { attachment_paths_json: string | null } | null;
    expect(row?.attachment_paths_json).toBeNull();
  });

  test("bounded to 500 turns per call", async () => {
    // Seed 600 expired turns with empty attachment lists. The LIMIT should
    // cap the sweep to 500; the next call gets the remaining 100.
    db.transaction(() => {
      for (let i = 0; i < 600; i += 1) {
        const inboundId = db.insertUpdate(
          "alpha",
          10_000 + i,
          1,
          1,
          "42",
          "{}",
          "enqueued",
        );
        const turnId = db.createTurn("alpha", 1, inboundId!, ["dummy"]);
        db.query(
          `UPDATE turns SET status='completed',
                           completed_at=datetime('now', '-500 seconds')
           WHERE id=?`,
        ).run(turnId);
      }
    });

    const first = await sweepExpiredAttachments(db, tmpDir, 100);
    expect(first.turns).toBe(500);
    const second = await sweepExpiredAttachments(db, tmpDir, 100);
    expect(second.turns).toBe(100);
    const third = await sweepExpiredAttachments(db, tmpDir, 100);
    expect(third.turns).toBe(0);
  });

  test("refuses to delete files outside the attachments/ root", async () => {
    const evil = join(tmpDir, "outside-evil.bin");
    writeFileSync(evil, "evil");
    insertCompletedTurn([evil], 200);
    await sweepExpiredAttachments(db, tmpDir, 100);
    // The file is outside attachments/ so sweep should NOT delete it.
    expect(existsSync(evil)).toBe(true);
  });
});

describe("downloadAttachments - max_per_turn enforcement", () => {
  test("further attachments past max_per_turn are rejected", async () => {
    // max_per_turn is 2 in this config. Supply photo + document to hit both paths.
    // (Photos and documents are mutually exclusive in the current codepath, but
    //  we can test by configuring max_per_turn=1.)
    config.attachments.max_per_turn = 1;
    // JPEG magic bytes (minimum 3 bytes: FF D8 FF). The photo path now
    // requires the downloaded bytes to match image/jpeg magic — supplying
    // valid JPEG here exercises the max_per_turn path rather than being
    // rejected up-front on MIME mismatch.
    const photoBytes = new Uint8Array([0xff, 0xd8, 0xff]);
    // PNG magic for the document — needs to match declared image/png.
    const docBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const client = makeFakeClient([
      {
        fileId: "p1",
        filePath: "x1",
        bytes: photoBytes,
        fileSize: photoBytes.length,
      },
      {
        fileId: "d1",
        filePath: "x2",
        bytes: docBytes,
        fileSize: docBytes.length,
      },
    ]);
    const message: TelegramMessage = {
      message_id: 1,
      date: 1,
      chat: { id: 111, type: "private" },
      photo: [
        {
          file_id: "p1",
          file_unique_id: "u",
          width: 1,
          height: 1,
          file_size: photoBytes.length,
        },
      ],
      document: {
        file_id: "d1",
        file_unique_id: "u",
        mime_type: "image/png",
        file_size: docBytes.length,
      },
    };
    const result = await downloadAttachments(
      config,
      "alpha",
      1,
      message,
      client,
    );
    expect(result.attachments).toHaveLength(1); // photo accepted
    expect(result.errors.some((e) => e.includes("too many"))).toBe(true);
  });
});
