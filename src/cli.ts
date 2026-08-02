#!/usr/bin/env bun
// torana CLI dispatch. Two surface areas:
//
//   Gateway (server-side): start, doctor, validate, migrate, version.
//     Uses the legacy parseArgs() below; flags are global to the subcommand.
//
//   Agent-API client (added in Phase 6 / US-018): ask, send, turns get,
//     bots list. Each delegates to a module in `src/cli/` that returns a
//     `Rendered` for testability. The dispatcher in `main()` peeks at argv[0]
//     to choose between the two surfaces; the legacy parseArgs is preserved
//     unmodified so existing test imports keep working.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { loadConfigFromFile, ConfigLoadError } from "./config/load.js";
import { logger, setLogFormat, setLogLevel, setSecrets } from "./log.js";
import { applyMigrations, planMigration } from "./db/migrate.js";
import { GatewayDB } from "./db/gateway-db.js";
import { startGateway } from "./main.js";
import { runDoctor, runRemoteDoctor, type DoctorCheck } from "./doctor.js";
import {
  AgentApiClient,
  type AgentApiClientOptions,
} from "./agent-api/client.js";
import {
  CliUsageError,
  extractChain,
  resolveCredentials,
  type ResolvedCredentials,
} from "./cli/shared/args.js";
import { ExitCode } from "./cli/shared/exit.js";
import { emit, type Rendered } from "./cli/shared/output.js";
import { runAsk } from "./cli/ask.js";
import { runSend } from "./cli/send.js";
import { runTurns } from "./cli/turns.js";
import { runBots } from "./cli/bots.js";
import { runConfig } from "./cli/config.js";
import { runSkills } from "./cli/skills.js";
import { runBuzz } from "./cli/buzz.js";
import {
  defaultProfilesPath,
  loadProfiles,
  ProfileStoreError,
  type ProfileState,
} from "./cli/shared/profile.js";
import pkg from "../package.json" with { type: "json" };

const log = logger("cli");

const AGENT_API_SUBCOMMANDS = new Set([
  "ask",
  "send",
  "turns",
  "bots",
  "config",
  "skills",
  "buzz",
]);

interface ParsedArgs {
  subcommand: string;
  configPath: string | null;
  autoMigrate: boolean;
  dryRun: boolean;
  format: "text" | "json";
  help: boolean;
  server: string | null;
  token: string | null;
  profile: string | null;
  migrationTo: number | null;
  confirmShared: boolean;
  deadLetterPending: boolean;
  limit: number;
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
    server: null,
    token: null,
    profile: null,
    migrationTo: null,
    confirmShared: false,
    deadLetterPending: false,
    limit: 100,
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
    } else if (a === "--confirm-shared") {
      args.confirmShared = true;
    } else if (a === "--dead-letter-pending") {
      args.deadLetterPending = true;
    } else if (a === "--limit") {
      const next = argv[++i];
      if (!next) throw new Error("--limit requires a number");
      args.limit = Number(next);
    } else if (a === "--to") {
      const next = argv[++i];
      if (!next) throw new Error("--to requires a schema version");
      args.migrationTo = Number(next);
    } else if (a === "--format") {
      const next = argv[++i];
      if (next !== "text" && next !== "json") {
        throw new Error(`--format must be 'text' or 'json' (got '${next}')`);
      }
      args.format = next;
    } else if (a === "--server") {
      args.server = argv[++i] ?? null;
    } else if (a === "--token") {
      args.token = argv[++i] ?? null;
    } else if (a === "--profile") {
      args.profile = argv[++i] ?? null;
    } else if (a.startsWith("--config=")) {
      args.configPath = a.slice("--config=".length);
    } else if (a.startsWith("--format=")) {
      const val = a.slice("--format=".length);
      if (val !== "text" && val !== "json") {
        throw new Error(`--format must be 'text' or 'json' (got '${val}')`);
      }
      args.format = val;
    } else if (a.startsWith("--server=")) {
      args.server = a.slice("--server=".length);
    } else if (a.startsWith("--token=")) {
      args.token = a.slice("--token=".length);
    } else if (a.startsWith("--profile=")) {
      args.profile = a.slice("--profile=".length);
    } else if (a.startsWith("--to=")) {
      args.migrationTo = Number(a.slice("--to=".length));
    } else if (a.startsWith("--limit=")) {
      args.limit = Number(a.slice("--limit=".length));
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    }
  }

  if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 500) {
    throw new Error("--limit must be an integer between 1 and 500");
  }

  return args;
}

