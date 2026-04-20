// `torana config` — manage the CLI profile store.
//
//   torana config init                   Create an empty profile file (0600)
//   torana config add-profile <name>     Upsert (server, token); makes
//                                        profile the default if no default
//                                        exists (or with --default)
//   torana config list-profiles          Table of profiles, redacted tokens
//   torana config remove-profile <name>  Delete a profile
//   torana config show [<name>]          Print one or all profiles (token
//                                        redacted unless --reveal-token)
//
// All writes go through `saveProfiles` → atomic rename + chmod 0600.
// Reads surface non-fatal warnings (e.g. wider-than-0600 perms) on stderr.

import {
  COMMON_FLAGS,
  CliUsageError,
  parseFlags,
  type FlagSpec,
} from "./shared/args.js";
import { ExitCode } from "./shared/exit.js";
import { formatTable, renderJson, renderText, type Rendered } from "./shared/output.js";
import {
  defaultProfilesPath,
  getProfile,
  loadProfiles,
  ProfileStoreError,
  redactToken,
  removeProfile as removeProfileState,
  saveProfiles,
  upsertProfile,
  type Profile,
  type ProfileState,
} from "./shared/profile.js";

const CONFIG_HELP = `Usage: torana config <subcommand> [options]

Manage the torana CLI profile store (~/.config/torana/config.toml, mode 0600).

Subcommands:
  init                    Create an empty profile file if one doesn't exist
  add-profile <name>      Add or update a profile (--server URL --token T)
  list-profiles           Show stored profiles (tokens redacted)
  remove-profile <name>   Remove a profile
  show [<name>]           Print one profile (or all) with tokens redacted

Common options:
  --config-path PATH      Override the profile file location
  --json                  Emit JSON (list-profiles, show)
  -h, --help              Show this help
`;

const ADD_PROFILE_HELP = `Usage: torana config add-profile <name> --server URL --token TOKEN [--default]

Create or update a profile in the CLI profile store. On success the profile
file is written with mode 0600.

Options:
  --server URL       Torana server URL (required)
  --token  T         Bearer token (required)
  --default          Mark this profile as the default
  --config-path P    Override the profile file location

Exit codes:
  0  success
  2  bad usage
  1  internal / I/O error
`;

const LIST_PROFILES_HELP = `Usage: torana config list-profiles [--json]

Print a table of stored profiles. Tokens are redacted (first 4 chars + \`*\`).

Options:
  --json             Emit JSON instead of a human-readable table
  --config-path P    Override the profile file location
`;

const REMOVE_PROFILE_HELP = `Usage: torana config remove-profile <name>

Delete a profile. Succeeds quietly (exit 0) if the profile does not exist.
If the removed profile was the default, the alphabetically first remaining
profile becomes the new default.

Options:
  --config-path P    Override the profile file location
`;

const SHOW_HELP = `Usage: torana config show [<name>] [--json] [--reveal-token]

Print one profile (or all) from the store. Tokens are redacted unless
--reveal-token is passed. Omit <name> to dump every profile.

Options:
  --json             Emit JSON instead of a human-readable listing
  --reveal-token     Print the raw token (use with care)
  --config-path P    Override the profile file location
`;

const INIT_HELP = `Usage: torana config init

Create an empty profile file (mode 0600) at ~/.config/torana/config.toml
(honors XDG_CONFIG_HOME). If the file already exists, prints its path and
exits 0 without modification.

Options:
  --config-path P    Override the profile file location
`;

const CONFIG_FLAGS: Record<string, FlagSpec> = {
  ...COMMON_FLAGS,
  // `server` / `token` are consumed by add-profile, not the common
  // resolveCredentials path. We accept them here so the shared parser
  // doesn't reject them.
  default: { kind: "bool", describe: "Set this profile as default" },
  "reveal-token": { kind: "bool", describe: "Print raw token (show only)" },
  "config-path": {
    kind: "value",
    describe: "Override the profile file location (for tests)",
  },
};

export interface RunConfigOptions {
  /** Override `process.env` (tests). */
  env?: NodeJS.ProcessEnv;
}

