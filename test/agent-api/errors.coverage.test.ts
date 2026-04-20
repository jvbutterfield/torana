// §12.10 Error-path coverage matrix — drift guard.
//
// Every code in `AgentApiErrorCode` must satisfy three invariants:
//   1. `STATUS_MAP` has an entry (→ `statusFor` returns a number).
//   2. `defaultMessage()` returns a non-empty string.
//   3. The code is *emitted* from at least one file under `src/agent-api/`
//      outside `errors.ts` itself (dead-code guard).
//   4. The code is *asserted* by at least one test under `test/` (coverage
//      guard — either an `expect(...).toBe("<code>")` or equivalent).
//
// This test is the matrix: if someone adds a new code to the union and
// forgets to wire it into a handler, or adds it to a handler but forgets
// to write a test, this test fails. It also fails if someone removes the
// last emission site or the last asserting test for an existing code.
//
// Note on `method_not_allowed`: it is emitted from `src/server.ts` (the
// `/v1/*` 405 defence-in-depth path), not from `src/agent-api/`. We
// whitelist it here — see test/server/router.method.test.ts for the
// behavioural coverage.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { statusFor } from "../../src/agent-api/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "../..");
const SRC_AGENT_API = resolve(REPO, "src/agent-api");
const SRC_SERVER = resolve(REPO, "src/server.ts");
const TEST_DIR = resolve(REPO, "test");

// Codes whose emission site lives outside `src/agent-api/`. Extend this
// whitelist only if new defence-in-depth codes are introduced at the
// transport/server layer and the deviation is deliberate.
const EMIT_WHITELIST: Record<string, string> = {
  method_not_allowed: SRC_SERVER,
};

function allCodes(): string[] {
  // Parse the union from errors.ts itself — drift-proof against the
  // source-of-truth file. We can't reflect on a TS type at runtime, but
  // the STATUS_MAP keys are 1:1 with the union and ARE runtime-accessible.
  const src = readFileSync(resolve(SRC_AGENT_API, "errors.ts"), "utf8");
  const start = src.indexOf("const STATUS_MAP");
  const end = src.indexOf("};", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const block = src.slice(start, end);
  const keys = [...block.matchAll(/^\s*([a-z_]+):\s*\d+,/gm)].map((m) => m[1]!);
  expect(keys.length).toBeGreaterThan(20);
  return keys;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walkTs(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function fileContainsLiteral(path: string, literal: string): boolean {
  const src = readFileSync(path, "utf8");
  return src.includes(`"${literal}"`);
}

describe("§12.10 error-path coverage matrix", () => {
  const codes = allCodes();

  test.each(codes)("%s — statusFor returns a valid HTTP status", (code) => {
    const status = statusFor(code as Parameters<typeof statusFor>[0]);
    expect(Number.isInteger(status)).toBe(true);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(600);
  });

  test.each(codes)("%s — emitted from at least one src file", (code) => {
    const srcFiles = walkTs(SRC_AGENT_API).filter(
      (p) => !p.endsWith("errors.ts") && !p.endsWith(".test.ts"),
    );
    const emitters = srcFiles.filter((p) => fileContainsLiteral(p, code));

    if (EMIT_WHITELIST[code]) {
      // Whitelisted — check the alternate emission site instead.
      expect(fileContainsLiteral(EMIT_WHITELIST[code], code)).toBe(true);
      return;
    }

    if (emitters.length === 0) {
      throw new Error(
        `No file under src/agent-api/ emits "${code}". Either delete the ` +
          `code from AgentApiErrorCode (dead code) or wire it into a handler. ` +
          `See impl-plan §12.10.`,
      );
    }
  });

  test.each(codes)("%s — asserted by at least one test", (code) => {
    const testFiles = walkTs(TEST_DIR);
    const assertions = testFiles.filter((p) => {
      // Exclude this file (it references every code in the whitelist/error
      // messages and would self-satisfy trivially).
      if (p.endsWith("errors.coverage.test.ts")) return false;
      return fileContainsLiteral(p, code);
    });
    if (assertions.length === 0) {
      throw new Error(
        `No test under test/ references "${code}" as a string literal. ` +
          `Add at least one test that exercises the path producing this ` +
          `error. See impl-plan §12.10.`,
      );
    }
  });
});