function resolveConfigPath(explicit: string | null): string {
  if (explicit)
    return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  const envPath = process.env.TORANA_CONFIG;
  if (envPath)
    return isAbsolute(envPath) ? envPath : resolve(process.cwd(), envPath);
  for (const candidate of ["torana.yaml", "torana.config.yaml"]) {
    const p = resolve(process.cwd(), candidate);
    if (existsSync(p)) return p;
  }
  throw new Error(
    "no config specified; pass --config <path>, set TORANA_CONFIG, or put torana.yaml in cwd",
  );
}

async function main(argv: string[]): Promise<void> {
  // Agent-API surface routes through its own modules; flags differ from
  // the legacy parseArgs spec, so we dispatch BEFORE parseArgs gets a
  // chance to reject unknown flags like `--source` or `--session-id`.
  const first = argv[0];
  if (first && AGENT_API_SUBCOMMANDS.has(first)) {
    const exit = await dispatchAgentApi(argv);
    process.exit(exit);
  }

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
      // Three modes:
      //   1. `--profile NAME`    → resolve (server,token) from profile store,
      //                             then R001..R003 remote probes.
      //   2. `--server URL --token TOK` (or TORANA_* env) → remote probes.
      //   3. no flags             → local config-based doctor
      //                             (C001..C014, reads torana.yaml).
      // Precedence when combining flags is the standard flag > env > profile.
      let profiles: ProfileState | undefined;
      if (args.profile || process.env.TORANA_DEBUG === "1") {
        try {
          const p = defaultProfilesPath(process.env);
          const loaded = loadProfiles(p);
          profiles = loaded.state;
          for (const w of loaded.warnings) console.error(`warning: ${w}`);
        } catch (err) {
          if (err instanceof ProfileStoreError && args.profile) {
            console.error(`doctor: ${err.message}`);
            process.exit(2);
          }
          // If `--profile` wasn't requested, a missing/broken store is not
          // fatal — the user may just want the flag/env path.
        }
      }

      let remote = args.server ?? process.env.TORANA_SERVER ?? null;
      let remoteToken = args.token ?? process.env.TORANA_TOKEN ?? null;
      if (args.profile) {
        if (!profiles) {
          console.error(
            `doctor: --profile requested but no profile store available`,
          );
          process.exit(2);
        }
        const p = profiles.profiles[args.profile];
        if (!p) {
          const known =
            Object.keys(profiles.profiles).sort().join(", ") || "(none)";
          console.error(
            `doctor: profile '${args.profile}' not found (known: ${known})`,
          );
          process.exit(2);
        }
        // Flag/env still win per precedence, but fill any gap from profile.
        remote = remote ?? p.server;
        remoteToken = remoteToken ?? p.token;
      }

      let result: { checks: DoctorCheck[] };
      if (remote) {
        if (!remoteToken) {
          console.error(
            "doctor: --server supplied without --token (or TORANA_TOKEN)",
          );
          process.exit(2);
        }
        result = await runRemoteDoctor({ server: remote, token: remoteToken });
      } else {
        const path = resolveConfigPath(args.configPath);
        const { config, normalized, secrets } = loadConfigFromFile(path);
        setSecrets(secrets);
        result = await runDoctor({
          config,
          configPath: path,
          sourceConfigVersion: normalized.sourceVersion,
          normalized,
        });
      }
      if (args.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const check of result.checks) {
          const badge =
            check.status === "ok"
              ? "[ ok ]"
              : check.status === "skip"
                ? "[skip]"
                : check.status === "warn"
                  ? "[warn]"
                  : "[fail]";
          console.log(`${badge} ${check.id}: ${check.detail}`);
        }
      }
      process.exit(result.checks.some((c) => c.status === "fail") ? 1 : 0);
      return;
    }
    case "sessions": {
      const action = argv[1];
      const sessionKey = argv[2];
      if (
        action !== "list" &&
        (action !== "reset" || !sessionKey || sessionKey.startsWith("-"))
      ) {
        throw new Error(
          "usage: torana sessions <list|reset <session-key>> [--limit N] [--confirm-shared] [--format text|json] [--config <path>]",
        );
      }
      const path = resolveConfigPath(args.configPath);
      const { config, secrets } = loadConfigFromFile(path);
      setSecrets(secrets);
      const db = new GatewayDB(config.gateway.db_path!);
      try {
        if (action === "list") {
          const rows = db.listOperationalSessions(args.limit);
          if (args.format === "json")
            console.log(JSON.stringify(rows, null, 2));
          else {
            for (const row of rows) {
              console.log(
                `${row.sessionKey}\tagent=${row.agentId}\tstate=${row.state}\tgeneration=${row.generation}\tbindings=${row.bindings}\tqueued=${row.queued}${row.lastError ? `\terror=${row.lastError}` : ""}`,
              );
            }
          }
          return;
        }
        const session = db.getConversationSession(sessionKey);
        if (!session) throw new Error(`session '${sessionKey}' not found`);
        const bindings = db.conversationSessionBindingCount(sessionKey);
        if (bindings > 1 && !args.confirmShared) {
          throw new Error(
            `session '${sessionKey}' is shared by ${bindings} conversations; rerun with --confirm-shared`,
          );
        }
        db.resetConversationSession(sessionKey);
        console.log(
          `reset session '${sessionKey}' (${bindings} conversation binding${bindings === 1 ? "" : "s"}); the next turn starts fresh`,
        );
      } finally {
        db.close();
      }
      return;
    }
    case "conversations": {
      if (argv[1] !== "list") {
        throw new Error(
          "usage: torana conversations list [--limit N] [--format text|json] [--config <path>]",
        );
      }
      const path = resolveConfigPath(args.configPath);
      const { config, secrets } = loadConfigFromFile(path);
      setSecrets(secrets);
      const db = new GatewayDB(config.gateway.db_path!);
      try {
        const rows = db.listOperationalConversations(args.limit);
        if (args.format === "json") console.log(JSON.stringify(rows, null, 2));
        else {
          for (const row of rows) {
            console.log(
              `${row.id}\t${row.platform}\t${row.endpointId}\t${row.externalConversationId}\ttype=${row.type}\tsession=${row.sessionKey ?? "ephemeral"}\tstate=${row.sessionState ?? "none"}\tqueued=${row.queued}\trunning=${row.running}`,
            );
          }
        }
      } finally {
        db.close();
      }
      return;
    }
    case "outbox": {
      const action = argv[1];
      const id = Number(argv[2]);
      if (
        action !== "list" &&
        (!Number.isSafeInteger(id) ||
          id < 1 ||
          !["replay", "dead-letter"].includes(action ?? ""))
      ) {
        throw new Error(
          "usage: torana outbox <list|replay <id>|dead-letter <id>> [--limit N] [--format text|json] [--config <path>]",
        );
      }
      const path = resolveConfigPath(args.configPath);
      const { config, secrets } = loadConfigFromFile(path);
      setSecrets(secrets);
      const db = new GatewayDB(config.gateway.db_path!);
      try {
        if (action === "list") {
          const rows = db.listOperationalOutbox(args.limit);
          if (args.format === "json")
            console.log(JSON.stringify(rows, null, 2));
          else {
            for (const row of rows) {
              console.log(
                `${row.id}\t${row.platform}\t${row.endpointId}\t${row.operation}\t${row.status}\tattempts=${row.attempts}${row.lastError ? `\terror=${row.lastError}` : ""}`,
              );
            }
          }
          return;
        }
        if (action === "replay") {
          if (!db.replayOutbox(id)) {
            throw new Error(`outbox row ${id} is not dead or failed`);
          }
          console.log(`outbox row ${id} queued for exact-payload replay`);
          return;
        }
        if (!db.deadLetterOutbox(id, "operator dead-lettered outbox row")) {
          throw new Error(`outbox row ${id} cannot be dead-lettered`);
        }
        console.log(`outbox row ${id} dead-lettered`);
      } finally {
        db.close();
      }
      return;
    }
    case "gateway": {
      if (argv[1] !== "drain") {
        throw new Error("usage: torana gateway drain [--config <path>]");
      }
      const path = resolveConfigPath(args.configPath);
      const { config, secrets } = loadConfigFromFile(path);
      setSecrets(secrets);
      const lockPath = resolve(config.gateway.data_dir, ".torana.lock");
      let pid: number;
      try {
        const record = JSON.parse(readFileSync(lockPath, "utf8")) as {
          pid?: unknown;
        };
        if (!Number.isSafeInteger(record.pid) || Number(record.pid) < 1) {
          throw new Error("invalid PID");
        }
        pid = Number(record.pid);
      } catch {
        throw new Error(`running gateway lock was not found at ${lockPath}`);
      }
      process.kill(pid, "SIGTERM");
      console.log(
        `gateway PID ${pid} received SIGTERM; intake is stopping and accepted work will drain`,
      );
      return;
    }
    case "endpoints": {
      const action = argv[1];
      const endpointId = argv[2] && !argv[2]!.startsWith("-") ? argv[2]! : null;
      if (
        !action ||
        !["status", "drain", "disable", "resume"].includes(action) ||
        (action !== "status" && !endpointId)
      ) {
        throw new Error(
          "usage: torana endpoints <status [id]|drain id|disable id|resume id> [--dead-letter-pending] [--config <path>]",
        );
      }
      const path = resolveConfigPath(args.configPath);
      const { config, normalized, secrets } = loadConfigFromFile(path);
      setSecrets(secrets);
      const db = new GatewayDB(config.gateway.db_path!);
      try {
        if (action === "status") {
          const rows = db
            .listExternalEndpoints()
            .filter((row) => !endpointId || row.endpointId === endpointId)
            .map((row) => ({
              ...row,
              backlog: db.endpointBacklog(row.endpointId),
            }));
          if (endpointId && rows.length === 0) {
            throw new Error(`endpoint '${endpointId}' not found`);
          }
          if (args.format === "json")
            console.log(JSON.stringify(rows, null, 2));
          else {
            for (const row of rows) {
              const backlog = row.backlog;
              console.log(
                `${row.endpointId}\t${row.platform}\t${row.lifecycleState}\tqueued=${backlog.queued} running=${backlog.running} outbox=${backlog.outbox}${row.stateReason ? `\treason=${row.stateReason}` : ""}`,
              );
            }
          }
          return;
        }

        const current = db.getEndpointState(endpointId!);
        if (!current) throw new Error(`endpoint '${endpointId}' not found`);
        if (current.platform !== "buzz") {
          throw new Error(
            "Phase 4 lifecycle commands apply only to Buzz endpoints",
          );
        }
        if (action === "drain") {
          if (current.lifecycleState !== "active") {
            throw new Error(
              `endpoint '${endpointId}' must be active before draining (current: ${current.lifecycleState})`,
            );
          }
          db.setEndpointLifecycle(endpointId!, "draining", "operator_drain");
          console.log(
            `endpoint '${endpointId}' is draining; intake has stopped`,
          );
          return;
        }
        if (action === "resume") {
          const configured = normalized.endpoints.find(
            (endpoint) => endpoint.id === endpointId,
          );
          if (!configured?.enabled) {
            throw new Error(
              `endpoint '${endpointId}' is disabled by configuration; enable the Buzz platform and endpoint first`,
            );
          }
          db.setEndpointLifecycle(endpointId!, "active", null);
          console.log(`endpoint '${endpointId}' resumed`);
          return;
        }

        if (current.lifecycleState !== "draining") {
          throw new Error(
            `endpoint '${endpointId}' must be draining before it can be disabled`,
          );
        }
        const backlog = db.endpointBacklog(endpointId!);
        if (backlog.running > 0) {
          throw new Error(
            `endpoint '${endpointId}' still has ${backlog.running} running turn(s); wait for them to finish before disabling`,
          );
        }
        if (
          (backlog.queued > 0 || backlog.outbox > 0) &&
          !args.deadLetterPending
        ) {
          throw new Error(
            `endpoint '${endpointId}' still has queued=${backlog.queued}, outbox=${backlog.outbox}; wait or rerun with --dead-letter-pending`,
          );
        }
        if (args.deadLetterPending) {
          db.deadLetterEndpointPending(
            endpointId!,
            "operator disabled endpoint with --dead-letter-pending",
          );
        }
        db.setEndpointLifecycle(endpointId!, "disabled", "operator_disabled");
        console.log(
          `endpoint '${endpointId}' disabled${args.deadLetterPending ? "; pending work dead-lettered" : ""}`,
        );
      } finally {
        db.close();
      }
      return;
    }
    case "migrate": {
      if (args.migrationTo !== null && args.migrationTo !== 5) {
        throw new Error("migrate currently supports only --to 5");
      }
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
      const { config, normalized, secrets, agentApiTokens, warnings } =
        loadConfigFromFile(path);
      setSecrets(secrets);
      setLogLevel(config.gateway.log_level);
      setLogFormat(
        config.gateway.log_format ?? (process.stdout.isTTY ? "text" : "json"),
      );
      for (const w of warnings) log.warn(w);

      const running = await startGateway({
        config,
        normalized,
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

Gateway commands:
  start        Run the gateway
  doctor       Validate config and check Telegram reachability
  validate     Offline config check (no Telegram, no DB)
  migrate      Apply pending DB migrations (--dry-run to preview)
  sessions reset <key>  Clear a conversation session (shared sessions require --confirm-shared)
  sessions list          Inspect durable conversation sessions
  conversations list     Inspect platform conversations and queue state
  outbox list            Inspect delivery state without exposing payloads
  outbox replay <id>     Replay the exact stored dead/failed payload
  outbox dead-letter <id>  Stop delivery attempts for one row
  gateway drain          Trigger the running gateway's graceful shutdown
  endpoints status [id]  Show persisted endpoint lifecycle and backlog
  endpoints drain <id>   Stop Buzz intake while accepted work drains
  endpoints disable <id> Disable a drained Buzz endpoint
  endpoints resume <id>  Resume a configured Buzz endpoint
  version      Print package + runtime version

Agent-API client commands (require --server + --token, env equivalents, or a profile):
  ask <bot> <text>           Synchronous request/response against a bot
  send <bot> <text>          Push a system message into a chat
  turns get <id>             Fetch the current state of a turn
  bots list                  List bots permitted by the configured token
  config <sub>               Manage the CLI profile store (~/.config/torana/config.toml)
  skills install --host=H    Install skill packages into Claude Code / Codex
  buzz call                   Execute one typed, endpoint-scoped Buzz broker request

Gateway options:
  --config, -c <path>   Path to torana.yaml (defaults to $TORANA_CONFIG or ./torana.yaml)
  --auto-migrate        (start) Apply DB migrations automatically if stale
  --dry-run             (migrate) Print planned steps without applying
  --to 5                (migrate) Explicit schema-v5 bridge activation
  --format <text|json>  (doctor) Output format (default: text)
  --server <url>        (doctor) Run remote R001..R003 probes against <url>
  --token <tok>         (doctor) Bearer token for remote probe
  --profile <name>      (doctor) Resolve --server + --token from the profile store

Run \`torana <client-cmd> --help\` for per-subcommand options + exit codes.

Docs: https://github.com/jvbutterfield/torana
`);
}

// --- Agent-API dispatcher ---------------------------------------------------

async function dispatchAgentApi(argv: string[]): Promise<number> {
  try {
    const { chain, rest } = extractChain(argv);
    const cmd = chain[0]!;

    // `ask` and `send` take a single chain element; `turns` and `bots`
    // require an action token (`get`, `list`). `config`, `skills`, and `buzz` are
    // local-only — they don't contact the API and shouldn't demand creds.
    switch (cmd) {
      case "config": {
        // `torana config <sub>` — pass the full chain-minus-"config" plus rest.
        const inner = chain.slice(1).concat(rest);
        const r = runConfig(inner);
        return emit(r);
      }

      case "skills": {
        const inner = chain.slice(1).concat(rest);
        const r = await runSkills(inner);
        return emit(r);
      }

      case "buzz": {
        const inner = chain.slice(1).concat(rest);
        const r = await runBuzz(inner);
        return emit(r);
      }

      case "ask":
        return await runWithClient(chain, rest, async (client) =>
          runAsk({ argv: chain.slice(1).concat(rest) }, { client }),
        );

      case "send":
        return await runWithClient(chain, rest, async (client) =>
          runSend({ argv: chain.slice(1).concat(rest) }, { client }),
        );

      case "turns": {
        const action = chain[1];
        if (!action) {
          throw new CliUsageError(
            "turns requires a subcommand (currently: get)",
          );
        }
        return await runWithClient(chain, rest, async (client) =>
          runTurns({ argv: rest, action }, { client }),
        );
      }

      case "bots": {
        const action = chain[1];
        if (!action) {
          throw new CliUsageError(
            "bots requires a subcommand (currently: list)",
          );
        }
        return await runWithClient(chain, rest, async (client) =>
          runBots({ argv: rest, action }, { client }),
        );
      }

      default:
        throw new CliUsageError(`unknown agent-api subcommand '${cmd}'`);
    }
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`usage: ${err.message}\n`);
      return ExitCode.badUsage;
    }
    process.stderr.write(
      `error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return ExitCode.internal;
  }
}

/**
 * Resolve credentials from rest-args, instantiate the client, run the
 * subcommand body, then emit the rendered output. `chain` is forwarded
 * to allow `--help` short-circuit detection BEFORE we demand credentials.
 */
async function runWithClient(
  chain: string[],
  rest: string[],
  body: (client: AgentApiClient) => Promise<Rendered>,
): Promise<number> {
  // `--help` should never demand credentials. Inspect `rest` for it.
  if (rest.includes("--help") || rest.includes("-h")) {
    const r = await body(stubClient());
    return emit(r);
  }

  const flagServer = takeOptionValue(rest, "--server");
  const flagToken = takeOptionValue(rest, "--token");
  const flagProfile = takeOptionValue(rest, "--profile");

  // Load profile store if the user referenced --profile or if one exists
  // on disk (for default-profile fallback). Missing-file is not an error;
  // parse errors *are* fatal per §8.1 error model.
  let profiles: ProfileState | undefined;
  try {
    const p = defaultProfilesPath(process.env);
    const loaded = loadProfiles(p);
    profiles = loaded.state;
    for (const w of loaded.warnings) process.stderr.write(`warning: ${w}\n`);
  } catch (err) {
    if (err instanceof ProfileStoreError) {
      // platform_unsupported or parse_error. Only fatal if the user asked
      // for `--profile` explicitly; otherwise fall through to flag/env.
      if (flagProfile !== undefined || err.code === "parse_error") {
        process.stderr.write(`error: ${err.message}\n`);
        return ExitCode.badUsage;
      }
    } else {
      throw err;
    }
  }

  let creds: ResolvedCredentials;
  try {
    creds = resolveCredentials({
      flagServer,
      flagToken,
      profileName: flagProfile,
      profiles,
    });
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`usage: ${err.message}\n`);
      return ExitCode.badUsage;
    }
    throw err;
  }

  const opts: AgentApiClientOptions = {
    server: creds.server,
    token: creds.token,
  };
  const client = new AgentApiClient(opts);

  if (process.env.TORANA_DEBUG === "1" || rest.includes("--verbose")) {
    process.stderr.write(`# credentials trace: ${creds.trace.join(", ")}\n`);
  }

  const r = await body(client);
  return emit(r);
}

