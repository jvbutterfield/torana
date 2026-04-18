type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let minLevel: number = LEVELS.info;

export function setLogLevel(level: string) {
  minLevel = LEVELS[level as LogLevel] ?? LEVELS.info;
}

function ts(): string {
  return new Date().toISOString();
}

function emit(level: LogLevel, component: string, msg: string, extra?: Record<string, unknown>) {
  if (LEVELS[level] < minLevel) return;
  const line: Record<string, unknown> = { ts: ts(), level, component, msg };
  if (extra) Object.assign(line, extra);
  const out = level === "error" ? console.error : console.log;
  out(JSON.stringify(line));
}

export function logger(component: string) {
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => emit("debug", component, msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => emit("info", component, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", component, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => emit("error", component, msg, extra),
  };
}
