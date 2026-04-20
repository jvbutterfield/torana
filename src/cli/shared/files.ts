// File reader used by `torana ask` and `torana inject` for `--file PATH`.
// Returns bytes plus a best-effort MIME guess by extension. The server
// enforces the actual allowlist; we prefer surfacing
// `attachment_mime_not_allowed` over guessing wrongly here.

import { CliUsageError } from "./args.js";

export interface ReadFileResult {
  data: Uint8Array;
  mime: string;
}

export async function readFileForUpload(path: string): Promise<ReadFileResult> {
  const f = Bun.file(path);
  if (!(await f.exists())) {
    throw new CliUsageError(`file not found: ${path}`);
  }
  const buf = new Uint8Array(await f.arrayBuffer());
  const mime =
    f.type && f.type !== "application/octet-stream"
      ? f.type
      : mimeFromPath(path) ?? "application/octet-stream";
  return { data: buf, mime };
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
