// Attachment download helpers — enforces the mime-derived filename allowlist
// from §4.3 of the plan (SECURITY). Telegram's file_path and original_filename
// are never used to compute the on-disk name or extension.

import { mkdir, writeFile, stat, readdir, unlink } from "node:fs/promises";
import { resolve, isAbsolute, join } from "node:path";
import { logger } from "../log.js";
import type { BotId, Config } from "../config/schema.js";
import type { TelegramClient } from "../telegram/client.js";
import type { TelegramMessage, Attachment } from "../telegram/types.js";

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
    const ext = ".jpg";
    const filename = `${updateId}-${index}${ext}`;
    const target = join(dir, filename);
    if (!isContainedIn(target, dir)) {
      errors.push("attachment path outside data dir");
      return;
    }
    await writeFile(target, new Uint8Array(bytes));
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
    const ext = extensionFor(doc.mime_type);
    const filename = `${updateId}-${index}${ext}`;
    const target = join(dir, filename);
    if (!isContainedIn(target, dir)) {
      errors.push("attachment path outside data dir");
      return;
    }
    await writeFile(target, new Uint8Array(bytes));
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
  const resolvedCandidate = isAbsolute(candidate) ? candidate : resolve(candidate);
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
export async function computeAttachmentsDiskUsage(dataDir: string): Promise<number> {
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
