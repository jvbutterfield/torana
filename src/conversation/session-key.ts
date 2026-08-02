import { createHash } from "node:crypto";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Provider-facing IDs are deliberately opaque and bounded. They never expose
 * Telegram IDs, Buzz channel UUIDs, aliases, or Agent API caller keys.
 */
export function runnerSessionId(sessionKey: string): string {
  const digest = createHash("sha256").update(sessionKey).digest();
  return `session-${base32(digest).slice(0, 38)}`;
}

export function agentApiSessionKey(agentId: string, sessionId: string): string {
  return `agent-api:${agentId}:session:${sessionId}`;
}

export function ephemeralSessionKey(turnUuid: string): string {
  return `ephemeral:${turnUuid}`;
}
