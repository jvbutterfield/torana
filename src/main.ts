// Runtime entry point: wires config → logger → DB → clients → streaming/outbox
// → bots → transports → server, then runs until shut down.

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { Config } from "./config/schema.js";
import type { ResolvedAgentApiToken } from "./config/load.js";
import {
  logger,
  setLogLevel,
  setLogFormat,
  setSecrets,
  autoFormat,
} from "./log.js";
import { GatewayDB } from "./db/gateway-db.js";
import { applyMigrations } from "./db/migrate.js";
import { TelegramClient } from "./telegram/client.js";
import { Metrics } from "./metrics.js";
import { AlertManager } from "./alerts.js";
import { OutboxProcessor } from "./outbox.js";
import { StreamManager } from "./streaming.js";
import { Bot } from "./core/bot.js";
import { BotRegistry } from "./core/registry.js";
import { sweepExpiredAttachments } from "./core/attachments.js";
import { sweepUnreferencedAgentApiFiles } from "./agent-api/attachments.js";
import { createServer, type Server } from "./server.js";
import { WebhookTransport } from "./transport/webhook.js";
import { PollingTransport } from "./transport/polling.js";
import type { HttpMethod, Transport, Unregister } from "./transport/types.js";
import {
  registerAgentApiHealthRoute,
  registerAgentApiRoutes,
} from "./agent-api/router.js";
import { SideSessionPool } from "./agent-api/pool.js";
import { OrphanListenerManager } from "./agent-api/orphan-listeners.js";

const log = logger("main");

export interface StartOptions {
  config: Config;
  secrets: string[];
  autoMigrate?: boolean;
  /** Resolved agent-api tokens from load.ts — empty when the feature is disabled. */
  agentApiTokens?: ResolvedAgentApiToken[];
}

export interface RunningGateway {
  server: Server;
  registry: BotRegistry;
  transports: Transport[];
  shutdown(signal: string): Promise<void>;
}

