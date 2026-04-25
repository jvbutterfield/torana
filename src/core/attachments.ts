// Attachment download helpers. SECURITY: on-disk filenames are fully
// gateway-controlled — extensions come from a fixed mime-type allowlist.
// Telegram's `file_path` and `original_filename` are never used for the
// on-disk name or extension (they are attacker-influenced and could contain
// path separators, NUL bytes, or misleading extensions).

import { mkdir, open, stat, lstat, readdir, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, isAbsolute, join } from "node:path";
import { logger } from "../log.js";
import type { BotId, Config } from "../config/schema.js";
import type { GatewayDB } from "../db/gateway-db.js";
import type { TelegramClient } from "../telegram/client.js";
import type { TelegramMessage, Attachment } from "../telegram/types.js";
import { detectMimeFromMagic } from "../mime-magic.js";

const log = logger("attachments");

const EXT_ALLOWLIST: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
};

function extensionFor(mime: string | undefined): string {
  if (!mime) return ".bin";
  return EXT_ALLOWLIST[mime] ?? ".bin";
}

// O_NOFOLLOW is unix-only; on Windows fs.constants.O_NOFOLLOW is undefined,
// so we degrade to plain O_CREAT|O_EXCL|O_WRONLY there. The unix targets
// (Linux/macOS, including Bun's container deployments) are where the
// symlink-staging risk lives.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const ATTACHMENT_OPEN_FLAGS =
  fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | O_NOFOLLOW;
const MAX_FILENAME_RETRIES = 3;

/**
 * Materialize an attachment under `dir` with hardened semantics:
 *
 * - O_CREAT|O_EXCL: refuse to overwrite an existing file. On EEXIST we
 *   regenerate the filename with a random UUID suffix and retry up to
 *   MAX_FILENAME_RETRIES times before giving up.
 * - O_NOFOLLOW: refuse to follow a symlink at the target path. If the
 *   destination is a symlink (e.g. a less-trusted process staged one
 *   pointing outside the dir), the open fails with ELOOP and we abort
 *   with a distinct error code so ops can investigate.
 *
 * Throws with `code` set to one of:
 *   ATTACHMENT_SYMLINK_REJECTED, ATTACHMENT_FILENAME_COLLISION,
 *   ATTACHMENT_PATH_OUTSIDE_DIR.
 *
 * Returns the final path written.
 */
async function writeAttachmentExclusive(
  dir: string,
  baseName: string,
  ext: string,
  bytes: Uint8Array,
): Promise<string> {
  let filename = `${baseName}${ext}`;
  for (let attempt = 0; ; attempt += 1) {
    const target = join(dir, filename);
    if (!isContainedIn(target, dir)) {
      const err = new Error(
        "attachment path outside data dir",
      ) as NodeJS.ErrnoException;
      err.code = "ATTACHMENT_PATH_OUTSIDE_DIR";
      throw err;
    }
    let handle;
    try {
      handle = await open(target, ATTACHMENT_OPEN_FLAGS);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        // POSIX gives O_EXCL priority over O_NOFOLLOW, so a symlink
        // staged at the target lands here on Linux/macOS rather than
        // raising ELOOP. Distinguish with lstat so we can reject the
        // symlink case loudly (security signal) while still allowing
        // the regular-file collision case to retry under a fresh name.
        let preexistingIsSymlink = false;
        try {
          const st = await lstat(target);
          preexistingIsSymlink = st.isSymbolicLink();
        } catch {
          /* raced — treat as regular collision */
        }
        if (preexistingIsSymlink) {
          const sym = new Error(
            `attachment target is a symlink (refusing to follow): ${target}`,
          ) as NodeJS.ErrnoException;
          sym.code = "ATTACHMENT_SYMLINK_REJECTED";
          throw sym;
        }
        if (attempt >= MAX_FILENAME_RETRIES) {
          const collide = new Error(
            `attachment filename collision after ${MAX_FILENAME_RETRIES} retries`,
          ) as NodeJS.ErrnoException;
          collide.code = "ATTACHMENT_FILENAME_COLLISION";
          throw collide;
        }
        filename = `${baseName}-${randomUUID()}${ext}`;
        continue;
      }
      if (code === "ELOOP") {
        const sym = new Error(
          `attachment target is a symlink (refusing to follow): ${target}`,
        ) as NodeJS.ErrnoException;
        sym.code = "ATTACHMENT_SYMLINK_REJECTED";
        throw sym;
      }
      throw err;
    }
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    return target;
  }
}

