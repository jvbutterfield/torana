// File reader used by `torana ask` and `torana send` for `--file PATH`
// and `--file @-` (stdin). Returns bytes plus a best-effort MIME guess —
// from Bun.file metadata + extension for real files, or from magic bytes
// for stdin (where there's no filename to inspect). The server enforces
// the actual allowlist; we prefer surfacing `attachment_mime_not_allowed`
// from the gateway over guessing wrongly here.

import { CliUsageError } from "./args.js";

export interface ReadFileResult {
  data: Uint8Array;
  mime: string;
  /** Best-effort filename. `stdin.bin` / `stdin.png` etc. for `@-`. */
  filename: string;
}

export async function readFileForUpload(path: string): Promise<ReadFileResult> {
  if (path === "@-") {
    return readStdinForUpload();
  }
  const f = Bun.file(path);
  if (!(await f.exists())) {
    throw new CliUsageError(`file not found: ${path}`);
  }
  const buf = new Uint8Array(await f.arrayBuffer());
  const mime =
    f.type && f.type !== "application/octet-stream"
      ? f.type
      : (mimeFromPath(path) ?? "application/octet-stream");
  return { data: buf, mime, filename: basenameSafe(path) };
}

/**
 * Read stdin exhaustively and sniff MIME from magic bytes. Used when the
 * user passes `--file @-`. Only one `@-` per command is allowed — the
 * caller in ask.ts / send.ts enforces that and surfaces a usage error.
 *
 * Bun >= 1.1 exposes `Bun.stdin.bytes()`; we fall back to
 * `process.stdin` for older runtimes and non-Bun test envs.
 */
export async function readStdinForUpload(): Promise<ReadFileResult> {
  const bytes = await readAllStdinBytes();
  if (bytes.length === 0) {
    throw new CliUsageError(
      "--file @- expected bytes on stdin, but stdin was empty",
    );
  }
  const mime = detectMimeFromMagic(bytes) ?? "application/octet-stream";
  const ext = EXT_FROM_MIME[mime] ?? ".bin";
  return { data: bytes, mime, filename: `stdin${ext}` };
}

async function readAllStdinBytes(): Promise<Uint8Array> {
  // Prefer Bun.stdin when available (works in subprocess `torana` invocations
  // driven by `bun run`). Fall back to node streams for test harnesses that
  // stub process.stdin via a Readable.
  const b = (globalThis as { Bun?: typeof Bun }).Bun;
  if (b?.stdin && typeof b.stdin.bytes === "function") {
    const bytes = await b.stdin.bytes();
    return bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(bytes as ArrayBuffer);
  }
  return await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stdin = process.stdin;
    stdin.on("data", (c) =>
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
    );
    stdin.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    stdin.on("error", reject);
  });
}

export function mimeFromPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return undefined;
}

// Magic-byte MIME detection lives in src/mime-magic.ts (shared between CLI,
// Agent-API multipart, and Telegram download paths). Re-exported here for
// CLI callers that still reach through this module.
import { detectMimeFromMagic } from "../../mime-magic.js";
export { detectMimeFromMagic };

const EXT_FROM_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

function basenameSafe(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i === -1 ? path : path.slice(i + 1);
}