export async function startGateway(
  opts: StartOptions,
): Promise<RunningGateway> {
  const { config } = opts;
  setLogLevel(config.gateway.log_level);
  setLogFormat(config.gateway.log_format ?? autoFormat());
  setSecrets(opts.secrets);

  log.info("torana starting", {
    bots: config.bots.map((b) => b.id),
    transport: config.transport.default_mode,
  });

  warnOnEmptyAcl(config);
  warnOnYoloCodexBots(config);

  await ensureDirectories(config);

  // Apply migrations (if opts.autoMigrate or DB doesn't exist).
  const dbPath = config.gateway.db_path!;
  if (opts.autoMigrate) {
    applyMigrations(dbPath, { snapshotV0Upgrade: true });
  } else {
    // Lightly check: if DB needs migration and autoMigrate not set, fail loudly.
    const { planMigration } = await import("./db/migrate.js");
    const plan = planMigration(dbPath);
    if (plan.steps.length > 0) {
      throw new Error(
        `database schema is not current (from=${plan.currentVersion} to=${plan.targetVersion}).\n` +
          `Run 'torana migrate --config <path>' first, or pass --auto-migrate.`,
      );
    }
  }

  const db = new GatewayDB(dbPath);
  const metrics = new Metrics(config);

  const clients = new Map<string, TelegramClient>();
  for (const bot of config.bots) {
    clients.set(
      bot.id,
      new TelegramClient({
        botId: bot.id,
        token: bot.token,
        apiBaseUrl: config.telegram.api_base_url,
      }),
    );
  }

  const alerts = new AlertManager(config, clients);
  const outbox = new OutboxProcessor(config, db, clients, metrics, alerts);
  const streaming = new StreamManager(config, db, outbox, clients);

  // Build Bot instances.
  const bots: Bot[] = config.bots.map(
    (botConfig) =>
      new Bot({
        config,
        botConfig,
        db,
        telegram: clients.get(botConfig.id)!,
        streaming,
        outbox,
        metrics,
        alerts,
      }),
  );

  const registry = new BotRegistry({
    config,
    db,
    bots,
    clients,
    streaming,
    outbox,
    metrics,
    alerts,
  });

  // Crash recovery.
  runCrashRecovery(db, clients);

  // HTTP server + router.
  const server = createServer({
    port: config.gateway.port,
    hostname: config.gateway.bind_host,
  });
  registerFixedRoutes(server, config, db, metrics, registry);

  // /v1/health is always available — operators need to confirm the binary
  // has agent-api support even when the feature is disabled.
  registerAgentApiHealthRoute(server.router, {
    config,
    uptimeSecs: () => metrics.uptimeSecs(),
  });

  const agentApiUnregs: Unregister[] = [];
  let agentApiPool: SideSessionPool | null = null;
  let agentApiOrphans: OrphanListenerManager | null = null;
  let agentApiIdempotencySweep: ReturnType<typeof setInterval> | null = null;
  if (config.agent_api?.enabled) {
    const tokens = opts.agentApiTokens ?? [];
    agentApiPool = new SideSessionPool({ config, db, registry, metrics });
    agentApiOrphans = new OrphanListenerManager(db, agentApiPool, metrics);
    agentApiPool.startSweeper();
    agentApiUnregs.push(
      ...registerAgentApiRoutes(server.router, {
        config,
        db,
        registry,
        tokens,
        log: logger("agent-api"),
        metrics,
        pool: agentApiPool,
        orphans: agentApiOrphans,
      }),
    );
    const retention = config.agent_api.send.idempotency_retention_ms;
    agentApiIdempotencySweep = setInterval(
      () => {
        try {
          db.sweepIdempotency(Date.now() - retention);
        } catch (err) {
          log.warn("idempotency sweep failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
      60 * 60 * 1000,
    );
    (agentApiIdempotencySweep as unknown as { unref?: () => void }).unref?.();
    log.info("agent_api routes registered", { tokens: tokens.length });
  }

  // Transports.
  const webhookClients = new Map<string, TelegramClient>();
  const pollingClients = new Map<string, TelegramClient>();
  for (const bot of config.bots) {
    const mode = bot.transport_override?.mode ?? config.transport.default_mode;
    const c = clients.get(bot.id)!;
    if (mode === "webhook") webhookClients.set(bot.id, c);
    else pollingClients.set(bot.id, c);
  }

  const transports: Transport[] = [];
  if (webhookClients.size > 0) {
    transports.push(
      new WebhookTransport({
        config,
        router: server.router,
        db,
        clients: webhookClients,
        alerts,
      }),
    );
  }
  if (pollingClients.size > 0) {
    transports.push(
      new PollingTransport({ config, db, clients: pollingClients }),
    );
  }

  await Promise.all(
    transports.map((t) =>
      t.start((botId, update) =>
        registry.handleUpdate(botId, update).then(() => {}),
      ),
    ),
  );

  // Surface any outbox rows left in `in_flight` by a previous process
  // crash. These auto-retry via the grace window in getPendingOutbox; the
  // log line just makes the dup-risk visible.
  outbox.recoverInFlight();
  outbox.start();
  await registry.startAll();

  // Periodic mailbox-backlog alert.
  const backlogTimer = setInterval(() => {
    for (const botId of registry.botIds) {
      const depth = db.getMailboxDepth(botId);
      if (depth >= 5) void alerts.mailboxBacklog(botId, depth);
    }
  }, 30_000);

  // Periodic attachment sweeper — delete files for completed turns older
  // than config.attachments.retention_secs. Bounded at 500 turns per tick.
  // Runs hourly; retention default is 24h so even a large backlog clears
  // within a day without spiking I/O.
  const runSweeper = async (): Promise<void> => {
    try {
      const result = await sweepExpiredAttachments(
        db,
        config.gateway.data_dir,
        config.attachments.retention_secs,
      );
      if (result.turns > 0) {
        log.info("attachment sweeper", {
          turns: result.turns,
          files: result.files,
        });
      }
    } catch (err) {
      log.warn("attachment sweeper failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  // Run once at startup to clear anything left over from the prior process,
  // then on a fixed cadence.
  void runSweeper();
  const attachmentSweeperTimer = setInterval(
    () => void runSweeper(),
    60 * 60 * 1000,
  );

  // Agent-API orphan-file sweep: catches the crash window between a
  // multipart write and the DB commit. Only relevant when agent-api is
  // enabled; we still schedule the timer so an operator toggling the
  // flag at runtime isn't surprised by a build-up.
  const runOrphanSweep = async (): Promise<void> => {
    if (!config.agent_api?.enabled) return;
    try {
      const result = await sweepUnreferencedAgentApiFiles(
        db,
        config.gateway.data_dir,
        24 * 60 * 60 * 1000,
      );
      if (result.deleted > 0) {
        log.info("agent-api orphan sweep", result);
      }
    } catch (err) {
      log.warn("agent-api orphan sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const orphanSweeperTimer = setInterval(
    () => void runOrphanSweep(),
    60 * 60 * 1000,
  );
  (orphanSweeperTimer as unknown as { unref?: () => void }).unref?.();

  let shutdownStarted = false;
  const running: RunningGateway = {
    server,
    registry,
    transports,
    async shutdown(signal: string) {
      if (shutdownStarted) return;
      shutdownStarted = true;
      log.info("shutting down", { signal });

      const deadline = Date.now() + config.shutdown.hard_timeout_secs * 1000;

      // Hard-cutoff watchdog: if the orderly path hangs, exit 1.
      const hardTimer = setTimeout(() => {
        log.error("shutdown hard timeout — forcing exit", {
          hard_timeout_secs: config.shutdown.hard_timeout_secs,
        });
        process.exit(1);
      }, config.shutdown.hard_timeout_secs * 1000);
      // Don't let the watchdog itself keep the process alive.
      (hardTimer as unknown as { unref?: () => void }).unref?.();

      try {
        clearInterval(backlogTimer);
        clearInterval(attachmentSweeperTimer);
        clearInterval(orphanSweeperTimer);
        if (agentApiIdempotencySweep) clearInterval(agentApiIdempotencySweep);

        // Unregister agent-api routes so new calls 404 before we tear down.
        for (const u of agentApiUnregs) {
          try {
            u();
          } catch {
            /* best-effort */
          }
        }

        // 1. Stop accepting new updates.
        await Promise.all(transports.map((t) => t.stop()));

        // 2. Drain outbox up to shutdown.outbox_drain_secs.
        const drainBudgetMs = Math.max(
          0,
          Math.min(
            config.shutdown.outbox_drain_secs * 1000,
            deadline - Date.now(),
          ),
        );
        await outbox.drain(drainBudgetMs);
        outbox.stop();

        streaming.stopAll();

        // 3a. Tear down agent-api side sessions before the main runners
        //     so ask handlers observe fatal events rather than hangs.
        const runnerGraceMs = config.shutdown.runner_grace_secs * 1000;
        if (agentApiOrphans) agentApiOrphans.shutdown();
        if (agentApiPool) await agentApiPool.shutdown(runnerGraceMs);

        // 3. Stop main runners with per-runner grace.
        await registry.stopAll(runnerGraceMs);

        // 4. Server + DB.
        await server.stop();
        db.close();
      } finally {
        clearTimeout(hardTimer);
      }
      log.info("shutdown complete");
    },
  };
  log.info("torana ready", { port: server.port });
  return running;
}

export function warnOnEmptyAcl(config: Config): void {
  const globalEmpty = config.access_control.allowed_user_ids.length === 0;
  const affectedBots = config.bots
    .filter((b) => {
      const override = b.access_control?.allowed_user_ids;
      return override ? override.length === 0 : globalEmpty;
    })
    .map((b) => b.id);
  if (affectedBots.length === 0) return;
  if (globalEmpty && affectedBots.length === config.bots.length) {
    log.warn(
      "access_control.allowed_user_ids is empty — all inbound messages will be rejected. Add your Telegram user id(s) to allow traffic.",
    );
  } else {
    log.warn(
      "access_control.allowed_user_ids is empty for some bots — inbound messages to those bots will be rejected. Add user id(s) to allow traffic.",
      { bots: affectedBots },
    );
  }
}

export function warnOnYoloCodexBots(config: Config): void {
  const bots = config.bots
    .filter(
      (b) => b.runner.type === "codex" && b.runner.approval_mode === "yolo",
    )
    .map((b) => b.id);
  if (bots.length === 0) return;
  log.warn(
    "codex approval_mode='yolo' bypasses all sandboxing — only run inside an externally hardened environment (container, VM, isolated user account).",
    { bots },
  );
}

export async function ensureDirectories(config: Config): Promise<void> {
  const dataDir = config.gateway.data_dir;
  await mkdir(dataDir, { recursive: true });
  await mkdir(resolve(dataDir, "logs"), { recursive: true });
  await mkdir(resolve(dataDir, "attachments"), { recursive: true });
  for (const bot of config.bots) {
    await mkdir(resolve(dataDir, "attachments", bot.id), { recursive: true });
    await mkdir(resolve(dataDir, "state", bot.id), { recursive: true });
  }
}

function registerFixedRoutes(
  server: Server,
  config: Config,
  db: GatewayDB,
  metrics: Metrics,
  registry: BotRegistry,
): void {
  server.router.route("GET", "/health", async () => {
    const bots: Record<string, unknown> = {};
    let ok = true;
    for (const botId of registry.botIds) {
      const bot = registry.bot(botId)!;
      const snap = registry.snapshotFor(bot);
      bots[botId] = snap;
      if (!snap.runner_ready) ok = false;
    }
    return new Response(
      JSON.stringify({
        status: ok ? "ok" : "degraded",
        bots,
        uptime_secs: metrics.uptimeSecs(),
      }),
      {
        status: ok ? 200 : 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  });

  if (config.metrics.enabled) {
    server.router.route("GET", "/metrics", async () => {
      const botStates: Record<string, number> = {};
      for (const botId of registry.botIds) {
        const bot = registry.bot(botId)!;
        const snap = registry.snapshotFor(bot);
        botStates[botId] = snap.disabled ? 0 : snap.runner_ready ? 2 : 1;
      }
      const body = metrics.renderPrometheus(botStates);
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/plain; version=0.0.4" },
      });
    });
  }

  if (config.dashboard.enabled && config.dashboard.proxy_target) {
    const mountPath = config.dashboard.mount_path.replace(/\/+$/, "");
    const target = config.dashboard.proxy_target.replace(/\/$/, "");
    const forwardFull = config.dashboard.forward_full_request;

    // Default mode: GET-only, Authorization/Cookie stripped — safe for a
    // dashboard with no auth of its own. forward_full_request mode: all
    // standard methods + auth headers preserved, for dashboards that own
    // their own auth (login, session cookies, mutating actions). The
    // operator opts in via dashboard.forward_full_request; see schema.ts
    // for the trust assertion that flag implies.
    const handler = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const rel = url.pathname.slice(mountPath.length) || "/";
      const backendUrl = `${target}${rel}${url.search}`;

      // Strip hop-by-hop and sensitive request headers before forwarding:
      //   - Authorization, Cookie: stripped in default mode to avoid
      //     leaking Agent-API bearer tokens or browser session cookies to
      //     a dashboard that doesn't own its auth. In forward_full_request
      //     mode the operator has asserted the upstream owns auth, so we
      //     pass them through.
      //   - Proxy-Authorization, Idempotency-Key,
      //     X-Telegram-Bot-Api-Secret-Token: torana-internal or hop-by-hop
      //     secrets the dashboard must never see; stripped regardless of
      //     mode.
      //   - Host: the fetch() rewrites this correctly; copying the gateway's
      //     Host to the backend confuses virtual-hosted upstreams.
      // Retain everything else so request routing + Accept/Accept-Language
      // still work for the dashboard UI.
      const forwardedHeaders = new Headers(req.headers);
      const stripList = [
        "proxy-authorization",
        "idempotency-key",
        "x-telegram-bot-api-secret-token",
        "host",
      ];
      if (!forwardFull) {
        stripList.push("authorization", "cookie");
      }
      for (const h of stripList) {
        forwardedHeaders.delete(h);
      }

      try {
        // - redirect: "manual" stops fetch from following a backend Location:
        //   header. Without this the proxy can be used as an open redirect
        //   / SSRF stepping-stone into anywhere the gateway host can reach.
        //   Kept regardless of forward_full_request.
        const proxyReq = new Request(backendUrl, {
          method: req.method,
          headers: forwardedHeaders,
          body: req.body,
          redirect: "manual",
        });
        return await fetch(proxyReq);
      } catch {
        return new Response("Dashboard unavailable", { status: 502 });
      }
    };

    const methods: HttpMethod[] = forwardFull
      ? ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]
      : ["GET"];
    for (const m of methods) {
      server.router.route(m, `${mountPath}/*`, handler);
    }
  }
}

export function runCrashRecovery(
  db: GatewayDB,
  clients: Map<string, TelegramClient>,
): void {
  log.info("running crash recovery");
  const running = db.getRunningTurns();
  for (const turn of running) {
    const ss = db.getStreamState(turn.id);
    if (ss?.active_telegram_message_id) {
      const client = clients.get(turn.bot_id);
      if (client) {
        const display = ss.buffer_text?.trim() || "(restarted)";
        void client
          .editMessageText(turn.chat_id, ss.active_telegram_message_id, display)
          .catch(() => {});
      }
    }
    if (!turn.first_output_at) {
      log.info("re-queueing orphaned turn", {
        turn_id: turn.id,
        bot_id: turn.bot_id,
      });
      db.requeueTurn(turn.id);
      db.cancelPendingOutboxForTurn(turn.id);
    } else {
      log.info("marking orphaned turn interrupted", {
        turn_id: turn.id,
        bot_id: turn.bot_id,
        source: turn.source ?? null,
      });
      db.interruptTurn(turn.id, "Gateway restarted during active turn");

      // For Agent-API-originated turns (ask / send), the end user in the
      // Telegram chat never initiated anything — the external agent did,
      // and it polls /v1/turns/:id for the outcome. Sending a "Gateway
      // restarted …" message into the user's DM leaks the existence of
      // a backend job the user has no context for. Skip the notify on
      // agent_api_* turns; the polling caller sees the `failed` /
      // `interrupted_by_gateway_restart` status.
      const isAgentApi =
        turn.source === "agent_api_send" || turn.source === "agent_api_ask";
      if (!isAgentApi) {
        const client = clients.get(turn.bot_id);
        if (client) {
          void client.sendMessage(
            turn.chat_id,
            "\u26a0\ufe0f Gateway restarted during an active turn. The previous response may be incomplete.",
          );
        }
      }
    }
  }

  const pending = db.getPendingOutbox();
  for (const row of pending) {
    if (
      row.kind === "edit" &&
      db.hasSupersedingEdit(row.telegram_message_id, row.id)
    ) {
      db.markOutboxFailed(row.id, "superseded by later send");
    }
  }

  db.resetAllWorkerStates();
  log.info("crash recovery complete", {
    orphaned_turns: running.length,
    pending_outbox: pending.length,
  });
}
