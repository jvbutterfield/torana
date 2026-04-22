// Multipart parser + file lifecycle helpers for the agent-api surface.
//
// Callers drive this in three pieces:
//
//   1. parseMultipartRequest(req, config, botId, requestId)
//      - decodes multipart/form-data
//      - writes validated files to <data_dir>/attachments/<botId>/agentapi-<requestId>-<idx><ext>
//      - returns {text, fields, attachments} on success, {err, code} on rejection
//      - on rejection, any files already written under `requestId` are cleaned up
//        before we return (atomic — caller never sees partial state)
//
//   2. cleanupFiles(paths) — best-effort unlink. Callers invoke this when the
//      DB transaction throws OR when insertSendTurn returns {replay: true}
//      (files were written optimistically; the replay path doesn't own them).
//
//   3. sweepUnreferencedAgentApiFiles(db, dataDir, maxAgeMs)
//      - belt-and-braces for the crash window: process dies between file write
//        and DB commit, leaving orphans with no turn row
//      - walks attachments/<bot>/agentapi-*, deletes anything older than
//        maxAgeMs that isn't referenced by any turn
//      - the existing completed-turn sweeper (core/attachments.ts) handles
//        the lifecycle AFTER a turn row lands; this handles the window BEFORE

import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { logger } from "../log.js";
import type { BotId, Config } from "../config/schema.js";
import type { GatewayDB } from "../db/gateway-db.js";
import type { Attachment } from "../telegram/types.js";
import { computeAttachmentsDiskUsage } from "../core/attachments.js";

const log = logger("agent-api-attachments");

/**
 * Mirror of the Telegram path's allowlist. Extension is gateway-controlled
 * based on the declared MIME; `part.name` / original filename are never used
 * for the on-disk name (same security posture as core/attachments.ts).
 */
/**
 * Minimal structural subset of the global `File` we rely on. Declared here
 * rather than importing the DOM lib because the rest of the codebase
 * targets a node/bun type profile that doesn't ship `File` as a type.
 */
interface MultipartFile {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isMultipartFile(v: unknown): v is MultipartFile {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
    typeof (v as { size?: unknown }).size === "number" &&
    typeof (v as { type?: unknown }).type === "string"
  );
}

const EXT_ALLOWLIST: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
};

export type ParseMultipartResult =
  | {
      kind: "ok";
      text: string;
      fields: Record<string, string>;
      attachments: Attachment[];
    }
  | {
      kind: "err";
      code:
        | "invalid_body"
        | "body_too_large"
        | "too_many_files"
        | "attachment_too_large"
        | "attachment_mime_not_allowed"
        | "insufficient_storage";
      detail?: string;
    };

export interface ParseMultipartOptions {
  /**
   * Injection point for the disk-usage probe so handler unit tests can
   * assert "disk cap hit" without populating a real filesystem. Defaults
   * to the real `computeAttachmentsDiskUsage`.
   */
  computeDiskUsage?: (dataDir: string) => Promise<number>;
}

/**
 * Parse a multipart/form-data body into fields + on-disk attachments.
 *
 * Order of checks (cheapest first, filesystem last):
 *   1. content-type is multipart/form-data (invalid_body otherwise)
 *   2. content-length ≤ max_body_bytes (early reject before reading body)
 *   3. formData() parse (invalid_body on malformed body)
 *   4. file count ≤ max_files_per_request
 *   5. per-file mime allowlist + per-file size cap
 *   6. disk-usage cap
 *   7. mkdir + writeFile
 *
 * Any failure after step 6 cleans up files already written under `requestId`.
 */