export function runConfig(
  argv: string[],
  _opts: RunConfigOptions = {},
): Rendered {
  const env = _opts.env ?? process.env;
  const sub = argv[0];
  if (sub === undefined || sub === "--help" || sub === "-h") {
    return renderText(CONFIG_HELP.split("\n").slice(0, -1), ExitCode.success);
  }
  const rest = argv.slice(1);
  try {
    switch (sub) {
      case "init":
        return runInit(rest, env);
      case "add-profile":
        return runAddProfile(rest, env);
      case "list-profiles":
        return runListProfiles(rest, env);
      case "remove-profile":
        return runRemoveProfile(rest, env);
      case "show":
        return runShow(rest, env);
      default:
        return renderText(
          [CONFIG_HELP],
          ExitCode.badUsage,
          [`config: unknown subcommand '${sub}'`],
        );
    }
  } catch (err) {
    if (err instanceof CliUsageError) {
      return renderText([], ExitCode.badUsage, [`config ${sub}: ${err.message}`]);
    }
    if (err instanceof ProfileStoreError) {
      const code =
        err.code === "platform_unsupported" || err.code === "unknown_profile"
          ? ExitCode.badUsage
          : ExitCode.internal;
      return renderText([], code, [`config ${sub}: ${err.message}`]);
    }
    throw err;
  }
}

function requireHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

function resolvePath(env: NodeJS.ProcessEnv, override: unknown): string {
  if (typeof override === "string" && override.length > 0) return override;
  return defaultProfilesPath(env);
}

// ---- init -----------------------------------------------------------------

function runInit(argv: string[], env: NodeJS.ProcessEnv): Rendered {
  if (requireHelp(argv)) return renderText(INIT_HELP.split("\n").slice(0, -1), ExitCode.success);
  const { flags } = parseFlags(argv, CONFIG_FLAGS);
  const path = resolvePath(env, flags["config-path"]);
  const loaded = loadProfiles(path);
  if (loaded.exists) {
    return renderText([`profile file already exists: ${path}`], ExitCode.success, loaded.warnings);
  }
  saveProfiles(path, { profiles: {} });
  return renderText([`created ${path} (mode 0600)`], ExitCode.success);
}

// ---- add-profile ----------------------------------------------------------

function runAddProfile(argv: string[], env: NodeJS.ProcessEnv): Rendered {
  if (requireHelp(argv)) return renderText(ADD_PROFILE_HELP.split("\n").slice(0, -1), ExitCode.success);
  const { positional, flags } = parseFlags(argv, CONFIG_FLAGS);
  if (positional.length !== 1) {
    throw new CliUsageError("add-profile expects exactly one positional: <name>");
  }
  const [name] = positional as [string];
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    throw new CliUsageError(`profile name must match [A-Za-z0-9_.-]{1,64}`);
  }
  const server = typeof flags.server === "string" ? flags.server : undefined;
  const token = typeof flags.token === "string" ? flags.token : undefined;
  if (!server) throw new CliUsageError("--server <url> required");
  if (!token) throw new CliUsageError("--token <secret> required");
  if (token.startsWith("${") && token.endsWith("}")) {
    throw new CliUsageError(
      `--token looks like an env interpolation (${token}); pass the actual secret, not the placeholder`,
    );
  }
  const path = resolvePath(env, flags["config-path"]);
  const loaded = loadProfiles(path);
  const profile: Profile = { server, token };
  const next = upsertProfile(loaded.state, name, profile, {
    makeDefault: flags.default === true,
  });
  saveProfiles(path, next);
  const defaulted = next.defaultProfile === name;
  const stdout = [
    `stored profile '${name}' at ${path}` + (defaulted ? " (default)" : ""),
  ];
  return renderText(stdout, ExitCode.success, loaded.warnings);
}

// ---- list-profiles --------------------------------------------------------

