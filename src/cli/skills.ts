// `torana skills install` — thin wrapper around scripts/install-skills.ts
// so users don't have to know the script path. Calls the same in-process
// function; keeps test coverage and behavior consistent.

import {
  CliUsageError,
  parseFlags,
  type FlagSpec,
} from "./shared/args.js";
import { ExitCode } from "./shared/exit.js";
import { renderText, type Rendered } from "./shared/output.js";
import {
  installSkills,
  summarize,
  type InstallOptions,
} from "../../scripts/install-skills.js";

const SKILLS_HELP = `Usage: torana skills <subcommand>

Install the torana-ask / torana-inject skill packages into Claude Code or
Codex skill directories.

Subcommands:
  install --host=<claude|codex>[,host...]   Install skill packages
  help                                      Show this help

Options (install):
  --host=<h>         One or both of 'claude', 'codex' (repeatable, csv)
  --force            Overwrite existing SKILL.md files that differ
  --dry-run          Print what would be copied without writing
  --claude-target P  Override Claude install dir (tests)
  --codex-target P   Override Codex install dir  (tests)
  --source-dir P     Override source skills dir  (tests)

Paths:
  claude → $CLAUDE_CONFIG_DIR/skills   (else ~/.claude/skills)
  codex  → $XDG_DATA_HOME/agents/skills (else ~/.agents/skills)

Exit codes:
  0  success
  1  one or more targets differ; pass --force to overwrite
  2  bad usage
`;

const INSTALL_FLAGS: Record<string, FlagSpec> = {
  host: { kind: "values", describe: "Install target host (claude, codex)" },
  force: { kind: "bool", describe: "Overwrite existing SKILL.md if different" },
  "dry-run": { kind: "bool", describe: "Print actions without writing" },
  "claude-target": { kind: "value", describe: "Override Claude install dir" },
  "codex-target": { kind: "value", describe: "Override Codex install dir" },
  "source-dir": { kind: "value", describe: "Override source skills dir" },
  help: { kind: "bool", short: "h", describe: "Show help" },
};

export interface RunSkillsOptions {
  env?: NodeJS.ProcessEnv;
}

export async function runSkills(
  argv: string[],
  _opts: RunSkillsOptions = {},
): Promise<Rendered> {
  const sub = argv[0];
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    return renderText(SKILLS_HELP.split("\n").slice(0, -1), ExitCode.success);
  }
  if (sub !== "install") {
    return renderText(
      [SKILLS_HELP],
      ExitCode.badUsage,
      [`skills: unknown subcommand '${sub}'`],
    );
  }
  const rest = argv.slice(1);
  try {
    const { flags } = parseFlags(rest, INSTALL_FLAGS);
    if (flags.help === true) {
      return renderText(SKILLS_HELP.split("\n").slice(0, -1), ExitCode.success);
    }
    const hostsRaw = flags.host;
    const hostsList =
      typeof hostsRaw === "string"
        ? [hostsRaw]
        : Array.isArray(hostsRaw)
          ? hostsRaw
          : [];
    if (hostsList.length === 0) {
      throw new CliUsageError(
        "skills install: --host is required (claude, codex, or both)",
      );
    }
    const hosts: Array<"claude" | "codex"> = [];
    const seen = new Set<string>();
    for (const raw of hostsList) {
      for (const h of raw.split(",").map((s) => s.trim()).filter((s) => s)) {
        if (h !== "claude" && h !== "codex") {
          throw new CliUsageError(
            `skills install: unknown host '${h}' (expected 'claude' or 'codex')`,
          );
        }
        if (!seen.has(h)) {
          hosts.push(h as "claude" | "codex");
          seen.add(h);
        }
      }
    }

    const opts: InstallOptions = {
      hosts,
      force: flags.force === true,
      dryRun: flags["dry-run"] === true,
      sourceDir:
        typeof flags["source-dir"] === "string" ? (flags["source-dir"] as string) : undefined,
      claudeTarget:
        typeof flags["claude-target"] === "string"
          ? (flags["claude-target"] as string)
          : undefined,
      codexTarget:
        typeof flags["codex-target"] === "string"
          ? (flags["codex-target"] as string)
          : undefined,
    };
    const result = installSkills(opts);
    const { lines, hasRefused } = summarize(result);
    return renderText(lines, hasRefused ? ExitCode.internal : ExitCode.success);
  } catch (err) {
    if (err instanceof CliUsageError) {
      return renderText([], ExitCode.badUsage, [`usage: ${err.message}`]);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return renderText([], ExitCode.internal, [`skills install: ${msg}`]);
  }
}

export { SKILLS_HELP };