function handleAttachmentWriteError(
  err: unknown,
  errors: string[],
  ctx: { botId: BotId; updateId: number; kind: "photo" | "document" },
): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ATTACHMENT_SYMLINK_REJECTED") {
    log.error("attachment target is a symlink — refusing to write", {
      bot_id: ctx.botId,
      update_id: ctx.updateId,
      kind: ctx.kind,
    });
    errors.push("symlink at attachment target");
    return true;
  }
  if (code === "ATTACHMENT_FILENAME_COLLISION") {
    errors.push("filename collision after retries");
    return true;
  }
  if (code === "ATTACHMENT_PATH_OUTSIDE_DIR") {
    errors.push("attachment path outside data dir");
    return true;
  }
  return false;
}

export interface DownloadResult {
  attachments: Attachment[];
  /** If any attachment was dropped, the reason (for user-facing feedback). */
  errors: string[];
}

export async function downloadAttachments(
  config: Config,
  botId: BotId,
  updateId: number,
  message: TelegramMessage,
  client: TelegramClient,
): Promise<DownloadResult> {
  const attachments: Attachment[] = [];
  const errors: string[] = [];
  const dir = resolve(config.gateway.data_dir, "attachments", botId);
  await mkdir(dir, { recursive: true });

  let index = 0;
  const addPhoto = async (): Promise<void> => {
    if (!message.photo || message.photo.length === 0) return;
    // Highest resolution is the last entry.
    const photo = message.photo[message.photo.length - 1];
    if (attachments.length >= config.attachments.max_per_turn) {
      errors.push("too many attachments");
      return;
    }
    if (photo.file_size && photo.file_size > config.attachments.max_bytes) {
      errors.push("photo too large");
      return;
    }
    const file = await client.getFile(photo.file_id);
    if (!file) {
      errors.push("failed to resolve photo via getFile");
      return;
    }
    const bytes = await client.downloadFile(file.file_path);
    if (!bytes) {
      errors.push("failed to download photo bytes");
      return;
    }
    if (bytes.byteLength > config.attachments.max_bytes) {
      errors.push("photo exceeded max_bytes after download");
      return;
    }
    // Photos from Telegram are JPEG by convention; mime is not carried.
    // Verify the actual bytes match JPEG magic before writing — Telegram's
    // CDN is trusted but we cannot rule out a compromised upstream or a
    // MITM replacement that ships non-JPEG bytes under the photo endpoint.
    // Refusing non-JPEG here prevents a non-image landing with a `.jpg`
    // extension and being handed to a runner (e.g. codex `--image`).
    const rawBytes = new Uint8Array(bytes);
    const detected = detectMimeFromMagic(rawBytes);
    if (detected !== "image/jpeg") {
      errors.push(
        detected
          ? `photo bytes are ${detected}, expected image/jpeg`
          : "photo bytes do not match image/jpeg magic",
      );
      return;
    }
    const ext = ".jpg";
    let target: string;
    try {
      target = await writeAttachmentExclusive(
        dir,
        `${updateId}-${index}`,
        ext,
        new Uint8Array(bytes),
      );
    } catch (err) {
      if (
        handleAttachmentWriteError(err, errors, {
          botId,
          updateId,
          kind: "photo",
        })
      ) {
        return;
      }
      throw err;
    }
    attachments.push({
      kind: "photo",
      path: target,
      mime_type: "image/jpeg",
      bytes: bytes.byteLength,
    });
    index += 1;
  };

  const addDocument = async (): Promise<void> => {
    const doc = message.document;
    if (!doc) return;
    if (attachments.length >= config.attachments.max_per_turn) {
      errors.push("too many attachments");
      return;
    }
    if (doc.file_size && doc.file_size > config.attachments.max_bytes) {
      errors.push("document too large");
      return;
    }
    const file = await client.getFile(doc.file_id);
    if (!file) {
      errors.push("failed to resolve document via getFile");
      return;
    }
    const bytes = await client.downloadFile(file.file_path);
    if (!bytes) {
      errors.push("failed to download document bytes");
      return;
    }
    if (bytes.byteLength > config.attachments.max_bytes) {
      errors.push("document exceeded max_bytes after download");
      return;
    }
    // If the document's declared MIME is in our allowlist, verify the
    // actual bytes match — a Telegram user (or anyone spoofing one) can
    // upload a document with any `mime_type` header but arbitrary content.
    // If the declared MIME is NOT in the allowlist, we already write with
    // a `.bin` extension and the runner has to opt-in to process it, so
    // the sniffing below only runs on the allowlisted path where the
    // extension would otherwise claim a content type we shouldn't trust.
    const rawBytes = new Uint8Array(bytes);
    if (doc.mime_type && doc.mime_type in EXT_ALLOWLIST) {
      const detected = detectMimeFromMagic(rawBytes);
      if (detected !== doc.mime_type) {
        errors.push(
          detected
            ? `document declared ${doc.mime_type} but bytes are ${detected}`
            : `document declared ${doc.mime_type} but bytes do not match any allowed type`,
        );
        return;
      }
    }
    const ext = extensionFor(doc.mime_type);
    let target: string;
    try {
      target = await writeAttachmentExclusive(
        dir,
        `${updateId}-${index}`,
        ext,
        new Uint8Array(bytes),
      );
    } catch (err) {
      if (
        handleAttachmentWriteError(err, errors, {
          botId,
          updateId,
          kind: "document",
        })
      ) {
        return;
      }
      throw err;
    }
    attachments.push({
      kind: "document",
      path: target,
      mime_type: doc.mime_type,
      original_filename: doc.file_name,
      bytes: bytes.byteLength,
    });
    index += 1;
  };

  try {
    await addPhoto();
    await addDocument();
  } catch (err) {
    log.error("attachment download failed", {
      bot_id: botId,
      update_id: updateId,
      error: err instanceof Error ? err.message : String(err),
    });
    errors.push("unexpected error during download");
  }

  return { attachments, errors };
}

