// §12.4 E2E matrix — manifest drift guard. Parallel to the §12.5
// manifest in test/security/agent-api/_manifest.test.ts. Every file
// the matrix names must exist; no orphan *.test.ts can sit in this
// directory.
//
// This guard runs even WITHOUT AGENT_API_E2E=1 — it checks file
// presence, not behaviour, and we want file-drift to fail loud in
// the default suite.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MATRIX_FILES = [
  "ask-claude.test.ts",
  "ask-codex.test.ts",
  "send-claude.test.ts",
  "cli-remote.test.ts",
] as const;

describe("§12.4 E2E matrix — manifest drift guard", () => {
  test("each matrix row's test file exists", () => {
    const missing: string[] = [];
    for (const name of MATRIX_FILES) {
      const path = resolve(__dirname, name);
      if (!existsSync(path) || !statSync(path).isFile()) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  test("no unaccounted-for *.test.ts file sits in the e2e dir", () => {
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

  test("manifest covers all four §12.4 tests (sanity)", () => {
    expect(MATRIX_FILES.length).toBe(4);
    // Same subsection prefixes the matrix uses.
    expect(MATRIX_FILES.some((f) => f.startsWith("ask-"))).toBe(true);
    expect(MATRIX_FILES.some((f) => f.startsWith("send-"))).toBe(true);
    expect(MATRIX_FILES.some((f) => f.startsWith("cli-"))).toBe(true);
  });
});
