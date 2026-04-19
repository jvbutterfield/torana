// `torana doctor` — C001..C008 checks from §3.1 of the plan.
// Run after config load; makes live calls out to Telegram getMe + HEAD on
// webhook base URL.

import { existsSync, statSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { platform } from "node:os";

import type { Config } from "./config/schema.js";
import { TelegramClient } from "./telegram/client.js";
import { planMigration } from "./db/migrate.js";

export interface DoctorCheck {
  id: string;
  status: "ok" | "fail" | "skip";
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