function isContainedIn(candidate: string, dir: string): boolean {
  const resolvedDir = isAbsolute(dir) ? dir : resolve(dir);
  const resolvedCandidate = isAbsolute(candidate)
    ? candidate
    : resolve(candidate);
  return (
    resolvedCandidate === resolvedDir ||
    resolvedCandidate.startsWith(resolvedDir + "/") ||
    resolvedCandidate.startsWith(resolvedDir + "\\")
  );
}

/**
 * Compute the total size (bytes) of files under `attachments/` across all bots.
 * Used by the disk-cap circuit breaker.
 */
export async function computeAttachmentsDiskUsage(
  dataDir: string,
): Promise<number> {
  const root = resolve(dataDir, "attachments");
  try {
    return await sumDir(root);
  } catch (err) {
    log.debug("disk usage compute failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

async function sumDir(dir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const s = await stat(full);
      if (s.isDirectory()) total += await sumDir(full);
      else total += s.size;
    } catch {
      /* ignore */
    }
  }
  return total;
}

/** Delete files under attachments/<botId> whose turn id is in `completedTurnIds`. */
export async function sweepAttachmentsForTurns(
  dataDir: string,
  completedTurnAttachmentPaths: readonly string[],
): Promise<void> {
  const root = resolve(dataDir, "attachments");
  for (const p of completedTurnAttachmentPaths) {
    if (!isContainedIn(p, root)) continue;
    try {
      await unlink(p);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Delete attachment files for completed turns older than `retentionSecs`, and
 * null out the `attachment_paths_json` column so subsequent sweeps skip them.
 * Bounded at 500 turns per call (see db query) to keep worst-case cost
 * predictable on large histories; callers run this on a timer.
 *
 * Returns the number of turns swept and files deleted (both useful for
 * logging).
 */
export async function sweepExpiredAttachments(
  db: GatewayDB,
  dataDir: string,
  retentionSecs: number,
): Promise<{ turns: number; files: number }> {
  const expired = db.getExpiredAttachmentTurns(retentionSecs);
  let filesDeleted = 0;
  for (const row of expired) {
    let paths: string[] = [];
    try {
      const parsed = JSON.parse(row.attachment_paths_json);
      if (Array.isArray(parsed))
        paths = parsed.filter((p) => typeof p === "string");
    } catch {
      /* malformed — still clear the column so it doesn't keep coming back */
    }
    if (paths.length > 0) {
      await sweepAttachmentsForTurns(dataDir, paths);
      filesDeleted += paths.length;
    }
    db.clearTurnAttachments(row.id);
  }
  return { turns: expired.length, files: filesDeleted };
}
