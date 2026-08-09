// `torana doctor` — C001..C014 checks from §3.1 + §9.2 of the plan, plus
// R001..R003 remote checks for `torana doctor --profile X` (US-016).
//
// Run after config load; makes live calls out to Telegram getMe + HEAD on
// webhook base URL. Agent-API local checks (C009..C014) are defence-in-depth
// — several overlap with zod schema rules on purpose so the operator still
// sees a useful message if a config arrived here by an unusual path.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, resolve, isAbsolute } from "node:path";
import { platform } from "node:os";
import { Database } from "bun:sqlite";

import type { Config } from "./config/schema.js";
import type { NormalizedConfigModel } from "./config/v2.js";
import { isBuzzOnlyBotToken } from "./config/v2.js";
import { TelegramClient } from "./telegram/client.js";
import { planMigration } from "./db/migrate.js";
import { runnerSupportsSideSessions } from "./runner/types.js";
import { dataDirLockAvailable } from "./data-dir-lock.js";
import { probeBuzzEndpoint } from "./platform/buzz/transport.js";
import {
  BUZZ_KINDS,
  ownerAuthTagAllowsEvent,
  parseOwnerAuthTag,
} from "./platform/buzz/protocol.js";
import { redactString } from "./log.js";
import { BUZZ_CLI_PIN } from "./broker/buzz-policy.js";
import {
  openSecretDetailed,
  provisioningKeyringFromEnv,
  PROVISIONING_KEY_ENV,
} from "./config/provisioning-secrets.js";

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
  /** Original public config version before normalization. */
  sourceConfigVersion?: 1 | 2;
  /** Platform-neutral v1/v2 metadata, including secret-bearing Buzz runtime config. */
  normalized?: NormalizedConfigModel;
  /** Test override for live Buzz relay checks. */
  buzzProbe?: typeof probeBuzzEndpoint;
  /** Explicitly probe one publisher even while its endpoint is disabled. */
  publisherProbeId?: string;
  /** Test override for the pinned local Buzz CLI checksum probe. */
  buzzCliProbe?: (cliPath: string) => { path: string; sha256: string } | null;
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
      let vacuumDetail = "";
      if (plan.currentVersion === 5) {
        const db = new Database(config.gateway.db_path!, { readonly: true });
        try {
          const mode = db.query("PRAGMA auto_vacuum").get() as {
            auto_vacuum: number;
          };
          if (mode.auto_vacuum !== 2) {
            checks.push({
              id: "C003",
              status: "fail",
              detail:
                "DB schema is v5 but incremental auto-vacuum is not enabled",
            });
            vacuumDetail = "failed";
          }
        } finally {
          db.close();
        }
      }
      if (vacuumDetail === "failed") {
        // Failure already recorded with the repair-relevant detail.
      } else {
        checks.push({
          id: "C003",
          status: "ok",
          detail: `DB user_version=${plan.currentVersion} (current)`,
        });
      }
    } else if (
      plan.currentVersion === 3 &&
      (opts.sourceConfigVersion ?? 1) === 1
    ) {
      checks.push({
        id: "C003",
        status: "warn",
        detail:
          "DB user_version=3 (compatibility bridge mode; schema-v5 migration available)",
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

  // C004 — per-bot getMe. A Buzz-only agent has no Telegram identity: the
  // legacy bot shape carries a sentinel in place of a token, and dialling
  // Telegram with it reports a spurious failure for a correctly configured
  // agent. Skip rather than omit, so the agent still appears in the report.
  for (const bot of config.bots) {
    if (isBuzzOnlyBotToken(bot.token)) {
      checks.push({
        id: "C004",
        status: "skip",
        detail: `bot '${bot.id}': Buzz-only agent has no Telegram identity; getMe not probed`,
      });
      continue;
    }
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
  } else if (
    config.alerts.via_bot &&
    config.bots.some((b) => b.id === config.alerts!.via_bot)
  ) {
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
      detail:
        "agent_api.enabled=true but no tokens defined — no callers can authenticate",
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
        // '*' is the provisioned-agent wildcard; it resolves at request time
        // and has no configured bot to match. Config validation already
        // restricts it to sole-scope endpoints:admin tokens.
        if (botId === "*") continue;
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
  // Derived statically from the runner config via runnerSupportsSideSessions
  // (src/runner/types.ts) — single source of truth for this mapping so new
  // runners can flip the bit in one place. For `type: command` the answer
  // depends on the configured protocol (Phase 2c).
  if (!agentApiActive) {
    checks.push({ id: "C011", status: "skip", detail: "agent_api disabled" });
  } else {
    const byBot = new Map(config.bots.map((b) => [b.id, b.runner] as const));
    const offenders: string[] = [];
    for (const tok of agentApi.tokens) {
      if (!tok.scopes.includes("ask")) continue;
      for (const botId of tok.bot_ids) {
        const runner = byBot.get(botId);
        if (!runner) continue; // C010 will fail first
        if (!runnerSupportsSideSessions(runner)) {
          const label =
            runner.type === "command"
              ? `${runner.type}/${runner.protocol}`
              : runner.type;
          offenders.push(`${tok.name}→${botId}(${label})`);
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
      violations.push(
        `side_sessions.idle_ttl_ms(${ss.idle_ttl_ms}) > hard_ttl_ms(${ss.hard_ttl_ms})`,
      );
    }
    if (ss.max_per_bot > ss.max_global) {
      violations.push(
        `side_sessions.max_per_bot(${ss.max_per_bot}) > max_global(${ss.max_global})`,
      );
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
      detail: `agent_api bound on port ${config.gateway.port}; ensure TLS + network access controls (reverse proxy, firewall, VPN) match the trust model of the ${agentApi.tokens.length} token(s)`,
    });
  }

  // C015 — DB file permissions. The DB contains every bot token,
  // inbound Telegram message payloads (text + PII), and agent-API
  // turn rows. If the file is world/group-readable, any other user on
  // the host can read credentials and message contents directly.
  // GatewayDB + applyMigrations chmod the file to 0600 on open, but
  // pre-existing DBs created before this release may still be wide
  // open, and some filesystems (Windows NTFS, certain FUSE mounts)
  // don't honour chmod — flag those here so operators notice.
  const dbPath =
    config.gateway.db_path ?? resolve(config.gateway.data_dir, "gateway.db");
  if (process.platform === "win32") {
    checks.push({
      id: "C015",
      status: "skip",
      detail: "db permission check not applicable on Windows",
    });
  } else if (!existsSync(dbPath)) {
    checks.push({
      id: "C015",
      status: "skip",
      detail: `db does not exist yet (${dbPath})`,
    });
  } else {
    try {
      const stat = statSync(dbPath);
      const mode = stat.mode & 0o777;
      const worldOrGroupReadable = (mode & 0o044) !== 0;
      if (worldOrGroupReadable) {
        checks.push({
          id: "C015",
          status: "fail",
          detail: `db file mode 0${mode.toString(8)} is group/world-readable; contains bot tokens + message history (recommend 0600)`,
        });
      } else {
        checks.push({
          id: "C015",
          status: "ok",
          detail: `db file mode 0${mode.toString(8)}`,
        });
      }
    } catch (err) {
      checks.push({
        id: "C015",
        status: "skip",
        detail: `db permission check skipped: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const buzzEndpoints =
    opts.normalized?.endpoints.filter(
      (endpoint) => endpoint.platform === "buzz" && endpoint.buzz,
    ) ?? [];
  const explicitPublisherProbeRequested = Boolean(opts.publisherProbeId);
  const buzzOperational =
    !explicitPublisherProbeRequested &&
    opts.normalized?.buzzPlatform?.enabled &&
    buzzEndpoints.some((endpoint) => endpoint.enabled);
  const requestedPublisher = opts.publisherProbeId
    ? opts.normalized?.publishers?.find(
        (publisher) => publisher.id === opts.publisherProbeId,
      )
    : undefined;

  // C016 — single-writer data-directory lock. Required before relay intake.
  if (!buzzOperational) {
    checks.push({
      id: "C016",
      status: "skip",
      detail: explicitPublisherProbeRequested
        ? "publisher probe is transient and does not require the gateway lock"
        : "no enabled Buzz endpoint requires the gateway lock",
    });
  } else {
    const lock = dataDirLockAvailable(config.gateway.data_dir);
    checks.push({
      id: "C016",
      status: lock.available ? "ok" : "fail",
      detail: lock.detail,
    });
  }

  const sharedIdentities = new Map<string, number>();
  for (const endpoint of buzzEndpoints) {
    const buzz = endpoint.buzz!;
    const explicitPublisherProbe =
      requestedPublisher?.endpointId === endpoint.id;
    const probeRelay = explicitPublisherProbeRequested
      ? explicitPublisherProbe
      : endpoint.enabled && Boolean(opts.normalized?.buzzPlatform?.enabled);
    sharedIdentities.set(
      buzz.pubkey,
      (sharedIdentities.get(buzz.pubkey) ?? 0) + 1,
    );
    checks.push({
      id: "C017",
      status: "ok",
      detail: `Buzz endpoint '${endpoint.id}': key derives pubkey ${buzz.pubkey.slice(0, 12)}…`,
    });

    let ownerStatus: DoctorCheck["status"] = "ok";
    let ownerDetail = buzz.ownerPubkey
      ? `owner ${buzz.ownerPubkey.slice(0, 12)}… resolved`
      : "no owner configured";
    if (buzz.respondTo === "owner_only" && !buzz.ownerPubkey) {
      ownerStatus = "fail";
      ownerDetail = "owner_only has no resolvable owner";
    }
    if (buzz.authTag) {
      const tag = parseOwnerAuthTag(buzz.authTag)!;
      if (buzz.ownerPubkey && tag[1] !== buzz.ownerPubkey) {
        ownerStatus = "fail";
        ownerDetail = "auth-tag owner does not match configured owner";
      }
    }
    checks.push({
      id: "C019",
      status: ownerStatus,
      detail: `Buzz endpoint '${endpoint.id}': ${ownerDetail}`,
    });

    if (!probeRelay) {
      const skipReason = explicitPublisherProbeRequested
        ? "is not the requested publisher endpoint"
        : "is disabled";
      checks.push({
        id: "C018",
        status: "skip",
        detail: `Buzz endpoint '${endpoint.id}' ${skipReason}; relay auth not probed`,
      });
      checks.push({
        id: "C020",
        status: "skip",
        detail: `Buzz endpoint '${endpoint.id}' ${skipReason}; membership not discovered`,
      });
    } else {
      try {
        const probe = await (opts.buzzProbe ?? probeBuzzEndpoint)({
          endpoint,
          normalized: opts.normalized!,
        });
        const destinationPresent = explicitPublisherProbe
          ? probe.channels.includes(
              requestedPublisher!.destinationConversationId,
            )
          : probe.channels.length > 0;
        checks.push({
          id: "C018",
          status: "ok",
          detail: `Buzz endpoint '${endpoint.id}': relay authentication succeeded${explicitPublisherProbe ? " for disabled publisher probe" : ""}`,
        });
        checks.push({
          id: "C020",
          status: destinationPresent
            ? "ok"
            : explicitPublisherProbe
              ? "fail"
              : "warn",
          detail: explicitPublisherProbe
            ? `Buzz publisher '${requestedPublisher!.id}': configured destination ${requestedPublisher!.destinationConversationId} ${destinationPresent ? "is" : "is not"} in authenticated membership`
            : `Buzz endpoint '${endpoint.id}': discovered ${probe.channels.length} accessible channel(s)`,
        });
        if (explicitPublisherProbe) {
          checks.push({
            id: "C028",
            status: destinationPresent ? "ok" : "fail",
            detail: `publisher probe '${requestedPublisher!.id}': pinned identity verified by config load, relay authenticated, configured destination membership ${destinationPresent ? "confirmed" : "missing"}; no message published`,
          });
        }
      } catch (error) {
        const detail = redactString(
          error instanceof Error ? error.message : String(error),
        );
        checks.push({
          id: "C018",
          status: "fail",
          detail: `Buzz endpoint '${endpoint.id}': relay authentication failed: ${detail}`,
        });
        checks.push({
          id: "C020",
          status: "fail",
          detail: `Buzz endpoint '${endpoint.id}': membership discovery unavailable because authentication failed`,
        });
        if (explicitPublisherProbe) {
          checks.push({
            id: "C028",
            status: "fail",
            detail: `publisher probe '${requestedPublisher!.id}' failed before membership confirmation; no message published`,
          });
        }
      }
    }

    const tag = buzz.authTag ? parseOwnerAuthTag(buzz.authTag) : undefined;
    const publishAllowed =
      !tag ||
      ownerAuthTagAllowsEvent(tag, {
        kind: BUZZ_KINDS.streamMessageV1,
        created_at: Math.floor(Date.now() / 1000),
      });
    checks.push({
      id: "C021",
      status: publishAllowed ? "ok" : "fail",
      detail: `Buzz endpoint '${endpoint.id}': ${
        publishAllowed
          ? "local signing policy authorizes core message kind 9 (doctor does not publish a message)"
          : "owner auth policy rejects core message kind 9"
      }`,
    });
  }

  if (opts.publisherProbeId && !requestedPublisher) {
    checks.push({
      id: "C028",
      status: "fail",
      detail: `publisher probe '${opts.publisherProbeId}' does not match a configured publisher`,
    });
  }

  for (const [pubkey, count] of sharedIdentities) {
    if (count < 2) continue;
    checks.push({
      id: "C022",
      status: "warn",
      detail: `${count} Buzz endpoints share identity ${pubkey.slice(0, 12)}…; self-event rejection and ordering are process-wide`,
    });
  }

  if (!opts.normalized?.buzzTools?.length) {
    checks.push({
      id: "C023",
      status: "skip",
      detail: "no tools.buzz policy configured",
    });
  } else {
    for (const tools of opts.normalized.buzzTools) {
      checks.push({
        id: "C023",
        status: tools.exposePrivateKeyToRunner ? "warn" : "ok",
        detail: tools.exposePrivateKeyToRunner
          ? `agent '${tools.agentId}': raw Buzz key exposure is enabled and bypasses broker policy '${tools.policy}'`
          : `agent '${tools.agentId}': tools.buzz policy '${tools.policy}' is enforced by the endpoint-scoped broker; runners receive no raw Buzz credential`,
      });
    }
  }

  const buzzToolsConfigured = Boolean(opts.normalized?.buzzTools?.length);
  if (!buzzToolsConfigured) {
    checks.push({
      id: "C024",
      status: "skip",
      detail: "Buzz CLI compatibility is not required without tools.buzz",
    });
  } else {
    const configuredHash = opts.normalized?.buzzPlatform?.cli_sha256;
    const cliPath = opts.normalized?.buzzPlatform?.cli_path ?? "buzz";
    const cliProbe = opts.buzzCliProbe
      ? opts.buzzCliProbe(cliPath)
      : (() => {
          const path = findExecutable(cliPath);
          return path
            ? {
                path,
                sha256: createHash("sha256")
                  .update(readFileSync(path))
                  .digest("hex"),
              }
            : null;
        })();
    if (!cliProbe) {
      checks.push({
        id: "C024",
        status: "fail",
        detail: `pinned Buzz CLI '${cliPath}' was not found on PATH`,
      });
    } else {
      const actual = cliProbe.sha256;
      checks.push({
        id: "C024",
        status: actual === configuredHash ? "ok" : "fail",
        detail:
          actual === configuredHash
            ? `Buzz CLI ${BUZZ_CLI_PIN.applicationVersion}, broker manifest v${BUZZ_CLI_PIN.manifestSchemaVersion}, and torana-buzz skill protocol v1 are compatible`
            : `Buzz CLI '${cliProbe.path}' checksum does not match platforms.buzz.cli_sha256`,
      });
    }
  }

  // C025 — durable operational backlog. This is intentionally aggregate-only:
  // doctor must diagnose stuck work without printing conversation identifiers
  // or payloads from the database.
  if (!existsSync(config.gateway.db_path!)) {
    checks.push({
      id: "C025",
      status: "skip",
      detail: "database does not exist; operational backlog not inspected",
    });
  } else {
    try {
      const operationalDb = new Database(config.gateway.db_path!, {
        readonly: true,
      });
      try {
        const version = operationalDb.query("PRAGMA user_version").get() as {
          user_version: number;
        };
        if (Number(version.user_version) < 5) {
          checks.push({
            id: "C025",
            status: "skip",
            detail: "schema v5 is required for normalized backlog diagnostics",
          });
        } else {
          const outbox = operationalDb
            .query(
              `SELECT
                 SUM(CASE WHEN status IN ('dead','failed') THEN 1 ELSE 0 END) AS dead,
                 SUM(CASE WHEN status IN ('pending','retrying','in_flight')
                           AND COALESCE(next_attempt_at, created_at) < datetime('now', '-5 minutes')
                          THEN 1 ELSE 0 END) AS stale
               FROM outbox`,
            )
            .get() as { dead: number | null; stale: number | null };
          const sessions = operationalDb
            .query(
              `SELECT COUNT(*) AS count FROM conversation_sessions
               WHERE state IN ('starting','busy')
                 AND COALESCE(last_used_at, started_at) < datetime('now', ?)`,
            )
            .get(`-${config.worker_tuning.turn_timeout_secs} seconds`) as {
            count: number;
          };
          const dead = Number(outbox.dead ?? 0);
          const stale = Number(outbox.stale ?? 0);
          const stuck = Number(sessions.count ?? 0);
          checks.push({
            id: "C025",
            status: dead || stale || stuck ? "warn" : "ok",
            detail: `operational backlog: dead_outbox=${dead}, stale_outbox=${stale}, stuck_sessions=${stuck}`,
          });
        }
      } finally {
        operationalDb.close();
      }
    } catch (error) {
      checks.push({
        id: "C025",
        status: "warn",
        detail: `operational backlog unavailable: ${redactString(error instanceof Error ? error.message : String(error))}`,
      });
    }
  }

  // C026 — platform-neutral alert delivery, with log-only as the safe fallback.
  const alertTarget = opts.normalized?.alertsTarget;
  if (!alertTarget) {
    checks.push({
      id: "C026",
      status: "skip",
      detail: "no alert target configured; alerts use the log-only fallback",
    });
  } else {
    const endpoint = opts.normalized?.endpoints.find(
      (candidate) => candidate.id === alertTarget.endpointId,
    );
    checks.push({
      id: "C026",
      status: endpoint?.enabled ? "ok" : "warn",
      detail: endpoint
        ? `alerts target configured on ${endpoint.platform} endpoint '${endpoint.id}'${endpoint.enabled ? "" : " (disabled)"}`
        : "alerts target endpoint is unavailable",
    });
  }

  // C029 — provisioned Buzz endpoints and the key that can open them. Rows
  // without a usable key are a hard failure, not a warning: the operator
  // believes those agents are deployed, and the gateway will refuse to start.
  if (existsSync(config.gateway.db_path!)) {
    try {
      // A read-only handle on purpose: opening the full GatewayDB emits
      // startup log lines, and doctor's `--format json` output must stay
      // parseable.
      const probe = new Database(config.gateway.db_path!, { readonly: true });
      try {
        const rows = probe
          .query(
            `SELECT endpoint_id, private_key_ciphertext FROM sqlite_master
             JOIN provisioned_endpoints WHERE sqlite_master.type='table'
               AND sqlite_master.name='provisioned_endpoints'`,
          )
          .all() as Array<{
          endpoint_id: string;
          private_key_ciphertext: string;
        }>;
        const keyring = provisioningKeyringFromEnv();
        if (rows.length === 0) {
          checks.push({
            id: "C029",
            status: "skip",
            detail: keyring
              ? "no provisioned Buzz endpoints; provisioning key is configured"
              : "no provisioned Buzz endpoints",
          });
        } else if (!keyring) {
          checks.push({
            id: "C029",
            status: "fail",
            detail: `${rows.length} provisioned Buzz endpoint(s) stored but ${PROVISIONING_KEY_ENV} is not set`,
          });
        } else {
          // `stale` is the number an operator mid-rotation is actually asking
          // for: while it is non-zero, removing the outgoing key destroys those
          // identities. The gateway re-seals at startup, so a non-zero count
          // here means the rotation deploy has not happened yet — or that a row
          // failed to re-seal, which is worth saying out loud rather than
          // leaving as a silently-fine "decrypts".
          let unopenable = 0;
          let stale = 0;
          for (const row of rows) {
            try {
              const opened = openSecretDetailed(
                keyring,
                row.endpoint_id,
                row.private_key_ciphertext,
              );
              if (opened.keyIndex > 0) stale += 1;
            } catch {
              unopenable += 1;
            }
          }
          const keyCount = keyring.all.length;
          checks.push({
            id: "C029",
            status: unopenable > 0 ? "fail" : stale > 0 ? "warn" : "ok",
            detail:
              unopenable > 0
                ? `${unopenable} of ${rows.length} provisioned Buzz endpoint(s) cannot be decrypted with any of the ${keyCount} configured ${PROVISIONING_KEY_ENV} key(s)`
                : stale > 0
                  ? `${stale} of ${rows.length} provisioned Buzz endpoint(s) are still sealed under an outgoing key; redeploy to re-seal before removing it from ${PROVISIONING_KEY_ENV}`
                  : `${rows.length} provisioned Buzz endpoint(s) decrypt with the primary key${keyCount > 1 ? `; the ${keyCount - 1} outgoing key(s) are no longer needed` : ""}`,
          });
        }
      } finally {
        probe.close();
      }
    } catch (error) {
      checks.push({
        id: "C029",
        status: "warn",
        detail: `provisioned endpoints unavailable: ${redactString(error instanceof Error ? error.message : String(error))}`,
      });
    }
  } else {
    checks.push({
      id: "C029",
      status: "skip",
      detail: "database does not exist; provisioned endpoints not inspected",
    });
  }

  // C030..C033 — Desktop-managed (provisioned) agents.
  //
  // All four skip when the gateway has no `provisioning` block, following the
  // C004 precedent: a check that assumes a feature is configured must not fail
  // the majority of deployments that never enable it.
  const provisioning = opts.normalized?.provisioning;
  if (!provisioning) {
    for (const id of ["C030", "C031", "C032", "C033"] as const) {
      checks.push({
        id,
        status: "skip",
        detail: "provisioning is not configured",
      });
    }
  } else {
    // C030 — every allowlisted harness resolves to a real executable. A
    // harness that cannot be spawned is a create that fails at the last step,
    // after the workspace and rows already exist.
    const harnessProblems: string[] = [];
    for (const [name, harness] of Object.entries(provisioning.harnesses)) {
      const cliPath = harness.runner.cli_path;
      const resolved = findExecutable(cliPath);
      if (!resolved) {
        harnessProblems.push(`${name}→${cliPath} (not found)`);
        continue;
      }
      try {
        if (!statSync(resolved).isFile()) {
          harnessProblems.push(`${name}→${resolved} (not a file)`);
        }
      } catch {
        harnessProblems.push(`${name}→${resolved} (unreadable)`);
      }
    }
    const harnessCount = Object.keys(provisioning.harnesses).length;
    checks.push({
      id: "C030",
      status: harnessProblems.length === 0 ? "ok" : "fail",
      detail:
        harnessProblems.length === 0
          ? `${harnessCount} allowlisted harness binar${harnessCount === 1 ? "y" : "ies"} resolve`
          : `unresolvable harness binaries: ${harnessProblems.join(", ")}`,
    });

    if (!existsSync(config.gateway.db_path!)) {
      for (const id of ["C031", "C032", "C033"] as const) {
        checks.push({
          id,
          status: "skip",
          detail: "database does not exist; provisioned agents not inspected",
        });
      }
    } else {
      try {
        const probe = new Database(config.gateway.db_path!, { readonly: true });
        try {
          const hasTable = (name: string): boolean =>
            probe
              .query(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
              )
              .get(name) !== null;

          if (!hasTable("provisioned_agents")) {
            // Pre-v8 database: the migration has not run yet. That is a
            // pending-migration condition, which C003 already reports.
            for (const id of ["C031", "C032", "C033"] as const) {
              checks.push({
                id,
                status: "skip",
                detail: "schema predates provisioned agents (pre-v8)",
              });
            }
          } else {
            const agents = probe
              .query(
                `SELECT agent_id, harness, lifecycle, purge_deadline
                   FROM provisioned_agents`,
              )
              .all() as Array<{
              agent_id: string;
              harness: string;
              lifecycle: string;
              purge_deadline: string | null;
            }>;

            // C031 — each row still projects: its harness is allowlisted, and
            // its workspace survived whatever happened to the volume.
            if (agents.length === 0) {
              checks.push({
                id: "C031",
                status: "skip",
                detail: "no provisioned agents",
              });
            } else {
              const problems: string[] = [];
              for (const row of agents) {
                if (!(row.harness in provisioning.harnesses)) {
                  problems.push(
                    `${row.agent_id}→harness '${row.harness}' is no longer allowlisted`,
                  );
                }
                const workspace = resolve(
                  config.gateway.data_dir,
                  "workspaces",
                  row.agent_id,
                );
                if (!existsSync(workspace)) {
                  problems.push(`${row.agent_id}→workspace missing`);
                }
              }
              checks.push({
                id: "C031",
                status: problems.length === 0 ? "ok" : "fail",
                detail:
                  problems.length === 0
                    ? `${agents.length} provisioned agent(s) resolve their harness and workspace`
                    : `provisioned agent problems: ${problems.join(", ")}`,
              });
            }

            // C032 — tombstone cursors must not be ahead of the clock. A
            // future cursor silently narrows every backfill window, so a
            // missed tombstone would never be recovered (R5.10).
            if (!hasTable("buzz_tombstone_cursors")) {
              checks.push({
                id: "C032",
                status: "skip",
                detail: "schema predates tombstone cursors",
              });
            } else {
              const cursors = probe
                .query(
                  "SELECT relay_url, last_created_at FROM buzz_tombstone_cursors",
                )
                .all() as Array<{
                relay_url: string;
                last_created_at: number;
              }>;
              const nowSecs = Math.floor(Date.now() / 1000);
              const skewed = cursors.filter(
                (row) => row.last_created_at > nowSecs + 300,
              );
              if (cursors.length === 0) {
                checks.push({
                  id: "C032",
                  status: "skip",
                  detail: "no tombstone cursors recorded yet",
                });
              } else {
                checks.push({
                  id: "C032",
                  status: skewed.length === 0 ? "ok" : "warn",
                  detail:
                    skewed.length === 0
                      ? `${cursors.length} tombstone cursor(s) within the clock`
                      : `${skewed.length} tombstone cursor(s) are ahead of the local clock and will narrow backfill: ${skewed
                          .map((row) => redactString(row.relay_url))
                          .join(", ")}`,
                });
              }
            }

            // C033 — staged deletions are surfaced with their deadlines, so
            // the grace window is something an operator can see rather than
            // something that quietly expires.
            const staged = agents.filter(
              (row) => row.lifecycle === "staged_delete",
            );
            if (staged.length === 0) {
              checks.push({
                id: "C033",
                status: "ok",
                detail: "no staged deletions pending",
              });
            } else {
              checks.push({
                id: "C033",
                status: "warn",
                detail: `staged deletion(s) awaiting purge: ${staged
                  .map((row) => `${row.agent_id}@${row.purge_deadline ?? "?"}`)
                  .join(", ")}`,
              });
            }
          }
        } finally {
          probe.close();
        }
      } catch (error) {
        for (const id of ["C031", "C032", "C033"] as const) {
          checks.push({
            id,
            status: "warn",
            detail: `provisioned agents unavailable: ${redactString(error instanceof Error ? error.message : String(error))}`,
          });
        }
      }
    }
  }

  // C027 — hard shutdown budget must cover the two bounded drain windows.
  const orderlyBudget =
    config.shutdown.outbox_drain_secs + config.shutdown.runner_grace_secs;
  checks.push({
    id: "C027",
    status: config.shutdown.hard_timeout_secs >= orderlyBudget ? "ok" : "warn",
    detail: `shutdown budget: hard=${config.shutdown.hard_timeout_secs}s, outbox+runner=${orderlyBudget}s`,
  });

  return { checks };
}

function findExecutable(input: string): string | null {
  if (isAbsolute(input)) return existsSync(input) ? input : null;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, input);
    if (existsSync(candidate)) return candidate;
  }
  return null;
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

  async function withTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
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
