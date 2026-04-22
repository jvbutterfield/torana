// Two-pass argv parser used by the agent-api subcommands. The legacy
// gateway subcommands (`start`, `doctor`, `validate`, `migrate`, `version`)
// still go through `parseArgs` in `src/cli.ts`; this parser handles the new
// `ask`, `send`, `turns get`, `bots list` chains where positionals matter.
//
// Pass 1: walk argv until we hit a non-flag token; that token (plus an
// optional second non-flag for `turns get`/`bots list`) is the subcommand
// chain. The rest goes to pass 2.
//
// Pass 2: per-subcommand flag specs declared in the subcommand modules.
// Boolean flags (no value) and value flags (`--flag value` or
// `--flag=value`) are both supported. Repeated value flags accumulate
// into an array (used for `--file`).
//
// Precedence for `server` and `token`:
//   explicit flag > env > named profile > default profile > error
// The profile layer loads `~/.config/torana/config.toml` via
// `src/cli/shared/profile.ts`. Callers pass in a loaded `ProfileState` (or
// omit it to bypass the profile layer entirely — useful in tests).

export type FlagKind = "bool" | "value" | "values";

export interface FlagSpec {
  kind: FlagKind;
  /** Short alias, e.g. `s` for `--server`. Optional. */
  short?: string;
  /** Help string — surfaced by per-subcommand --help. */
  describe: string;
}

