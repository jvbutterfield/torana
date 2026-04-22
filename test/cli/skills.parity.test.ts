// Wraps scripts/check-skill-parity.ts so CI fails the moment skills/ and
// codex-plugin/skills/ drift apart. Also covers the tooling contract:
// checkParity is callable in-process and returns a structured diff.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, cpSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkParity, syncSkills } from "../../scripts/check-skill-parity.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("skill parity (real repo)", () => {
  test("codex-plugin skills match source byte-for-byte", () => {
    const r = checkParity(REPO_ROOT);
    if (!r.ok) {
      const detail = r.entries
        .filter((e) => e.drift)
        .map((e) => `${e.skill}: ${e.drift}`)
        .join("; ");
      throw new Error(`parity drift: ${detail}`);
    }
    expect(r.entries.length).toBe(2);
    for (const e of r.entries) {
      expect(e.drift).toBeNull();
      expect(e.sourceHash.length).toBe(64);
      expect(e.targetHash).toBe(e.sourceHash);
    }
  });
});

describe("skill parity (synthetic)", () => {
  function makeFakeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "torana-parity-"));
    cpSync(join(REPO_ROOT, "skills"), join(root, "skills"), { recursive: true });
    cpSync(join(REPO_ROOT, "codex-plugin"), join(root, "codex-plugin"), { recursive: true });
    return root;
  }

  test("detects hash-mismatch drift", () => {
    const root = makeFakeRepo();
    const target = join(root, "codex-plugin", "skills", "torana-ask", "SKILL.md");
    writeFileSync(target, "edited — should fail parity\n");
    const r = checkParity(root);
    expect(r.ok).toBe(false);
    const ask = r.entries.find((e) => e.skill === "torana-ask");
    expect(ask?.drift).toBe("hash-mismatch");
  });

  test("detects missing target", () => {
    const root = makeFakeRepo();
    const target = join(root, "codex-plugin", "skills", "torana-send", "SKILL.md");
    // Use unlinkSync
    const { unlinkSync } = require("node:fs") as typeof import("node:fs");
    unlinkSync(target);
    const r = checkParity(root);
    expect(r.ok).toBe(false);
    const send = r.entries.find((e) => e.skill === "torana-send");
    expect(send?.drift).toBe("missing-target");
  });

  test("syncSkills restores parity after target edit", () => {
    const root = makeFakeRepo();
    const target = join(root, "codex-plugin", "skills", "torana-ask", "SKILL.md");
    writeFileSync(target, "broken");
    expect(checkParity(root).ok).toBe(false);
    syncSkills(root);
    expect(checkParity(root).ok).toBe(true);
  });

  test("syncSkills creates missing target directory", () => {
    const root = makeFakeRepo();
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    rmSync(join(root, "codex-plugin", "skills", "torana-ask"), { recursive: true, force: true });
    syncSkills(root);
    expect(existsSync(join(root, "codex-plugin", "skills", "torana-ask", "SKILL.md"))).toBe(true);
    expect(checkParity(root).ok).toBe(true);
  });
});