export async function parseMultipartRequest(
  req: Request,
  config: Config,
  botId: BotId,
  requestId: string,
  opts: ParseMultipartOptions = {},
): Promise<ParseMultipartResult> {
  const computeUsage = opts.computeDiskUsage ?? computeAttachmentsDiskUsage;

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return { kind: "err", code: "invalid_body", detail: "expected multipart/form-data" };
  }

  // Early aggregate check via Content-Length (stream-reading with hard abort
  // is not portable under Bun.FormData; content-length is adequate for the
  // v1 threat model — the subsequent formData() call buffers, and we're
  // checking a known-valid header before we allocate any buffer).
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  const maxBody = config.agent_api.ask.max_body_bytes;
  if (contentLength > 0 && contentLength > maxBody) {
    return {
      kind: "err",
      code: "body_too_large",
      detail: `content-length ${contentLength} > max ${maxBody}`,
    };
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return {
      kind: "err",
      code: "invalid_body",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Collect files + fields in two passes so caps are checked before any
  // filesystem mutation happens.
  const rawFiles: Array<{ file: MultipartFile }> = [];
  const fields: Record<string, string> = {};
  let textField = "";

  for (const [name, value] of form.entries()) {
    if (isMultipartFile(value)) {
      rawFiles.push({ file: value });
    } else if (typeof value === "string") {
      if (name === "text") textField = value;
      else fields[name] = value;
    }
  }

  const maxFiles = config.agent_api.ask.max_files_per_request;
  if (rawFiles.length > maxFiles) {
    return {
      kind: "err",
      code: "too_many_files",
      detail: `${rawFiles.length} files > max ${maxFiles}`,
    };
  }

  // Aggregate-size fallback when Content-Length is absent (some clients
  // drop it for multipart). Sum decoded file sizes and compare against
  // the same cap.
  let aggregate = 0;
  for (const { file } of rawFiles) aggregate += file.size;
  if (aggregate > maxBody) {
    return {
      kind: "err",
      code: "body_too_large",
      detail: `aggregate ${aggregate} > max ${maxBody}`,
    };
  }

  const perFileCap = config.attachments.max_bytes;
  for (const { file } of rawFiles) {
    if (file.size > perFileCap) {
      return {
        kind: "err",
        code: "attachment_too_large",
        detail: `file of ${file.size} bytes exceeds per-file cap ${perFileCap}`,
      };
    }
    const mime = (file.type || "").toLowerCase();
    if (!(mime in EXT_ALLOWLIST)) {
      return {
        kind: "err",
        code: "attachment_mime_not_allowed",
        detail: mime || "missing mime",
      };
    }
  }

  // Disk-usage check before the first write — the telegram path does the
  // same. One probe covers all files in this request.
  const diskUsed = await computeUsage(config.gateway.data_dir);
  if (diskUsed + aggregate > config.attachments.disk_usage_cap_bytes) {
    return {
      kind: "err",
      code: "insufficient_storage",
      detail: `attachments disk cap (${config.attachments.disk_usage_cap_bytes}) would be exceeded`,
    };
  }

  const dir = resolve(config.gateway.data_dir, "attachments", botId);
  await mkdir(dir, { recursive: true });

  const written: Attachment[] = [];
  try {
    let idx = 0;
    for (const { file } of rawFiles) {
      const mime = file.type.toLowerCase();
      const ext = EXT_ALLOWLIST[mime] ?? ".bin";
      const filename = `agentapi-${requestId}-${idx}${ext}`;
      const target = join(dir, filename);
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Re-check the decoded size — File.size is advisory; the real payload
      // is what lands on disk. Belt-and-braces against a lying client.
      if (bytes.byteLength > perFileCap) {
        throw Object.assign(
          new Error(
            `decoded bytes ${bytes.byteLength} exceed per-file cap ${perFileCap}`,
          ),
          { code: "attachment_too_large" as const },
        );
      }
      await writeFile(target, bytes);
      written.push({
        kind: "document",
        path: target,
        mime_type: mime,
        bytes: bytes.byteLength,
      });
      idx += 1;
    }
  } catch (err) {
    // Roll back anything we wrote so far; we must never leak files on
    // a partial-write failure. cleanupFiles swallows individual unlink
    // errors so we return the primary reason.
    await cleanupFiles(written.map((a) => a.path));
    const code = (err as { code?: string } | null)?.code;
    if (code === "attachment_too_large") {
      return {
        kind: "err",
        code: "attachment_too_large",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    log.error("multipart write failed", {
      bot_id: botId,
      request_id: requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: "err",
      code: "invalid_body",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  return { kind: "ok", text: textField, fields, attachments: written };
}

/**
 * Best-effort unlink of the given files. Used after DB transaction failure
 * OR idempotent replay (files were written but the turn-of-record owns
 * the first call's files, not ours).
 */
export async function cleanupFiles(paths: readonly string[]): Promise<void> {
  await Promise.all(
    paths.map(async (p) => {
      try {
        await unlink(p);
      } catch {
        /* already gone or inaccessible — nothing to recover */
      }
    }),
  );
}

/**
 * Belt-and-braces sweep: delete `attachments/<bot>/agentapi-*` files that
 * aren't referenced by any turn and are older than `maxAgeMs`. Runs on the
 * same hourly cadence as the completed-turn sweeper.
 *
 * The age threshold is intentional — a file written seconds before a
 * concurrent DB commit should NOT be reaped mid-flight. 24h makes the race
 * window impossibly wide; legitimate callers will have committed long before.
 *
 * Returns a count of files deleted for logging.
 */
export async function sweepUnreferencedAgentApiFiles(
  db: GatewayDB,
  dataDir: string,
  maxAgeMs: number,
  clock: () => number = Date.now,
): Promise<{ scanned: number; deleted: number }> {
  const attachRoot = resolve(dataDir, "attachments");
  let botDirs: string[];
  try {
    botDirs = await readdir(attachRoot);
  } catch {
    return { scanned: 0, deleted: 0 };
  }

  // Build the set of referenced paths from the turns table. Loading every
  // non-null attachment_paths_json is bounded by the retention window
  // (completed-turn sweeper deletes these within 24h of completion).
  const referenced = loadReferencedAttachmentPaths(db);

  const cutoff = clock() - maxAgeMs;
  let scanned = 0;
  let deleted = 0;

  for (const botDir of botDirs) {
    const fullBotDir = join(attachRoot, botDir);
    let entries: string[];
    try {
      entries = await readdir(fullBotDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("agentapi-")) continue;
      scanned += 1;
      const full = join(fullBotDir, entry);
      if (referenced.has(full)) continue;
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.mtimeMs > cutoff) continue;
      try {
        await unlink(full);
        deleted += 1;
      } catch {
        /* concurrent delete or permission — move on */
      }
    }
  }
  return { scanned, deleted };
}

function loadReferencedAttachmentPaths(db: GatewayDB): Set<string> {
  const rows = db
    .query(
      "SELECT attachment_paths_json FROM turns WHERE attachment_paths_json IS NOT NULL",
    )
    .all() as Array<{ attachment_paths_json: string }>;
  const set = new Set<string>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.attachment_paths_json);
      if (Array.isArray(parsed)) {
        for (const p of parsed) {
          if (typeof p === "string") set.add(p);
        }
      }
    } catch {
      /* malformed row — leave files in place; the next run handles it */
    }
  }
  return set;
}
