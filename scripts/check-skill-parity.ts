// Verify that `codex-plugin/skills/<name>/SKILL.md` is byte-identical to
// `skills/<name>/SKILL.md`. Invoked from `bun test` (via
// test/cli/skills.parity.test.ts) and from `scripts/build.ts` as a
// pre-publish gate.
//
// Exits 0 on parity, 1 on drift (with a diff hint), 2 on missing file.

import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const SKILLS = ["torana-ask", "torana-send"] as const;

export interface ParityResult {
  ok: boolean;
  entries: Array<{
    skill: (typeof SKILLS)[number];
    source: string;
    target: string;
    sourceHash: string;
    targetHash: string | null;
    drift: "missing-source" | "missing-target" | "hash-mismatch" | null;
  }>;
}

export function checkParity(repoRoot?: string): ParityResult {
  const root = repoRoot ?? resolveRepoRoot();
  const entries: ParityResult["entries"] = [];
  let ok = true;
  for (const skill of SKILLS) {
    const source = join(root, "skills", skill, "SKILL.md");
    const target = join(root, "codex-plugin", "skills", skill, "SKILL.md");
    if (!existsSync(source)) {
      entries.push({
        skill,
        source,
        target,
        sourceHash: "",
        targetHash: null,
        drift: "missing-source",
      });
      ok = false;
      continue;
    }
    const srcBytes = readFileSync(source);
    const sourceHash = sha256(srcBytes);
    if (!existsSync(target)) {
      entries.push({
        skill,
        source,
        target,
        sourceHash,
        targetHash: null,
        drift: "missing-target",
      });
      ok = false;
      continue;
    }
    const tgtBytes = readFileSync(target);
    const targetHash = sha256(tgtBytes);
    if (sourceHash !== targetHash) {
      entries.push({
        skill,
        source,
        target,
        sourceHash,
        targetHash,
        drift: "hash-mismatch",
      });
      ok = false;
    } else {
      entries.push({
        skill,
        source,
        target,
        sourceHash,
        targetHash,
        drift: null,
      });
    }
  }
  return { ok, entries };
}

/**
 * Overwrite each `codex-plugin/skills/<name>/SKILL.md` with a fresh copy
 * of its source. Used by `scripts/build.ts` to keep the codex-plugin tree
 * in lockstep during the build; not invoked by tests.
 */
export function syncSkills(repoRoot?: string): void {
  const root = repoRoot ?? resolveRepoRoot();
  for (const skill of SKILLS) {
    const source = join(root, "skills", skill, "SKILL.md");
    const target = join(root, "codex-plugin", "skills", skill, "SKILL.md");
    if (!existsSync(source)) {
      throw new Error(`source skill missing: ${source}`);
    }
    if (!existsSync(dirname(target))) {
      mkdirSync(dirname(target), { recursive: true });
    }
    copyFileSync(source, target);
  }
}

function sha256(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveRepoRoot(): string {
  // scripts/check-skill-parity.ts → repo root
  const here = new URL(import.meta.url).pathname;
  return resolve(here, "..", "..");
}

if (import.meta.main) {
  const result = checkParity();
  if (result.ok) {
    console.log("skill parity: ok");
    for (const e of result.entries) {
      console.log(
        `  ${e.skill}: ${e.sourceHash.slice(0, 12)} == ${e.targetHash?.slice(0, 12)}`,
      );
    }
    process.exit(0);
  }
  console.error("skill parity: DRIFT");
  for (const e of result.entries) {
    if (!e.drift) continue;
    if (e.drift === "missing-source") {
      console.error(`  ${e.skill}: source missing at ${e.source}`);
    } else if (e.drift === "missing-target") {
      console.error(`  ${e.skill}: target missing at ${e.target}`);
    } else {
      console.error(
        `  ${e.skill}: ${e.sourceHash.slice(0, 12)} != ${e.targetHash?.slice(0, 12)}`,
      );
      console.error(`    diff: diff -u ${e.source} ${e.target}`);
    }
  }
  process.exit(1);
}
