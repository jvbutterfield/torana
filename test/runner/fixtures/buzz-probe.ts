// Shared by the runner mocks' `buzz-probe` modes.
//
// Resolves the Buzz capability the same way `readCapability` in
// src/cli/buzz.ts does — same env vars, same path shape, same validity
// checks — so a "capability=yes" from a mock means a real `torana buzz` call
// from that subprocess would have been authorized at that moment. Tests
// assert on this rather than on the gateway's own bookkeeping, which is what
// makes them a check of the contract instead of a check of our notes about
// the contract.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function buzzProbeReply(): string {
  const sessionId = process.env.TORANA_SESSION_ID ?? "";
  const directory = process.env.TORANA_BUZZ_CAPABILITY_DIR ?? "";
  let capability = "no";
  if (sessionId && /^[A-Za-z0-9_-]{1,64}$/.test(sessionId) && directory) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(directory, `${sessionId}.json`), "utf8"),
      ) as { version?: number; token?: unknown; expiresAt?: number };
      if (
        parsed.version === 1 &&
        typeof parsed.token === "string" &&
        (parsed.expiresAt ?? 0) > Date.now()
      ) {
        capability = "yes";
      }
    } catch {
      capability = "no";
    }
  }
  return `session=${sessionId} capability=${capability}`;
}
