// Tests for `torana skills install` (src/cli/skills.ts) + the underlying
// scripts/install-skills.ts helper. All tests operate against tmpdir
// targets via --claude-target / --codex-target so we never touch the real
// ~/.claude or ~/.agents trees.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSkills } from "../../src/cli/skills.js";
import {
  installSkills,
  claudeSkillsDir,
  codexSkillsDir,
} from "../../scripts/install-skills.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "torana-skills-"));
}

const REPO_SKILLS = join(import.meta.dir, "..", "..", "skills");

describe("installSkills (helper)", () => {
  test("copies both skills to claude target with 0644", () => {
    const claude = tmpDir();
    const r = installSkills({
      hosts: ["claude"],
      claudeTarget: claude,
      sourceDir: REPO_SKILLS,
    });
    const ask = join(claude, "torana-ask", "SKILL.md");
    const inject = join(claude, "torana-inject", "SKILL.md");
    expect(existsSync(ask)).toBe(true);
    expect(existsSync(inject)).toBe(true);
    expect(statSync(ask).mode & 0o777).toBe(0o644);
    expect(r.actions.every((a) => a.action === "copied")).toBe(true);
    expect(r.actions).toHaveLength(2);
  });

  test("both hosts → 4 actions (2 skills × 2 hosts)", () => {
    const claude = tmpDir();
    const codex = tmpDir();
    const r = installSkills({
      hosts: ["claude", "codex"],
      claudeTarget: claude,
      codexTarget: codex,
      sourceDir: REPO_SKILLS,
    });
    expect(r.actions).toHaveLength(4);
    const hosts = new Set(r.actions.map((a) => a.host));
    expect(hosts.has("claude")).toBe(true);
    expect(hosts.has("codex")).toBe(true);
  });

  test("default refuses to overwrite a modified target", () => {
    const claude = tmpDir();
    mkdirSync(join(claude, "torana-ask"), { recursive: true });
    writeFileSync(
      join(claude, "torana-ask", "SKILL.md"),
      "different content — user edits",
    );
    const r = installSkills({
      hosts: ["claude"],
      claudeTarget: claude,
      sourceDir: REPO_SKILLS,
    });
    const ask = r.actions.find((a) => a.skill === "torana-ask");
    expect(ask?.action).toBe("refused-different");
    // The user-edited file must still be intact.
    expect(readFileSync(join(claude, "torana-ask", "SKILL.md"), "utf-8")).toContain("user edits");
  });

  test("--force overwrites a modified target", () => {
    const claude = tmpDir();
    mkdirSync(join(claude, "torana-ask"), { recursive: true });
    writeFileSync(
      join(claude, "torana-ask", "SKILL.md"),
      "different content — user edits",
    );
    const r = installSkills({
      hosts: ["claude"],
      claudeTarget: claude,
      sourceDir: REPO_SKILLS,
      force: true,
    });
    const ask = r.actions.find((a) => a.skill === "torana-ask");
    expect(ask?.action).toBe("copied");
    const after = readFileSync(join(claude, "torana-ask", "SKILL.md"), "utf-8");
    expect(after).not.toContain("user edits");
    expect(after).toContain("torana-ask");
  });

  test("identical file is skipped (no churn)", () => {
    const claude = tmpDir();
    installSkills({
      hosts: ["claude"],
      claudeTarget: claude,
      sourceDir: REPO_SKILLS,
    });
    const r = installSkills({
      hosts: ["claude"],
      claudeTarget: claude,
      sourceDir: REPO_SKILLS,
    });
    expect(r.actions.every((a) => a.action === "skipped-identical")).toBe(true);
  });

  test("dry-run writes nothing but reports 'would-copy'", () => {
    const claude = tmpDir();
    const r = installSkills({
      hosts: ["claude"],
      claudeTarget: claude,
      sourceDir: REPO_SKILLS,
      dryRun: true,
    });
    expect(r.actions.every((a) => a.action === "would-copy")).toBe(true);
    expect(existsSync(join(claude, "torana-ask", "SKILL.md"))).toBe(false);
  });
});

describe("target path resolution", () => {
  test("claudeSkillsDir honors $CLAUDE_CONFIG_DIR", () => {
    const p = claudeSkillsDir({ CLAUDE_CONFIG_DIR: "/tmp/cc" } as NodeJS.ProcessEnv);
    expect(p).toBe("/tmp/cc/skills");
  });

  test("claudeSkillsDir falls back to ~/.claude/skills", () => {
    const p = claudeSkillsDir({ HOME: "/home/a" } as NodeJS.ProcessEnv);
    expect(p).toBe("/home/a/.claude/skills");
  });

  test("codexSkillsDir honors $XDG_DATA_HOME", () => {
    const p = codexSkillsDir({ XDG_DATA_HOME: "/tmp/xdg" } as NodeJS.ProcessEnv);
    expect(p).toBe("/tmp/xdg/agents/skills");
  });

  test("codexSkillsDir falls back to ~/.agents/skills", () => {
    const p = codexSkillsDir({ HOME: "/home/a" } as NodeJS.ProcessEnv);
    expect(p).toBe("/home/a/.agents/skills");
  });
});

describe("torana skills CLI", () => {
  test("install --host=claude copies into the tmp target", async () => {
    const claude = tmpDir();
    const r = await runSkills([
      "install",
      "--host=claude",
      "--claude-target",
      claude,
      "--source-dir",
      REPO_SKILLS,
    ]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(claude, "torana-ask", "SKILL.md"))).toBe(true);
    expect(existsSync(join(claude, "torana-inject", "SKILL.md"))).toBe(true);
    expect(r.stdout.join("\n")).toMatch(/2 copied/);
  });

  test("install without --host exits 2", async () => {
    const r = await runSkills(["install"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.join("\n")).toContain("--host is required");
  });

  test("install with unknown host exits 2", async () => {
    const r = await runSkills(["install", "--host=notreal"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.join("\n")).toContain("notreal");
  });

  test("install --host=claude,codex installs into both", async () => {
    const claude = tmpDir();
    const codex = tmpDir();
    const r = await runSkills([
      "install",
      "--host=claude,codex",
      "--claude-target",
      claude,
      "--codex-target",
      codex,
      "--source-dir",
      REPO_SKILLS,
    ]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(claude, "torana-ask", "SKILL.md"))).toBe(true);
    expect(existsSync(join(codex, "torana-ask", "SKILL.md"))).toBe(true);
  });

  test("re-install with an edited target → exit 1 + file preserved", async () => {
    const claude = tmpDir();
    await runSkills([
      "install",
      "--host=claude",
      "--claude-target",
      claude,
      "--source-dir",
      REPO_SKILLS,
    ]);
    writeFileSync(join(claude, "torana-ask", "SKILL.md"), "user-edits");
    const r = await runSkills([
      "install",
      "--host=claude",
      "--claude-target",
      claude,
      "--source-dir",
      REPO_SKILLS,
    ]);
    expect(r.exitCode).toBe(1);
    expect(readFileSync(join(claude, "torana-ask", "SKILL.md"), "utf-8")).toBe("user-edits");
  });

  test("unknown subcommand prints help + exits 2", async () => {
    const r = await runSkills(["bogus"]);
    expect(r.exitCode).toBe(2);
  });

  test("help short-circuits without requiring --host", async () => {
    const r = await runSkills(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.join("\n")).toContain("Install skill packages");
  });
});