export interface ParsedSubcommand {
  /** The full chain, e.g. ["turns", "get"] or ["ask"]. */
  chain: string[];
  /** Positional args after the chain, in order. */
  positional: string[];
  /** Flag values keyed by long name (without leading dashes). */
  flags: Record<string, string | string[] | boolean>;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/**
 * Walk argv and lift the subcommand chain off the front. The chain is up
 * to two non-flag tokens — sufficient for `turns get`, `bots list`,
 * `sessions list`, `sessions delete`. Anything else falls through as
 * positional.
 */
export function extractChain(argv: string[]): {
  chain: string[];
  rest: string[];
} {
  const chain: string[] = [];
  let i = 0;
  while (i < argv.length && chain.length < 2) {
    const tok = argv[i]!;
    if (tok.startsWith("-")) break;
    chain.push(tok);
    i += 1;
  }
  return { chain, rest: argv.slice(i) };
}

/**
 * Parse argv against a flag spec. Returns positional args (anything not
 * consumed as a flag value, in order) and the keyed flag map.
 *
 * Throws CliUsageError on:
 *   - unknown flag
 *   - value flag without a value
 *   - bool flag with `=value`
 *   - repeated `value` (non-array) flag
 */
export function parseFlags(
  argv: string[],
  spec: Record<string, FlagSpec>,
): { positional: string[]; flags: Record<string, string | string[] | boolean> } {
  const flags: Record<string, string | string[] | boolean> = {};
  const positional: string[] = [];

  // Build short alias map for quick lookup.
  const shortMap = new Map<string, string>();
  for (const [name, s] of Object.entries(spec)) {
    if (s.short) shortMap.set(s.short, name);
  }

  let i = 0;
  while (i < argv.length) {
    const tok = argv[i]!;

    if (tok === "--") {
      // Conventional terminator: everything after is positional.
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      const inline = eq === -1 ? null : tok.slice(eq + 1);
      const s = spec[name];
      if (!s) throw new CliUsageError(`unknown flag: --${name}`);
      i = ingest(name, s, inline, argv, i, flags);
      continue;
    }

    if (tok.startsWith("-") && tok.length >= 2 && tok !== "-") {
      // Short flag (or short cluster — but we don't support clustering).
      const eq = tok.indexOf("=");
      const short = eq === -1 ? tok.slice(1) : tok.slice(1, eq);
      const inline = eq === -1 ? null : tok.slice(eq + 1);
      const longName = shortMap.get(short);
      if (!longName) throw new CliUsageError(`unknown flag: -${short}`);
      const s = spec[longName]!;
      i = ingest(longName, s, inline, argv, i, flags);
      continue;
    }

    positional.push(tok);
    i += 1;
  }

  return { positional, flags };
}

function ingest(
  name: string,
  spec: FlagSpec,
  inline: string | null,
  argv: string[],
  i: number,
  flags: Record<string, string | string[] | boolean>,
): number {
  if (spec.kind === "bool") {
    if (inline !== null) {
      throw new CliUsageError(`--${name} does not take a value`);
    }
    flags[name] = true;
    return i + 1;
  }
  // value or values
  let value: string;
  if (inline !== null) {
    value = inline;
    i += 1;
  } else {
    const next = argv[i + 1];
    if (next === undefined) {
      throw new CliUsageError(`--${name} requires a value`);
    }
    value = next;
    i += 2;
  }
  if (spec.kind === "values") {
    const existing = flags[name];
    if (Array.isArray(existing)) existing.push(value);
    else flags[name] = [value];
  } else {
    if (flags[name] !== undefined) {
      throw new CliUsageError(`--${name} given more than once`);
    }
    flags[name] = value;
  }
  return i;
}

// ---- credential resolution -------------------------------------------------

export interface CredentialSource {
  /** Explicit `--server` value. */
  flagServer?: string;
  /** Explicit `--token` value. */
  flagToken?: string;
  /** Explicit `--profile NAME`. */
  profileName?: string;
  /** Loaded profile store (optional). Bypassed when undefined. */
  profiles?: import("./profile.js").ProfileState;
  /** Environment snapshot. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedCredentials {
  server: string;
  token: string;
  /** Individual resolution steps, e.g. `["server:flag","token:profile:prod"]`. */
  trace: string[];
  /** Which profile, if any, contributed to the resolution. */
  profile?: string;
}

/**
 * Resolve `server` + `token` with precedence:
 *   flag  >  env  >  named profile (--profile NAME or equivalent)  >
 *   default profile  >  error.
 *
 * `server` and `token` are resolved independently — you can pull `server`
 * from a profile while overriding `token` via `--token` on the command line.
 * Trace entries annotate *which* layer each came from so
 * `TORANA_DEBUG=1` can print them.
 */
export function resolveCredentials(
  src: CredentialSource,
): ResolvedCredentials {
  const env = src.env ?? process.env;
  const trace: string[] = [];

  const profiles = src.profiles;
  let chosenProfileName: string | undefined;
  let chosenProfile: import("./profile.js").Profile | undefined;
  if (profiles !== undefined) {
    if (src.profileName !== undefined) {
      const p = profiles.profiles[src.profileName];
      if (!p) {
        const known = Object.keys(profiles.profiles).sort().join(", ") || "(none)";
        throw new CliUsageError(
          `profile '${src.profileName}' not found (known: ${known})`,
        );
      }
      chosenProfileName = src.profileName;
      chosenProfile = p;
    } else if (profiles.defaultProfile) {
      const p = profiles.profiles[profiles.defaultProfile];
      if (p) {
        chosenProfileName = profiles.defaultProfile;
        chosenProfile = p;
      }
    }
  } else if (src.profileName !== undefined) {
    // Caller passed --profile NAME but didn't load a profile store. This is
    // always a programming error — the dispatcher should have loaded one.
    throw new CliUsageError(
      `--profile ${src.profileName} requested but no profile store is available`,
    );
  }

  let server: string | undefined = src.flagServer;
  if (server) trace.push("server:flag");
  else if (env.TORANA_SERVER) {
    server = env.TORANA_SERVER;
    trace.push("server:env");
  } else if (chosenProfile) {
    server = chosenProfile.server;
    trace.push(`server:profile:${chosenProfileName}`);
  }
  if (!server) {
    throw new CliUsageError(
      "--server <url> required (or set TORANA_SERVER env, or configure a profile with `torana config add-profile`)",
    );
  }

  let token: string | undefined = src.flagToken;
  if (token) trace.push("token:flag");
  else if (env.TORANA_TOKEN) {
    token = env.TORANA_TOKEN;
    trace.push("token:env");
  } else if (chosenProfile) {
    token = chosenProfile.token;
    trace.push(`token:profile:${chosenProfileName}`);
  }
  if (!token) {
    throw new CliUsageError(
      "--token <secret> required (or set TORANA_TOKEN env, or configure a profile with `torana config add-profile`)",
    );
  }

  return {
    server,
    token,
    trace,
    profile: chosenProfileName,
  };
}

/**
 * Emit `trace` to stderr when `TORANA_DEBUG=1` or `verbose=true`. Used by
 * subcommands + doctor so users can see which layer supplied each credential
 * when diagnosing config surprises.
 */
export function traceLines(
  trace: string[],
  opts: { verbose?: boolean; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const env = opts.env ?? process.env;
  if (!opts.verbose && env.TORANA_DEBUG !== "1") return [];
  return [`# credentials resolved: ${trace.join(", ")}`];
}

/**
 * Convenience: parse `argv` and return `{chain, positional, flags}`. Wraps
 * extractChain + parseFlags into one call.
 */
export function parseCommand(
  argv: string[],
  spec: Record<string, FlagSpec>,
): ParsedSubcommand {
  const { chain, rest } = extractChain(argv);
  const { positional, flags } = parseFlags(rest, spec);
  return { chain, positional, flags };
}

// Common flags that every agent-api subcommand accepts. Subcommands merge
// these into their own spec so the CLI surface is consistent.
export const COMMON_FLAGS: Record<string, FlagSpec> = {
  server: { kind: "value", describe: "Torana server URL (env: TORANA_SERVER)" },
  token: { kind: "value", describe: "Bearer token (env: TORANA_TOKEN)" },
  profile: {
    kind: "value",
    describe: "Use a named profile from the config store",
  },
  verbose: {
    kind: "bool",
    describe: "Print credential resolution trace to stderr",
  },
  json: { kind: "bool", describe: "Emit JSON instead of human-formatted output" },
  help: { kind: "bool", short: "h", describe: "Show help for this subcommand" },
};
