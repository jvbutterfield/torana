import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Config } from "../../config/schema.js";
import { computeAttachmentsDiskUsage } from "../../core/attachments.js";
import { detectMimeFromMagic } from "../../mime-magic.js";
import type {
  InboundEvent,
  LocalAttachment,
  RemoteAttachment,
} from "../types.js";
import { decodeSecret, signTemplate } from "./protocol.js";

const BLOSSOM_AUTH_KIND = 24_242;
const FETCH_TIMEOUT_MS = 120_000;
const RESPONSE_METADATA_MAX_BYTES = 64 * 1024;
const ALLOWED_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
};
const LOWER_SHA256 = /^[0-9a-f]{64}$/;

export interface BuzzBlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded?: number;
  dim?: string;
  blurhash?: string;
  thumb?: string;
  duration?: number;
}

export type BuzzFetch = typeof fetch;

export async function downloadBuzzAttachments(args: {
  event: InboundEvent;
  config: Config;
  relayUrl: string;
  privateKey: string;
  authTag: string | null;
  fetchImpl?: BuzzFetch;
}): Promise<{ attachments: LocalAttachment[]; errors: string[] }> {
  const attachments: LocalAttachment[] = [];
  const errors: string[] = [];
  const candidates = args.event.attachments.slice(
    0,
    args.config.attachments.max_per_turn,
  );
  if (args.event.attachments.length > candidates.length) {
    errors.push("too many attachments");
  }
  const dir = resolve(
    args.config.gateway.data_dir,
    "attachments",
    args.event.agentId,
  );
  await mkdir(dir, { recursive: true });
  let aggregateBytes = 0;

  for (const [index, remote] of candidates.entries()) {
    try {
      const metadata = validateRemoteAttachment(remote, args.relayUrl);
      if (metadata.size > args.config.attachments.max_bytes) {
        throw new Error("attachment exceeds max_bytes");
      }
      if (
        aggregateBytes + metadata.size >
        args.config.attachments.max_bytes * args.config.attachments.max_per_turn
      ) {
        throw new Error("attachment turn aggregate exceeds limit");
      }
      const diskUsage = await computeAttachmentsDiskUsage(
        args.config.gateway.data_dir,
      );
      if (
        diskUsage + metadata.size >
        args.config.attachments.disk_usage_cap_bytes
      ) {
        throw new Error("attachment disk usage cap would be exceeded");
      }
      const bytes = await fetchMediaBytes({
        url: metadata.url,
        expectedSize: metadata.size,
        maxBytes: args.config.attachments.max_bytes,
        relayUrl: args.relayUrl,
        privateKey: args.privateKey,
        authTag: args.authTag,
        fetchImpl: args.fetchImpl,
      });
      verifyMediaBytes(bytes, metadata);
      const ext = ALLOWED_MIME_EXTENSIONS[metadata.mime];
      const target = await writeExclusive(
        dir,
        `buzz-${args.event.externalEventId.slice(0, 16)}-${index}`,
        ext,
        bytes,
      );
      attachments.push({
        kind: metadata.mime.startsWith("image/") ? "photo" : "document",
        path: target,
        mime_type: metadata.mime,
        original_filename: metadata.filename ?? undefined,
        bytes: bytes.byteLength,
      });
      aggregateBytes += bytes.byteLength;
    } catch (error) {
      errors.push(
        `attachment ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { attachments, errors };
}

export async function uploadBuzzFiles(args: {
  files: readonly LocalAttachment[];
  maxBytes: number;
  relayUrl: string;
  privateKey: string;
  authTag: string | null;
  fetchImpl?: BuzzFetch;
}): Promise<BuzzBlobDescriptor[]> {
  const descriptors: BuzzBlobDescriptor[] = [];
  for (const file of args.files) {
    const info = await lstat(file.path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("outbound attachment must be a regular non-symlink file");
    }
    if (info.size > args.maxBytes) {
      throw new Error("outbound attachment exceeds max_bytes");
    }
    const bytes = new Uint8Array(await readFile(file.path));
    if (bytes.byteLength > args.maxBytes) {
      throw new Error("outbound attachment exceeded max_bytes while reading");
    }
    const mime = detectMimeFromMagic(bytes);
    if (!mime || !(mime in ALLOWED_MIME_EXTENSIONS)) {
      throw new Error("outbound attachment MIME is not allowed");
    }
    if (file.mime_type && file.mime_type !== mime) {
      throw new Error("outbound attachment MIME does not match its bytes");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const descriptor = await uploadOne({
      bytes,
      mime,
      sha256,
      relayUrl: args.relayUrl,
      privateKey: args.privateKey,
      authTag: args.authTag,
      fetchImpl: args.fetchImpl,
    });
    descriptors.push(descriptor);
  }
  return descriptors;
}

export function buildImetaTag(descriptor: BuzzBlobDescriptor): string[] {
  const tag = [
    "imeta",
    `url ${descriptor.url}`,
    `m ${descriptor.type}`,
    `x ${descriptor.sha256}`,
    `size ${descriptor.size}`,
  ];
  if (descriptor.dim) tag.push(`dim ${descriptor.dim}`);
  if (descriptor.blurhash) tag.push(`blurhash ${descriptor.blurhash}`);
  if (descriptor.thumb) tag.push(`thumb ${descriptor.thumb}`);
  if (descriptor.duration !== undefined)
    tag.push(`duration ${descriptor.duration}`);
  return tag;
}

function validateRemoteAttachment(
  attachment: RemoteAttachment,
  relayUrl: string,
): {
  url: string;
  sha256: string;
  size: number;
  mime: string;
  filename: string | null;
} {
  if (!Array.isArray(attachment.raw)) throw new Error("invalid imeta tag");
  const fields = parseImetaFields(attachment.raw as unknown[]);
  const url = required(fields, "url");
  const sha256 = required(fields, "x");
  const mime = required(fields, "m").toLowerCase();
  const sizeText = required(fields, "size");
  if (!LOWER_SHA256.test(sha256)) throw new Error("invalid imeta sha256");
  if (!(mime in ALLOWED_MIME_EXTENSIONS))
    throw new Error(`imeta MIME '${mime}' is not allowed`);
  if (!/^\d+$/.test(sizeText)) throw new Error("invalid imeta size");
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new Error("invalid imeta size");
  validateRelayMediaUrl(url, relayUrl, sha256);
  return {
    url,
    sha256,
    size,
    mime,
    filename: fields.get("filename") ?? null,
  };
}

function parseImetaFields(raw: unknown[]): Map<string, string> {
  if (raw[0] !== "imeta") throw new Error("invalid imeta tag");
  const fields = new Map<string, string>();
  for (const value of raw.slice(1)) {
    if (typeof value !== "string") throw new Error("invalid imeta field");
    const split = value.indexOf(" ");
    if (split <= 0) throw new Error("invalid imeta field");
    const key = value.slice(0, split);
    if (fields.has(key)) throw new Error(`duplicate imeta field '${key}'`);
    fields.set(key, value.slice(split + 1));
  }
  return fields;
}

function required(fields: ReadonlyMap<string, string>, key: string): string {
  const value = fields.get(key)?.trim();
  if (!value) throw new Error(`imeta is missing '${key}'`);
  return value;
}

function validateRelayMediaUrl(
  input: string,
  relayUrl: string,
  expectedHash: string,
): URL {
  const media = new URL(input);
  const relay = relayHttpUrl(relayUrl);
  if (
    media.protocol !== relay.protocol ||
    media.hostname !== relay.hostname ||
    effectivePort(media) !== effectivePort(relay)
  ) {
    throw new Error("media URL is not on the configured relay origin");
  }
  if (media.username || media.password || media.search || media.hash) {
    throw new Error(
      "media URL contains forbidden credentials, query, or fragment",
    );
  }
  const segment = media.pathname.slice("/media/".length);
  if (!media.pathname.startsWith("/media/") || segment.includes("/")) {
    throw new Error("media URL must use a single /media/ path segment");
  }
  if (!segment.startsWith(expectedHash)) {
    throw new Error("media URL hash does not match imeta");
  }
  const suffix = segment.slice(expectedHash.length);
  if (suffix && !/^\.(?:[a-z0-9]{1,8}|thumb\.jpg)$/.test(suffix)) {
    throw new Error("media URL extension is invalid");
  }
  return media;
}

async function fetchMediaBytes(args: {
  url: string;
  expectedSize: number;
  maxBytes: number;
  relayUrl: string;
  privateKey: string;
  authTag: string | null;
  fetchImpl?: BuzzFetch;
}): Promise<Uint8Array> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(args.url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: blossomHeaders(
        args.privateKey,
        args.relayUrl,
        "get",
        null,
        args.authTag,
      ),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("media redirect rejected");
    }
    if (!response.ok) throw new Error(`media GET failed (${response.status})`);
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") {
      throw new Error("compressed media response rejected");
    }
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) !== args.expectedSize) {
      throw new Error("media Content-Length does not match imeta");
    }
    if (!response.body) throw new Error("media response body is missing");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > args.maxBytes || size > args.expectedSize) {
        await reader.cancel();
        throw new Error("media response exceeded its byte limit");
      }
      chunks.push(value);
    }
    if (size !== args.expectedSize)
      throw new Error("media response size does not match imeta");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

function verifyMediaBytes(
  bytes: Uint8Array,
  expected: { sha256: string; mime: string },
): void {
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expected.sha256)
    throw new Error("media sha256 does not match imeta");
  const actualMime = detectMimeFromMagic(bytes);
  if (actualMime !== expected.mime) {
    throw new Error("media magic bytes do not match imeta MIME");
  }
}

async function uploadOne(args: {
  bytes: Uint8Array;
  mime: string;
  sha256: string;
  relayUrl: string;
  privateKey: string;
  authTag: string | null;
  fetchImpl?: BuzzFetch;
}): Promise<BuzzBlobDescriptor> {
  const relay = relayHttpUrl(args.relayUrl);
  const primary = new URL("/upload", relay).toString();
  let response = await uploadRequest(primary, args);
  if (response.status === 404 || response.status === 405) {
    response = await uploadRequest(
      new URL("/media/upload", relay).toString(),
      args,
    );
  }
  if (!response.ok) throw new Error(`media upload failed (${response.status})`);
  const body = await readSmallResponse(response);
  let descriptor: BuzzBlobDescriptor;
  try {
    descriptor = JSON.parse(body) as BuzzBlobDescriptor;
  } catch {
    throw new Error("media upload returned invalid JSON");
  }
  if (
    descriptor.sha256 !== args.sha256 ||
    descriptor.size !== args.bytes.byteLength ||
    descriptor.type !== args.mime
  ) {
    throw new Error("media upload descriptor does not match the uploaded file");
  }
  validateRelayMediaUrl(descriptor.url, args.relayUrl, args.sha256);
  if (descriptor.thumb)
    validateRelayMediaUrl(descriptor.thumb, args.relayUrl, args.sha256);
  return descriptor;
}

async function uploadRequest(
  url: string,
  args: Parameters<typeof uploadOne>[0],
): Promise<Response> {
  const fetchImpl = args.fetchImpl ?? fetch;
  return await fetchImpl(url, {
    method: "PUT",
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      ...blossomHeaders(
        args.privateKey,
        args.relayUrl,
        "upload",
        args.sha256,
        args.authTag,
      ),
      "content-type": args.mime,
      "x-sha-256": args.sha256,
    },
    body: Buffer.from(args.bytes),
  });
}

function blossomHeaders(
  privateKey: string,
  relayUrl: string,
  verb: "get" | "upload",
  sha256: string | null,
  authTag: string | null,
): Record<string, string> {
  const now = Math.floor(Date.now() / 1000);
  const relay = relayHttpUrl(relayUrl);
  const tags: string[][] = [
    ["t", verb],
    ["expiration", String(now + (verb === "upload" ? 600 : 600))],
    ["server", relay.host],
  ];
  if (sha256) tags.splice(1, 0, ["x", sha256]);
  const event = signTemplate(
    {
      kind: BLOSSOM_AUTH_KIND,
      created_at: now,
      content: verb === "upload" ? "Upload file" : "Get media",
      tags,
    },
    decodeSecret(privateKey),
  );
  return {
    authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64url")}`,
    ...(authTag ? { "x-auth-tag": authTag } : {}),
  };
}

async function readSmallResponse(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > RESPONSE_METADATA_MAX_BYTES)
    throw new Error("media upload response is too large");
  const text = await response.text();
  if (Buffer.byteLength(text) > RESPONSE_METADATA_MAX_BYTES)
    throw new Error("media upload response is too large");
  return text;
}

function relayHttpUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Buzz relay URL must use ws, wss, http, or https");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

async function writeExclusive(
  dir: string,
  baseName: string,
  ext: string,
  bytes: Uint8Array,
): Promise<string> {
  const flags =
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_WRONLY |
    (fsConstants.O_NOFOLLOW ?? 0);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const name =
      attempt === 0 ? `${baseName}${ext}` : `${baseName}-${randomUUID()}${ext}`;
    const target = join(dir, name);
    let handle;
    try {
      handle = await open(target, flags, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    return target;
  }
  throw new Error("attachment filename collision after retries");
}
