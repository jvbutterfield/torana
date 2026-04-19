#!/usr/bin/env bun
// torana CLI dispatch. Subcommands: start, doctor, validate, migrate, version.

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { loadConfigFromFile, ConfigLoadError } from "./config/load.js";
import { logger, setLogFormat, setLogLevel, setSecrets } from "./log.js";
import { applyMigrations, planMigration } from "./db/migrate.js";
import { startGateway } from "./main.js";
import { runDoctor } from "./doctor.js";
import pkg from "../package.json" with { type: "json" };

const log = logger("cli");

interface ParsedArgs {
  subcommand: string;
  configPath: string | null;
  autoMigrate: boolean;
  dryRun: boolean;
  format: "text" | "json";
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const first = argv[0] ?? "";
  const isHelpFlag = first === "--help" || first === "-h";
  const args: ParsedArgs = {
    subcommand: isHelpFlag ? "" : first,
    configPath: null,
    autoMigrate: false,
    dryRun: false,
    format: "text",
    help: isHelpFlag,
  };

  for (let i = isHelpFlag ? 0 : 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--config" || a === "-c") {
      args.configPath = argv[++i] ?? null;
    } else if (a === "--auto-migrate") {
      args.autoMigrate = true;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--format") {
      const next = argv[++i];
      if (next !== "text" && next !== "json") {
        throw new Error(`--format must be 'text' or 'json' (got '${next}')`);
      }
      args.format = next;
    } else if (a.startsWith("--config=")) {
      args.configPath = a.slice("--config=".length);
    } else if (a.startsWith("--format=")) {
      const val = a.slice("--format=".length);
      if (val !== "text" && val !== "json") {
        throw new Error(`--format must be 'text' or 'json' (got '${val}')`);
      }
      args.format = val;
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    }
  }

  return args;
}

function resolveConfigPath(explicit: string | null): string {
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  const envPath = process.env.TORANA_CONFIG;
  if (envPath) return isAbsolute(envPath) ? envPath : resolve(process.cwd(), envPath);
  for (const candidate of ["torana.yaml", "torana.config.yaml"]) {
    const p = resolve(process.cwd(), candidate);
    if (existsSync(p)) return p;
  }
  throw new Error(
    "no config specified; pass --config <path>, set TORANA_CONFIG, or put torana.yaml in cwd",
  );
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (!args.subcommand || args.help) {
    printHelp();
    return;
  }

  switch (args.subcommand) {
    case "version":
      console.log(`torana ${pkg.version} (bun ${Bun.version})`);
      return;
    case "validate": {
      const path = resolveConfigPath(args.configPath);
      const { config, secrets } = loadConfigFromFile(path);
      setSecrets(secrets);
      const redacted = redactForPrint(config);
      console.log(JSON.stringify(redacted, null, 2));
      log.info("config valid", { bots: config.bots.map((b) => b.id) });
      return;
    }
    case "doctor": {
      const path = resolveConfigPath(args.configPath);
      const { config, secrets } = loadConfigFromFile(path);
      setSecrets(secrets);
      const result = await runDoctor({ config, configPath: path });
      if (args.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const check of result.checks) {
          const badge = check.status === "ok" ? "[ ok ]" : check.status === "skip" ? "[skip]" : "[fail]";
          console.log(`${badge} ${check.id}: ${check.detail}`);
        }
      }
      process.exit(result.checks.some((c) => c.status === "fail") ? 1 : 0);
    }
    case "migrate": {
      const path = resolveConfigPath(args.configPath);
      const { config, secrets } = loadConfigFromFile(path);
      setSecrets(secrets);
      if (args.dryRun) {
        const plan = planMigration(config.gateway.db_path!);
        console.log(JSON.stringify(plan, null, 2));
        return;
      }
      applyMigrations(config.gateway.db_path!, { snapshotV0Upgrade: true });
      log.info("migration complete");
      return;
    }
    case "start": {
      const path = resolveConfigPath(args.configPath);
      const { config, secrets, agentApiTokens, warnings } = loadConfigFromFile(path);
      setSecrets(secrets);
      setLogLevel(config.gateway.log_level);
      setLogFormat(config.gateway.log_format ?? (process.stdout.isTTY ? "text" : "json"));
      for (const w of warnings) log.warn(w);

      const running = await startGateway({
        config,
        secrets,
        autoMigrate: args.autoMigrate,
        agentApiTokens,
      });

      const onSignal = async (signal: string): Promise<void> => {
        await running.shutdown(signal);
        process.exit(0);
      };
      process.on("SIGTERM", () => void onSignal("SIGTERM"));
      process.on("SIGINT", () => void onSignal("SIGINT"));
      return;
    }
    default:
      throw new Error(`unknown subcommand '${args.subcommand}'`);
  }
}

function printHelp(): void {
  console.log(`torana ${pkg.version} — open-source Telegram gateway for agent runtimes

Usage: torana <command> [options]

Commands:
  start        Run the gateway
  doctor       Validate config and check Telegram reachability
  validate     Offline config check (no Telegram, no DB)
  migrate      Apply pending DB migrations (--dry-run to preview)
  version      Print package + runtime version

Options:
  --config, -c <path>   Path to torana.yaml (defaults to $TORANA_CONFIG or ./torana.yaml)
  --auto-migrate        (start) Apply DB migrations automatically if stale
  --dry-run             (migrate) Print planned SQL without applying
  --format <text|json>  (doctor) Output format (default: text)

Docs: https://github.com/jvbutterfield/torana
`);
}

function redactForPrint(config: unknown): unknown {
  if (config === null || typeof config !== "object") return config;
  if (Array.isArray(config)) return config.map(redactForPrint);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    if (k === "token" || k === "secret") {
      out[k] = typeof v === "string" && v.length > 0 ? `<redacted:${v.length} chars>` : v;
    } else {
      out[k] = redactForPrint(v);
    }
  }
  return out;
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof ConfigLoadError) {
    console.error(`config error: ${err.message}`);
    if (err.path) console.error(`  from: ${err.path}`);
    process.exit(2);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

// Expose for tests.
export { parseArgs };
