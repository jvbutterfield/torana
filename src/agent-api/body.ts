// Streaming + size-capped JSON body reader for /v1 write routes.
//
// Problem motivating this module: `req.json()` and `req.formData()` fully
// buffer the request body before any caller code runs. An authenticated client
// sending a chunked (no Content-Length) or a declared-small-but-lying body
// can force the process to allocate arbitrary memory before our size caps
// get a chance to fire.
//
// Defence:
//   1. If the caller supplies `Content-Length`, reject up-front when it
//      exceeds the cap. This short-circuits the common case.
//   2. Otherwise, stream `req.body` chunk-by-chunk, abort the reader as soon
//      as accumulated bytes exceed the cap, and only hand back a parsed
//      JSON value if we stayed under the limit.
//
// Multipart bodies are still handled by parseMultipartRequest() in
// attachments.ts, which applies its own Content-Length precheck and
// aggregate accounting.

import { logger } from "../log.js";

const log = logger("agent-api-body");

export type ReadJsonBodyResult =
  | { kind: "ok"; value: unknown }
  | { kind: "err"; code: "body_too_large" | "invalid_body"; detail?: string };

/**
 * Read a JSON request body with a hard byte cap.
 *
 * @param req      The incoming Request.
 * @param maxBytes Maximum bytes of raw body to accept. Must be > 0.
 */
export async function readJsonBody(
  req: Request,
  maxBytes: number,
): Promise<ReadJsonBodyResult> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > 0 && declared > maxBytes) {
    return {
      kind: "err",
      code: "body_too_large",
      detail: `content-length ${declared} > max ${maxBytes}`,
    };
  }

  const body = req.body;
  if (!body) {
    // No body stream (e.g. GET-shaped fetch). Fall through to req.json()
    // which will raise on empty/invalid input — mapped to invalid_body.
    try {
      return { kind: "ok", value: await req.json() };
    } catch {
      return { kind: "err", code: "invalid_body", detail: "body must be JSON" };
    }
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Abort the underlying stream so the peer stops sending.
        try {
          await reader.cancel("body_too_large");
        } catch {
          /* ignore — we're already aborting */
        }
        return {
          kind: "err",
          code: "body_too_large",
          detail: `streamed ${total} bytes > max ${maxBytes}`,
        };
      }
      chunks.push(value);
    }
  } catch (err) {
    // Stream-reader failure (peer abort, TLS error, internal Bun stream
    // state, etc.). Log raw cause server-side; respond with a canonical
    // detail. Bun stream errors can carry internal state / file paths
    // that must not surface to the client.
    log.warn("body stream read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: "err",
      code: "invalid_body",
      detail: "malformed body",
    };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* reader may already be released if we cancelled */
    }
  }

  if (total === 0) {
    return { kind: "err", code: "invalid_body", detail: "body must be JSON" };
  }

  // Concatenate + decode + parse. We only reach this point if we're under
  // the cap, so the allocation is bounded by maxBytes.
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(merged);
  } catch {
    return {
      kind: "err",
      code: "invalid_body",
      detail: "body must be UTF-8 JSON",
    };
  }
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "err", code: "invalid_body", detail: "body must be JSON" };
  }
}