/**
 * Look up `--name <value>` or `--name=value` in `argv`. We don't mutate
 * the list — the per-subcommand parser will see and consume the same
 * tokens. This is just a peek so `runWithClient` can resolve credentials
 * without coupling to each subcommand's flag spec.
 */
function takeOptionValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i]!;
    if (tok === name) {
      return argv[i + 1];
    }
    if (tok.startsWith(`${name}=`)) {
      return tok.slice(name.length + 1);
    }
  }
  return undefined;
}

/**
 * Stand-in client used solely so `--help` can run without credential checks.
 * Throws on any method call — `--help` short-circuits at flag-parse time.
 */
function stubClient(): AgentApiClient {
  const stub = (() => {
    throw new Error("stubClient.fetchImpl: --help should not call the API");
  }) as unknown as typeof fetch;
  return new AgentApiClient({
    server: "http://help.invalid",
    token: "help-only",
    fetchImpl: stub,
  });
}

function redactForPrint(config: unknown, parentKey?: string): unknown {
  if (config === null || config === undefined) return config;
  if (typeof config !== "object") return config;
  if (Array.isArray(config))
    return config.map((v) => redactForPrint(v, parentKey));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    // bots[].runner.secrets is a flat Record<string,string> whose every value
    // is — by definition — sensitive. Redact each leaf, not the map.
    if (parentKey === "secrets") {
      out[k] =
        typeof v === "string" && v.length > 0
          ? `<redacted:${v.length} chars>`
          : v;
      continue;
    }
    if (
      k === "token" ||
      k === "secret" ||
      k === "secret_ref" ||
      k === "private_key" ||
      k === "auth_tag"
    ) {
      out[k] =
        typeof v === "string" && v.length > 0
          ? `<redacted:${v.length} chars>`
          : v;
    } else {
      out[k] = redactForPrint(v, k);
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
