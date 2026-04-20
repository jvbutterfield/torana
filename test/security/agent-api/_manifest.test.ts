// §12.5 security matrix — manifest drift guard.
//
// Each row of the matrix in tasks/impl-agent-api.md §12.5 names one
// or more test files. If a file is renamed, deleted, or never created,
// this guard fails loud. New rows added to the matrix must add their
// file to MATRIX_FILES below AND create the file; the complementary
// check is that no unaccounted-for *.test.ts file sits in this
// directory (defence against the "stub test that never runs" problem).

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Canonical list, transcribed from the matrix. Keep this in exact
 * sync with the table in tasks/impl-agent-api.md §12.5 — if you add
 * a row, add the file here.
 */
const MATRIX_FILES = [
  // §12.5.1 Authentication
  "auth.no-header.test.ts",
  "auth.wrong-scheme.test.ts",
  "auth.wrong-token.test.ts",
  "auth.timing.test.ts",
  "auth.case-mutation.test.ts",
  "auth.log-redaction.test.ts",
  // §12.5.2 Authorization
  "authz.wrong-bot.test.ts",
  "authz.wrong-scope.test.ts",
  "authz.enumeration-resistance.test.ts",
  "authz.admin-scope.test.ts",
  // §12.5.3 Input validation
  "input.huge-body.test.ts",
  "input.zip-bomb.test.ts",
  "input.path-traversal.test.ts",
  "input.null-byte.test.ts",
  "input.source-label.test.ts",
  "input.idempotency-key-injection.test.ts",
  "input.yaml-bomb.test.ts",
  "input.marker-injection.test.ts",
  // §12.5.4 Resource exhaustion
  "resource.side-session-flood.test.ts",
  "resource.disk-fill.test.ts",
  "resource.slow-loris.test.ts",
  "resource.idempotency-store-bloat.test.ts",
  // §12.5.5 Injection class
  "inject-attack.chat-forgery.test.ts",
  "inject-attack.acl-bypass.test.ts",
  "inject-attack.cross-bot.test.ts",
  "inject-attack.idempotency-reuse-different-content.test.ts",
  "inject-attack.runner-prompt-injection.test.ts",
  // §12.5.6 Disclosure
  "disclosure.error-body.test.ts",
  "disclosure.metrics-labels.test.ts",
  "disclosure.logs.test.ts",
] as const;

describe("§12.5 security matrix — manifest drift guard", () => {
  test("each matrix row's test file exists", () => {
    const missing: string[] = [];
    for (const name of MATRIX_FILES) {
      const path = resolve(__dirname, name);
      if (!existsSync(path) || !statSync(path).isFile()) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  test("no unaccounted-for *.test.ts file sits in the security dir", () => {
    // The manifest is the source of truth. `_manifest.test.ts`
    // (this file) and `_harness.ts` are allowed; everything else
    // must appear in MATRIX_FILES.
    const known = new Set<string>([
      "_manifest.test.ts",
      "_harness.ts",
      ...MATRIX_FILES,
    ]);
    const entries = readdirSync(__dirname).filter(
      (name) => name.endsWith(".test.ts") || name.endsWith(".ts"),
    );
    const unknown = entries.filter((name) => !known.has(name));
    expect(unknown).toEqual([]);
  });

  test("manifest covers all six matrix subsections", () => {
    // Cheap sanity that no subsection was dropped on the floor.
    const counts: Record<string, number> = {
      "auth.": 0,
      "authz.": 0,
      "input.": 0,
      "resource.": 0,
      "inject-attack.": 0,
      "disclosure.": 0,
    };
    for (const name of MATRIX_FILES) {
      for (const prefix of Object.keys(counts)) {
        if (name.startsWith(prefix)) counts[prefix]! += 1;
      }
    }
    expect(counts["auth."]).toBe(6);
    expect(counts["authz."]).toBe(4);
    expect(counts["input."]).toBe(8);
    expect(counts["resource."]).toBe(4);
    expect(counts["inject-attack."]).toBe(5);
    expect(counts["disclosure."]).toBe(3);
    // Total must equal the matrix size.
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(30);
  });
});