function runListProfiles(argv: string[], env: NodeJS.ProcessEnv): Rendered {
  if (requireHelp(argv)) return renderText(LIST_PROFILES_HELP.split("\n").slice(0, -1), ExitCode.success);
  const { flags } = parseFlags(argv, CONFIG_FLAGS);
  const path = resolvePath(env, flags["config-path"]);
  const { state, warnings, exists } = loadProfiles(path);
  if (flags.json === true) {
    const body = {
      path,
      exists,
      default: state.defaultProfile ?? null,
      profiles: Object.fromEntries(
        Object.entries(state.profiles)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([n, p]) => [n, { server: p.server, token: redactToken(p.token) }]),
      ),
    };
    return renderJson(body, ExitCode.success);
  }
  const rows = Object.entries(state.profiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, p]) => [
      name === state.defaultProfile ? `${name} *` : name,
      p.server,
      redactToken(p.token),
    ]);
  if (rows.length === 0) {
    return renderText(
      [`no profiles configured (path: ${path})`],
      ExitCode.success,
      warnings,
    );
  }
  const lines = formatTable(["name", "server", "token"], rows);
  lines.push("");
  lines.push(`  * = default   (file: ${path})`);
  return renderText(lines, ExitCode.success, warnings);
}

// ---- remove-profile -------------------------------------------------------

function runRemoveProfile(argv: string[], env: NodeJS.ProcessEnv): Rendered {
  if (requireHelp(argv)) return renderText(REMOVE_PROFILE_HELP.split("\n").slice(0, -1), ExitCode.success);
  const { positional, flags } = parseFlags(argv, CONFIG_FLAGS);
  if (positional.length !== 1) {
    throw new CliUsageError("remove-profile expects exactly one positional: <name>");
  }
  const [name] = positional as [string];
  const path = resolvePath(env, flags["config-path"]);
  const { state, warnings, exists } = loadProfiles(path);
  if (!exists || !state.profiles[name]) {
    // Idempotent: no-op on missing profile.
    return renderText(
      [`profile '${name}' not present — nothing to remove`],
      ExitCode.success,
      warnings,
    );
  }
  const next = removeProfileState(state, name);
  saveProfiles(path, next);
  const suffix =
    state.defaultProfile === name && next.defaultProfile
      ? ` (new default: ${next.defaultProfile})`
      : state.defaultProfile === name
        ? " (no default remaining)"
        : "";
  return renderText([`removed profile '${name}'${suffix}`], ExitCode.success, warnings);
}

// ---- show -----------------------------------------------------------------

function runShow(argv: string[], env: NodeJS.ProcessEnv): Rendered {
  if (requireHelp(argv)) return renderText(SHOW_HELP.split("\n").slice(0, -1), ExitCode.success);
  const { positional, flags } = parseFlags(argv, CONFIG_FLAGS);
  if (positional.length > 1) {
    throw new CliUsageError("show expects at most one positional: <name>");
  }
  const reveal = flags["reveal-token"] === true;
  const path = resolvePath(env, flags["config-path"]);
  const { state, warnings } = loadProfiles(path);
  const names = positional.length === 1
    ? [positional[0]!]
    : Object.keys(state.profiles).sort();
  for (const name of names) {
    if (positional.length === 1 && !state.profiles[name]) {
      throw new CliUsageError(`profile '${name}' not found`);
    }
  }
  const body: Record<string, { server: string; token: string; default: boolean }> = {};
  for (const name of names) {
    const p = getProfile(state, name);
    if (!p) continue;
    body[name] = {
      server: p.server,
      token: reveal ? p.token : redactToken(p.token),
      default: state.defaultProfile === name,
    };
  }
  if (flags.json === true) {
    return renderJson({ path, default: state.defaultProfile ?? null, profiles: body }, ExitCode.success);
  }
  if (Object.keys(body).length === 0) {
    return renderText(
      [`no profiles configured (path: ${path})`],
      ExitCode.success,
      warnings,
    );
  }
  const lines: string[] = [];
  for (const [name, p] of Object.entries(body)) {
    lines.push(`[${name}]${p.default ? "  (default)" : ""}`);
    lines.push(`  server = ${p.server}`);
    lines.push(`  token  = ${p.token}`);
    lines.push("");
  }
  lines.push(`file: ${path}`);
  return renderText(lines, ExitCode.success, warnings);
}

// Exported for the top-level help dispatcher.
export { CONFIG_HELP };
