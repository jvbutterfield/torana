import { createHash, timingSafeEqual } from "node:crypto";
import type { ResolvedPublisherApiToken } from "../config/load.js";

const BEARER_RE = /^Bearer\s+(.+)$/i;

export type PublisherAuthResult =
  | { token: ResolvedPublisherApiToken }
  | { error: "missing_auth" | "invalid_token" };

export function authenticatePublisher(
  tokens: readonly ResolvedPublisherApiToken[],
  header: string | null,
): PublisherAuthResult {
  if (!header) return { error: "missing_auth" };
  const match = BEARER_RE.exec(header.trim());
  if (!match) return { error: "missing_auth" };
  const presented = createHash("sha256").update(match[1]!, "utf8").digest();
  let found: ResolvedPublisherApiToken | null = null;
  for (const token of tokens) {
    const stored = Buffer.from(token.hash);
    const equal =
      stored.length === presented.length && timingSafeEqual(stored, presented);
    if (equal) found = token;
  }
  return found ? { token: found } : { error: "invalid_token" };
}
