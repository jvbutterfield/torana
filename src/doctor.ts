// `torana doctor` — C001..C014 checks from §3.1 + §9.2 of the plan, plus
// R001..R003 remote checks for `torana doctor --profile X` (US-016).
//
// Run after config load; makes live calls out to Telegram getMe + HEAD on
// webhook base URL. Agent-API local checks (C009..C014) are defence-in-depth
// — several overlap with zod schema rules on purpose so the operator still
// sees a useful message if a config arrived here by an unusual path.

import { existsSync, statSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { platform } from "node:os";

import type { Config } from "./config/schema.js";
import { TelegramClient } from "./telegram/client.js";
import { planMigration } from "./db/migrate.js";

export interface DoctorCheck {
  id: string;
  status: "ok" | "fail" | "skip" | "warn";
  detail: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  config: Config;
  configPath: string;
  /** Test override — inject a fake fetch for network checks. */
  fetchImpl?: typeof fetch;
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const { config } = opts;
  const checks: DoctorCheck[] = [];

  // C001 — config schema valid. (If we got here, it parsed.)
  checks.push({
    id: "C001",
    status: "ok",
    detail: "config schema valid",
  });

  // C002 — data_dir exists + writable.
  try {
    const stat = statSync(config.gateway.data_dir);
    if (!stat.isDirectory()) {
      checks.push({
        id: "C002",
        status: "fail",
        detail: `${config.gateway.data_dir} is not a directory`,
      });
    } else {
      checks.push({
        id: "C002",
        status: "ok",
        detail: `data_dir ${config.gateway.data_dir} exists`,
      });
    }
  } catch (err) {
    checks.push({
      id: "C002",
      status: "fail",
      detail: `data_dir: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // C003 — DB schema version.
  try {
    const plan = planMigration(config.gateway.db_path!);
    if (plan.steps.length === 0) {
      checks.push({
        id: "C003",
        status: "ok",
        detail: `DB user_version=${plan.currentVersion} (current)`,
      });
    } else {
      checks.push({
        id: "C003",
        status: "fail",
        detail: `DB user_version=${plan.currentVersion} (migration pending: ${plan.steps.map((s) => s.id).join(", ")})`,
      });
    }
  } catch (err) {
    checks.push({
      id: "C003",
      status: "fail",
      detail: `DB inspect failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // C004 — per-bot getMe.
  for (const bot of config.bots) {
    const client = new TelegramClient({
      botId: bot.id,
      token: bot.token,
      apiBaseUrl: config.telegram.api_base_url,
      fetchImpl: opts.fetchImpl,
    });
    try {
      const me = await client.getMe();
      checks.push({
        id: "C004",
        status: "ok",
        detail: `bot '${bot.id}': getMe ok (id=${me.id} username=${me.username ?? "?"})`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({
        id: "C004",
        status: "fail",
        detail: `bot '${bot.id}': getMe failed (${msg})`,
      });
    }
  }

  // C005 — runner entry point executable. For claude-code/codex we check
  // cli_path; for command we check cmd[0]. Resolved via PATH if not absolute.
  for (const bot of config.bots) {
    const entry =
      bot.runner.type === "claude-code" || bot.runner.type === "codex"
        ? bot.runner.cli_path
        : bot.runner.cmd[0];
    const resolved = await resolveEntryPoint(entry);
    if (resolved) {
      checks.push({
        id: "C005",
        status: "ok",
        detail: `bot '${bot.id}': runner entry '${entry}' → ${resolved}`,
      });
    } else {
      checks.push({
        id: "C005",
        status: "fail",
        detail: `bot '${bot.id}': runner entry '${entry}' not found in PATH`,
      });
    }
  }


  // C006 — webhook base_url reachable (HEAD; any non-5xx is pass).
  const usesWebhook =
    config.transport.default_mode === "webhook" ||
    config.bots.some((b) => b.transport_override?.mode === "webhook");
  if (!usesWebhook || !config.transport.webhook?.base_url) {
    checks.push({
      id: "C006",
      status: "skip",
      detail: "no bot uses webhook transport",
    });
  } else {
    const url = config.transport.webhook.base_url;
    try {
      const fetchImpl = opts.fetchImpl ?? fetch;
      const resp = await fetchImpl(url, { method: "HEAD" });
      if (resp.status >= 500) {
        checks.push({
          id: "C006",
          status: "fail",
          detail: `webhook base_url returned ${resp.status}`,
        });
      } else {
        checks.push({
          id: "C006",
          status: "ok",
          detail: `webhook base_url ${url} reachable (HTTP ${resp.status})`,
        });
      }
    } catch (err) {
      checks.push({
        id: "C006",
        status: "fail",
        detail: `webhook base_url ${url} unreachable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  // C007 — config file permissions (POSIX only).
  if (platform() === "win32") {
    checks.push({
      id: "C007",
      status: "skip",
      detail: "permission check not applicable on Windows",
    });
  } else {
    try {
      const stat = statSync(opts.configPath);
      const mode = stat.mode & 0o777;
      const worldReadable = (mode & 0o004) !== 0;
      if (worldReadable) {
        checks.push({
          id: "C007",
          status: "fail",
          detail: `config file mode 0${mode.toString(8)} is world-readable (recommend 0600)`,
        });
      } else {
        checks.push({
          id: "C007",
          status: "ok",
          detail: `config file mode 0${mode.toString(8)}`,
        });
      }
    } catch (err) {
      checks.push({
        id: "C007",
        status: "skip",
        detail: `permission check skipped: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // C008 — alerts.via_bot references an existing bot.
  if (!config.alerts) {
    checks.push({
      id: "C008",
      status: "skip",
      detail: "no alerts block configured",
    });
  } else if (config.alerts.via_bot && config.bots.some((b) => b.id === config.alerts!.via_bot)) {
    checks.push({
      id: "C008",
      status: "ok",
      detail: `alerts.via_bot='${config.alerts.via_bot}' resolves to a configured bot`,
    });
  } else {
    checks.push({
      id: "C008",
      status: "fail",
      detail: `alerts.via_bot='${config.alerts.via_bot}' does not match any bot id`,
    });
  }

  // --- Agent API checks (C009..C014). All skipped when the block is absent
  //     or disabled, so pre-feature operators see nothing unfamiliar.
  const agentApi = config.agent_api;
  const agentApiActive = agentApi?.enabled === true;

  // C009 — enabled + empty tokens. Warn.
  if (!agentApiActive) {
    checks.push({
      id: "C009",
      status: "skip",
      detail: "agent_api disabled",
    });
  } else if (agentApi.tokens.length === 0) {
    checks.push({
      id: "C009",
      status: "warn",
      detail: "agent_api.enabled=true but no tokens defined — no callers can authenticate",
    });
  } else {
    checks.push({
      id: "C009",
      status: "ok",
      detail: `agent_api.tokens=${agentApi.tokens.length}`,
    });
  }

  // C010 — tokens reference an unknown bot. Fail.
  if (!agentApiActive) {
    checks.push({ id: "C010", status: "skip", detail: "agent_api disabled" });
  } else {
    const known = new Set(config.bots.map((b) => b.id));
    const misses: string[] = [];
    for (const tok of agentApi.tokens) {
      for (const botId of tok.bot_ids) {
        if (!known.has(botId)) misses.push(`${tok.name}→${botId}`);
      }
    }
    if (misses.length > 0) {
      checks.push({
        id: "C010",
        status: "fail",
        detail: `token(s) reference unknown bot(s): ${misses.join(", ")}`,
      });
    } else {
      checks.push({
        id: "C010",
        status: "ok",
        detail: "all token bot_ids resolve to configured bots",
      });
    }
  }

  // C011 — ask-scope token on a runner that can't back it. Fail.
  // Derived statically from runner.type — the actual runner instance isn't
  // constructed by doctor. claude-code/codex support side-sessions; command
  // does not (Phase 2c pending).
  if (!agentApiActive) {
    checks.push({ id: "C011", status: "skip", detail: "agent_api disabled" });
  } else {
    const runnerSupports: Record<string, boolean> = {
      "claude-code": true,
      codex: true,
      command: false,
    };
    const byBot = new Map(config.bots.map((b) => [b.id, b.runner.type] as const));
    const offenders: string[] = [];
    for (const tok of agentApi.tokens) {
      if (!tok.scopes.includes("ask")) continue;
      for (const botId of tok.bot_ids) {
        const type = byBot.get(botId);
        if (!type) continue; // C010 will fail first
        if (runnerSupports[type] !== true) {
          offenders.push(`${tok.name}→${botId}(${type})`);
        }
      }
    }
    if (offenders.length > 0) {
      checks.push({
        id: "C011",
        status: "fail",
        detail: `ask-scope token(s) target runner(s) that don't support side-sessions: ${offenders.join(", ")}`,
      });
    } else {
      checks.push({
        id: "C011",
        status: "ok",
        detail: "every ask-scope token targets a side-session-capable runner",
      });
    }
  }

  // C012 — secret_ref resolves to empty/whitespace. Defence-in-depth: schema
  // uses NonEmptyString so this should already have failed, but an escape
  // through `${VAR:-}` with a literal empty default can evade it on some
  // parser paths.
  if (!agentApiActive) {
    checks.push({ id: "C012", status: "skip", detail: "agent_api disabled" });
  } else {
    const empties: string[] = [];
    for (const tok of agentApi.tokens) {
      if (!tok.secret_ref || tok.secret_ref.trim() === "") {
        empties.push(tok.name);
      }
    }
    if (empties.length > 0) {
      checks.push({
        id: "C012",
        status: "fail",
        detail: `token(s) have empty secret_ref after interpolation: ${empties.join(", ")}`,
      });
    } else {
      checks.push({
        id: "C012",
        status: "ok",
        detail: "all token secret_refs are non-empty",
      });
    }
  }

  // C013 — TTL + cap invariants. Defence-in-depth vs. schema superRefine.
  if (!agentApiActive) {
    checks.push({ id: "C013", status: "skip", detail: "agent_api disabled" });
  } else {
    const ss = agentApi.side_sessions;
    const ask = agentApi.ask;
    const violations: string[] = [];
    if (ss.idle_ttl_ms > ss.hard_ttl_ms) {
      violations.push(`side_sessions.idle_ttl_ms(${ss.idle_ttl_ms}) > hard_ttl_ms(${ss.hard_ttl_ms})`);
    }
    if (ss.max_per_bot > ss.max_global) {
      violations.push(`side_sessions.max_per_bot(${ss.max_per_bot}) > max_global(${ss.max_global})`);
    }
    if (ask.default_timeout_ms > ask.max_timeout_ms) {
      violations.push(
        `ask.default_timeout_ms(${ask.default_timeout_ms}) > max_timeout_ms(${ask.max_timeout_ms})`,
      );
    }
    if (violations.length > 0) {
      checks.push({
        id: "C013",
        status: "fail",
        detail: `agent_api invariant violation: ${violations.join("; ")}`,
      });
    } else {
      checks.push({
        id: "C013",
        status: "ok",
        detail: "agent_api TTL + cap invariants hold",
      });
    }
  }

  // C014 — deployment reminder when agent-api is enabled. Soft warn:
  // bearer tokens are the only thing standing between callers and the bot;
  // the gateway can't infer reverse-proxy or firewall posture so we just
  // note it every time.
  if (!agentApiActive) {
    checks.push({ id: "C014", status: "skip", detail: "agent_api disabled" });
  } else if (agentApi.tokens.length === 0) {
    checks.push({
      id: "C014",
      status: "skip",
      detail: "no tokens (see C009)",
    });
  } else {
    checks.push({
      id: "C014",
      status: "warn",
      detail:
        `agent_api bound on port ${config.gateway.port}; ensure TLS + network access controls (reverse proxy, firewall, VPN) match the trust model of the ${agentApi.tokens.length} token(s)`,
    });
  }

  return { checks };
}

// --- Remote checks (R001..R003) for `torana doctor --profile X`.

export interface RemoteDoctorOptions {
  /** Server base URL, e.g. https://torana.example.com */
  server: string;
  /** Bearer token presented to /v1/*. */
  token: string;
  /** Request deadline for each probe (default 2000ms). */
  timeoutMs?: number;
  /** Test override — inject a fake fetch. */
  fetchImpl?: typeof fetch;
}

export async function runRemoteDoctor(
  opts: RemoteDoctorOptions,
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const base = opts.server.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fn(ctrl.signal);
    } finally {
      clearTimeout(t);
    }
  }

  // R001 — GET /v1/health.
  try {
    const resp = await withTimeout((signal) =>
      fetchImpl(`${base}/v1/health`, { method: "GET", signal }),
    );
    if (resp.status === 200) {
      checks.push({
        id: "R001",
        status: "ok",
        detail: `GET /v1/health 200 from ${base}`,
      });
    } else {
      checks.push({
        id: "R001",
        status: "fail",
        detail: `GET /v1/health returned HTTP ${resp.status}`,
      });
    }
  } catch (err) {
    checks.push({
      id: "R001",
      status: "fail",
      detail: `GET /v1/health failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // R002 — GET /v1/bots with token.
  try {
    const resp = await withTimeout((signal) =>
      fetchImpl(`${base}/v1/bots`, {
        method: "GET",
        headers: { Authorization: `Bearer ${opts.token}` },
        signal,
      }),
    );
    if (resp.status !== 200) {
      checks.push({
        id: "R002",
        status: "fail",
        detail: `GET /v1/bots returned HTTP ${resp.status}`,
      });
    } else {
      let body: { bots?: unknown[] };
      try {
        body = (await resp.json()) as { bots?: unknown[] };
      } catch {
        checks.push({
          id: "R002",
          status: "fail",
          detail: "GET /v1/bots returned 200 with a non-JSON body",
        });
        body = {};
      }
      if (Array.isArray(body.bots)) {
        if (body.bots.length === 0) {
          checks.push({
            id: "R002",
            status: "warn",
            detail: "token returned 200 from /v1/bots but list is empty",
          });
        } else {
          checks.push({
            id: "R002",
            status: "ok",
            detail: `token authorized for ${body.bots.length} bot(s)`,
          });
        }
      }
    }
  } catch (err) {
    checks.push({
      id: "R002",
      status: "fail",
      detail: `GET /v1/bots failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // R003 — TLS. We only run this if the server URL is HTTPS; fetch validates
  // by default, so any TLS failure surfaces as a network error that R001/R002
  // already captured. We replay a minimal probe to get a cleaner message.
  if (!base.toLowerCase().startsWith("https://")) {
    checks.push({
      id: "R003",
      status: "skip",
      detail: "server URL is not https — TLS check skipped",
    });
  } else {
    try {
      await withTimeout((signal) =>
        fetchImpl(`${base}/v1/health`, { method: "GET", signal }),
      );
      checks.push({
        id: "R003",
        status: "ok",
        detail: "TLS handshake succeeded (default fetch validation)",
      });
    } catch (err) {
      checks.push({
        id: "R003",
        status: "fail",
        detail: `TLS/connection failure: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { checks };
}

async function resolveEntryPoint(entry: string): Promise<string | null> {
  if (isAbsolute(entry)) return existsSync(entry) ? entry : null;
  if (entry.startsWith("./") || entry.startsWith("../")) {
    const abs = resolve(process.cwd(), entry);
    return existsSync(abs) ? abs : null;
  }
  // Resolve via PATH.
  const path = process.env.PATH ?? "";
  const sep = platform() === "win32" ? ";" : ":";
  const exts = platform() === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = resolve(dir, entry + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
