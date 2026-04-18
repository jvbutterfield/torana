export type PersonaName = "cato" | "harper" | "trader";

export const PERSONAS: PersonaName[] = ["cato", "harper", "trader"];

export interface Config {
  port: number;
  dataRoot: string;
  dbPath: string;
  webhookBaseUrl: string;
  webhookSecret: string;
  allowedUserId: string;
  logLevel: string;

  // Per-persona bot tokens
  botTokens: Record<PersonaName, string>;

  // Worker tuning
  workerStartupTimeoutMs: number;
  workerStallTimeoutMs: number;
  workerTurnTimeoutMs: number;
  crashLoopBackoffBaseMs: number;
  crashLoopBackoffCapMs: number;
  stabilityWindowMs: number;
  maxConsecutiveFailures: number;

  // Streaming
  editCadenceMs: number;
  messageLengthLimit: number;
  messageLengthSafeMargin: number;

  // Outbox
  outboxMaxAttempts: number;
  outboxRetryBaseMs: number;

  // OAuth token (passed through to workers)
  oauthToken: string;
  githubToken: string;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var ${name} is not set`);
  return val;
}

function optEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export function loadConfig(): Config {
  const dataRoot = optEnv("DATA_ROOT", "/data");
  return {
    port: parseInt(optEnv("PORT", "3000"), 10),
    dataRoot,
    dbPath: optEnv("GATEWAY_DB_PATH", `${dataRoot}/gateway/gateway.db`),
    webhookBaseUrl: requireEnv("TELEGRAM_WEBHOOK_BASE_URL"),
    webhookSecret: requireEnv("TELEGRAM_WEBHOOK_SECRET"),
    allowedUserId: requireEnv("TELEGRAM_ALLOWED_USER_ID"),
    logLevel: optEnv("GATEWAY_LOG_LEVEL", "info"),

    botTokens: {
      cato: requireEnv("TELEGRAM_BOT_TOKEN_CATO"),
      harper: requireEnv("TELEGRAM_BOT_TOKEN_HARPER"),
      trader: requireEnv("TELEGRAM_BOT_TOKEN_TRADER"),
    },

    workerStartupTimeoutMs: parseInt(optEnv("WORKER_STARTUP_TIMEOUT_SECS", "60"), 10) * 1000,
    workerStallTimeoutMs: parseInt(optEnv("WORKER_STALL_TIMEOUT_SECS", "90"), 10) * 1000,
    workerTurnTimeoutMs: parseInt(optEnv("WORKER_TURN_TIMEOUT_SECS", "1200"), 10) * 1000,
    crashLoopBackoffBaseMs: 5_000,
    crashLoopBackoffCapMs: 300_000,
    stabilityWindowMs: 600_000,
    maxConsecutiveFailures: 10,

    editCadenceMs: 1_500,
    messageLengthLimit: 4096,
    messageLengthSafeMargin: 3800,

    outboxMaxAttempts: 5,
    outboxRetryBaseMs: 2_000,

    oauthToken: requireEnv("CLAUDE_CODE_OAUTH_TOKEN"),
    githubToken: requireEnv("GITHUB_TOKEN"),
  };
}
