// Install torana skill packages into a host's skills directory.
//
//   bun scripts/install-skills.ts --host=claude       # → $CLAUDE_CONFIG_DIR/skills
//                                                       (else ~/.claude/skills)
//   bun scripts/install-skills.ts --host=codex        # → $XDG_DATA_HOME/agents/skills
//                                                       (else ~/.agents/skills)
//   bun scripts/install-skills.ts --host=claude,codex # both
//
// Options:
//   --force    Overwrite existing SKILL.md files (default: refuse if any
//              target file differs from the source).
//   --dry-run  Print what would be copied without writing.
//
// Exit codes: 0 success, 2 bad usage, 1 I/O error.
//
// Called both directly (`bun scripts/install-skills.ts`) and via the CLI
// dispatcher (`torana skills install`, see src/cli/skills.ts).

import { chmodSync, existsSync, mkdirSync, statSync, copyFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

export interface InstallOptions {
  hosts: Array<"claude" | "codex">;
  force?: boolean;
  dryRun?: boolean;
  /** Override source directory (defaults to the repo's `skills/`). */
  sourceDir?: string;
  /** Overrides for install targets (tests supply tmpdirs here). */
  claudeTarget?: string;
  codexTarget?: string;
  /** Environment snapshot (tests). */
  env?: NodeJS.ProcessEnv;
}

export interface InstallResult {
  /** List of (source, target, action) tuples for logging / tests. */
  actions: Array<{
    source: string;
    target: string;
    host: "claude" | "codex";
    skill: string;
    action: "copied" | "skipped-identical" | "refused-different" | "would-copy";
  }>;
}

const SKILLS = ["torana-ask", "torana-send"] as const;

const HELP = `Usage: bun scripts/install-skills.ts --host=<claude|codex>[,host...] [options]

Install torana skill packages into a host's skills directory.

Options:
  --host=<h>   One or both of 'claude', 'codex' (repeatable, comma-separated)
  --force      Overwrite existing SKILL.md files that differ
  --dry-run    Print what would be copied without writing
  -h, --help   Show this help
`;

export function claudeSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR;
  if (override && override.length > 0) return resolve(override, "skills");
  return resolve(env.HOME ?? homedir(), ".claude", "skills");
}

export function codexSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0) return resolve(xdg, "agents", "skills");
  return resolve(env.HOME ?? homedir(), ".agents", "skills");
}

export function repoSkillsDir(): string {
  // Resolve relative to this file. Using import.meta.url keeps it working
  // when the script is invoked from an arbitrary cwd (including inside
  // `torana skills install`).
  const here = new URL(import.meta.url).pathname;
  // scripts/install-skills.ts → repo root
  return resolve(here, "..", "..", "skills");
}

export function installSkills(opts: InstallOptions): InstallResult {
  const env = opts.env ?? process.env;
  const src = opts.sourceDir ?? repoSkillsDir();
  if (!existsSync(src)) {
    throw new Error(`source skills directory not found: ${src}`);
  }
  const actions: InstallResult["actions"] = [];
  for (const host of opts.hosts) {
    const targetDir =
      host === "claude"
        ? opts.claudeTarget ?? claudeSkillsDir(env)
        : opts.codexTarget ?? codexSkillsDir(env);

    for (const skill of SKILLS) {
      const sourceFile = join(src, skill, "SKILL.md");
      const targetFile = join(targetDir, skill, "SKILL.md");
      const srcBytes = readFileSync(sourceFile);

      if (opts.dryRun) {
        actions.push({ source: sourceFile, target: targetFile, host, skill, action: "would-copy" });
        continue;
      }

      if (existsSync(targetFile)) {
        const existing = readFileSync(targetFile);
        if (Buffer.compare(srcBytes, existing) === 0) {
          actions.push({ source: sourceFile, target: targetFile, host, skill, action: "skipped-identical" });
          continue;
        }
        if (!opts.force) {
          actions.push({ source: sourceFile, target: targetFile, host, skill, action: "refused-different" });
          continue;
        }
      }

      // Ensure target dir exists.
      const skillDir = join(targetDir, skill);
      if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true, mode: 0o755 });
      copyFileSync(sourceFile, targetFile);
      chmodSync(targetFile, 0o644);
      actions.push({ source: sourceFile, target: targetFile, host, skill, action: "copied" });
    }
  }
  return { actions };
}

export function summarize(result: InstallResult): { lines: string[]; hasRefused: boolean } {
  const lines: string[] = [];
  let copied = 0;
  let identical = 0;
  let refused = 0;
  let wouldCopy = 0;
  for (const a of result.actions) {
    if (a.action === "copied") {
      copied += 1;
      lines.push(`  [copy]   ${a.host}/${a.skill} → ${a.target}`);
    } else if (a.action === "skipped-identical") {
      identical += 1;
      lines.push(`  [skip]   ${a.host}/${a.skill} (identical)`);
    } else if (a.action === "refused-different") {
      refused += 1;
      lines.push(`  [REFUSE] ${a.host}/${a.skill} differs — pass --force to overwrite`);
    } else if (a.action === "would-copy") {
      wouldCopy += 1;
      lines.push(`  [dry]    ${a.host}/${a.skill} → ${a.target}`);
    }
  }
  lines.unshift(`skills install: ${copied} copied, ${identical} identical, ${refused} refused, ${wouldCopy} dry-run`);
  return { lines, hasRefused: refused > 0 };
}

// CLI entrypoint when invoked directly.
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const hosts: Array<"claude" | "codex"> = [];
  let force = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--force") force = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--host=")) {
      const v = a.slice("--host=".length);
      for (const h of v.split(",").map((s) => s.trim()).filter((s) => s)) {
        if (h !== "claude" && h !== "codex") {
          console.error(`install-skills: unknown host '${h}' (expected 'claude' or 'codex')`);
          process.exit(2);
        }
        hosts.push(h);
      }
    } else if (a === "--host") {
      const next = argv[i + 1];
      i += 1;
      if (!next) {
        console.error("install-skills: --host requires a value");
        process.exit(2);
      }
      for (const h of next.split(",").map((s) => s.trim()).filter((s) => s)) {
        if (h !== "claude" && h !== "codex") {
          console.error(`install-skills: unknown host '${h}'`);
          process.exit(2);
        }
        hosts.push(h);
      }
    } else if (a === "--help" || a === "-h") {
      console.log(HELP);
      process.exit(0);
    } else {
      console.error(`install-skills: unknown arg '${a}'`);
      process.exit(2);
    }
  }
  if (hosts.length === 0) {
    console.error("install-skills: --host is required (claude, codex, or both)");
    process.exit(2);
  }
  const result = installSkills({ hosts, force, dryRun });
  const { lines, hasRefused } = summarize(result);
  for (const l of lines) console.log(l);
  process.exit(hasRefused ? 1 : 0);
}
