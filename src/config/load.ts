import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, dirname } from "node:path";
import yaml from "js-yaml";
import { ZodError } from "zod";
import { ConfigSchema, type Config, SECRET_PATHS } from "./schema.js";

export class ConfigLoadError extends Error {
  constructor(
    message: string,
    public readonly path?: string,
    public readonly issues?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "ConfigLoadError";
  }
}

export interface LoadOptions {
  /** Skip env var interpolation (useful for tests that supply fully-resolved YAML). */
  skipInterpolation?: boolean;
  /** Override env map used for ${VAR} interpolation (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Max config-file bytes (defense against pathological YAML). Default 1 MB. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * Interpolate `${VAR}` and `${VAR:-default}` references. Missing `${VAR}` without a default is fatal.
 *
 * Runs on the raw config text before YAML parse, so we first mask out YAML
 * comments — a literal `${VAR}` in prose inside a `#` comment should not be
 * treated as a real reference. This bit rc.1 users: see plan §14.L bug 1.
 *
 * Errors include `line`/`column` so the user can find the reference.
 */
export function interpolate(input: string, env: Record<string, string | undefined>): string {
  const masked = maskYamlComments(input);
  return input.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g, (match, name, fallback, offset) => {
    // `masked` has the same length as `input` — if the same offset in `masked`
    // has been replaced with spaces, the reference lives inside a comment and
    // we must leave the original text unchanged.
    if (masked[offset] === " ") return match;
    const val = env[name];
    if (val !== undefined && val !== "") return val;
    if (fallback !== undefined) return fallback;
    if (val === "") return "";
    const { line, column } = offsetToLineColumn(input, offset);
    throw new ConfigLoadError(
      `env var \${${name}} is not set and has no default (at line ${line}, column ${column})`,
    );
  });
}

/**
 * Replace YAML comment spans with spaces, preserving every other character and
 * the overall length. Comment start is an unquoted `#` that is either at start
 * of line or preceded by whitespace (YAML's rule). Handles single- and
 * double-quoted string context so `#` inside a quoted value is not mistaken
 * for a comment.
 */
function maskYamlComments(input: string): string {
  const out: string[] = [];
  let inSingle = false;
  let inDouble = false;
  let inComment = false;
  let prev = "";
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (inComment) {
      if (c === "\n") {
        inComment = false;
        out.push(c);
      } else {
        out.push(" ");
      }
      prev = c;
      continue;
    }
    if (c === "\\" && inDouble) {
      // double-quoted strings support \" and friends; skip the next char
      out.push(c);
      if (i + 1 < input.length) {
        out.push(input[i + 1]!);
        i++;
      }
      prev = c;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      out.push(c);
      prev = c;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      out.push(c);
      prev = c;
      continue;
    }
    if (c === "#" && !inSingle && !inDouble && (prev === "" || /\s/.test(prev))) {
      inComment = true;
      out.push(" ");
      prev = c;
      continue;
    }
    if (c === "\n") {
      inSingle = false;
      inDouble = false;
    }
    out.push(c);
    prev = c;
  }
  return out.join("");
}

function offsetToLineColumn(input: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < input.length; i++) {
    if (input[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

/** Main entry point: read from disk, interpolate, parse YAML, validate. */
export function loadConfigFromFile(filePath: string, opts: LoadOptions = {}): LoadedConfig {
  const absPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  const stat = statSync(absPath);
  if (stat.size > (opts.maxBytes ?? DEFAULT_MAX_BYTES)) {
    throw new ConfigLoadError(
      `config file is larger than ${opts.maxBytes ?? DEFAULT_MAX_BYTES} bytes`,
      absPath,
    );
  }
  const raw = readFileSync(absPath, "utf8");
  return loadConfigFromString(raw, { ...opts, filePath: absPath });
}

export interface LoadedConfig {
  config: Config;
  /** Absolute path the config was loaded from (empty for string loads). */
  sourcePath: string;
  /** Values pulled from the resolved config whose slots are marked secret — for the log redactor. */
  secrets: string[];
}

/** Internal: load from a string with interpolation + validation. */
export function loadConfigFromString(
  raw: string,
  opts: LoadOptions & { filePath?: string } = {},
): LoadedConfig {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const interpolated = opts.skipInterpolation ? raw : interpolate(raw, env);

  let parsed: unknown;
  try {
    parsed = yaml.load(interpolated);
  } catch (err) {
    throw new ConfigLoadError(`YAML parse error: ${(err as Error).message}`, opts.filePath);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigLoadError("config root must be a YAML object", opts.filePath);
  }

  let config: Config;
  try {
    config = ConfigSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({
        path: pathToString(i.path),
        message: i.message,
      }));
      const summary = issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
      throw new ConfigLoadError(
        `config validation failed:\n${summary}`,
        opts.filePath,
        issues,
      );
    }
    throw err;
  }

  // Resolve paths relative to data_dir / config file.
  const dataDir = isAbsolute(config.gateway.data_dir)
    ? config.gateway.data_dir
    : resolve(opts.filePath ? dirname(opts.filePath) : process.cwd(), config.gateway.data_dir);
  config.gateway.data_dir = dataDir;

  if (config.gateway.db_path) {
    config.gateway.db_path = isAbsolute(config.gateway.db_path)
      ? config.gateway.db_path
      : resolve(dataDir, config.gateway.db_path);
  } else {
    config.gateway.db_path = resolve(dataDir, "gateway.db");
  }

  // Runner cwd: absolute, or resolve relative to process cwd.
  for (const bot of config.bots) {
    if (bot.runner.cwd) {
      bot.runner.cwd = isAbsolute(bot.runner.cwd)
        ? bot.runner.cwd
        : resolve(process.cwd(), bot.runner.cwd);
    }
  }

  // Defaults that need cross-section resolution.
  if (config.alerts) {
    if (config.alerts.chat_id === undefined) {
      config.alerts.chat_id = config.access_control.allowed_user_ids[0];
    }
    if (!config.alerts.via_bot) {
      config.alerts.via_bot = config.bots[0]?.id;
    }
  }

  return {
    config,
    sourcePath: opts.filePath ?? "",
    secrets: collectSecrets(config),
  };
}

function pathToString(segments: (string | number)[]): string {
  return segments
    .map((s, i) => (typeof s === "number" ? `[${s}]` : i === 0 ? s : `.${s}`))
    .join("");
}

function collectSecrets(config: Config): string[] {
  const secrets = new Set<string>();
  if (config.transport.webhook?.secret) secrets.add(config.transport.webhook.secret);
  for (const bot of config.bots) {
    if (bot.token) secrets.add(bot.token);
  }
  return [...secrets].filter((s) => s.length >= 6);
}

export { SECRET_PATHS };
