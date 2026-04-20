// Bearer-token authentication + per-route authorization for the agent API.
// Tokens are compared against SHA-256 hashes computed at config-load time.

import { createHash, timingSafeEqual } from "node:crypto";

import type { AuthFailure, AuthSuccess, Scope } from "./types.js";
import type { ResolvedAgentApiToken } from "../config/load.js";

const BEARER_RE = /^Bearer\s+(.+)$/i;

/**
 * Parse the Authorization header and match against registered tokens in
 * constant time. Returns the token on success or a typed failure otherwise.
 */
export function authenticate(
  tokens: readonly ResolvedAgentApiToken[],
  header: string | null,
): AuthSuccess | AuthFailure {
  if (!header) return { kind: "missing_auth" };
  const match = BEARER_RE.exec(header.trim());
  if (!match) return { kind: "missing_auth" };

  const presented = match[1]!;
  const presentedHash = createHash("sha256").update(presented, "utf8").digest();

  for (const t of tokens) {
    const stored = Buffer.from(t.hash);
    if (stored.length !== presentedHash.length) continue;
    if (timingSafeEqual(stored, presentedHash)) {
      return { token: t };
    }
  }
  return { kind: "invalid_token" };
}

/**
 * Check a validated token against the route's bot + scope requirements.
 * Returns null on success, or a failure kind on mismatch.
 */
export function authorize(
  token: ResolvedAgentApiToken,
  botId: string,
  required: Scope,
): AuthFailure | null {
  if (!token.bot_ids.includes(botId)) return { kind: "bot_not_permitted", botId };
  if (!token.scopes.includes(required)) return { kind: "scope_not_permitted", scope: required };
  return null;
}
