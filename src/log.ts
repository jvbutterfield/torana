// Structured logger with configurable level, format, and secret redaction.
//
// Every log line carries {ts, level, module, msg, ...fields}. Values are
// recursively walked; any string containing a known secret is masked with
// "<redacted>", and any URL-shaped string with "/bot<TOKEN>/" is rewritten to
// "/bot<redacted>/" regardless of whether the token is in the known-secret set.
//
// The redactor is configured once at startup via `setSecrets()`. Callsites
// cannot opt out — all emits go through the central `emit()`.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "text";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: number = LEVELS.info;
let format: LogFormat = "json";
let secrets: string[] = [];

export function setLogLevel(level: string): void {
  minLevel = LEVELS[level as LogLevel] ?? LEVELS.info;
}

export function setLogFormat(fmt: LogFormat): void {
  format = fmt;
}

export function setSecrets(values: string[]): void {
  // Redact every configured secret regardless of length. Schema-layer
  // validation (SecretString in config/schema.ts) already rejects trivially
  // short webhook/agent-api secrets; bot tokens are Telegram-controlled and
  // always long. No length filter is applied here so operators cannot
  // accidentally bypass redaction by setting an otherwise-valid short value.
  // Sort by length descending so overlapping secrets replace longest-first.
  secrets = [...new Set(values.filter((v) => v.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
}

/** Auto-detect format: json when stdout is piped, text when TTY. */
export function autoFormat(): LogFormat {
  return process.stdout.isTTY ? "text" : "json";
}

const URL_BOT_TOKEN_RE = /\/bot([A-Za-z0-9_:-]{5,})\//g;

function redactString(s: string): string {
  let out = s.replace(URL_BOT_TOKEN_RE, "/bot<redacted>/");
  for (const secret of secrets) {
    if (out.includes(secret)) {
      // Split/join is faster than RegExp with arbitrary inputs and needs no escape.
      out = out.split(secret).join("<redacted>");
    }
  }
  return out;
}

function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redactString(v);
  if (v === null || v === undefined) return v;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(redactValue);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = redactValue(val);
  }
  return out;
}

function ts(): string {
  return new Date().toISOString();
}

function emit(
  level: LogLevel,
  module: string,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  if (LEVELS[level] < minLevel) return;

  const redactedMsg = redactString(msg);
  const redactedExtra = extra
    ? (redactValue(extra) as Record<string, unknown>)
    : undefined;

  const line: Record<string, unknown> = {
    ts: ts(),
    level,
    module,
    msg: redactedMsg,
  };
  if (redactedExtra) Object.assign(line, redactedExtra);

  const out = level === "error" ? console.error : console.log;
  if (format === "json") {
    out(JSON.stringify(line));
  } else {
    const extraStr = redactedExtra
      ? " " +
        Object.entries(redactedExtra)
          .map(
            ([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`,
          )
          .join(" ")
      : "";
    out(
      `${line.ts} ${level.toUpperCase().padEnd(5)} ${module}: ${redactedMsg}${extraStr}`,
    );
  }
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function logger(
  module: string,
  bindings: Record<string, unknown> = {},
): Logger {
  const merge = (
    extra?: Record<string, unknown>,
  ): Record<string, unknown> | undefined => {
    if (!extra)
      return Object.keys(bindings).length > 0 ? { ...bindings } : undefined;
    return { ...bindings, ...extra };
  };

  return {
    debug: (msg, extra) => emit("debug", module, msg, merge(extra)),
    info: (msg, extra) => emit("info", module, msg, merge(extra)),
    warn: (msg, extra) => emit("warn", module, msg, merge(extra)),
    error: (msg, extra) => emit("error", module, msg, merge(extra)),
    child: (newBindings) => logger(module, { ...bindings, ...newBindings }),
  };
}

/** Test-only: reset all logger globals. */
export function resetLoggerState(): void {
  minLevel = LEVELS.info;
  format = "json";
  secrets = [];
}
