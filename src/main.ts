// Runtime entry point: wires config → logger → DB → clients → streaming/outbox
// → bots → transports → server, then runs until shut down.

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { Config } from "./config/schema.js";
import { logger, setLogLevel, setLogFormat, setSecrets, autoFormat } from "./log.js";
import { GatewayDB } from "./db/gateway-db.js";
import { applyMigrations } from "./db/migrate.js";
import { TelegramClient } from "./telegram/client.js";
import { Metrics } from "./metrics.js";
import { AlertManager } from "./alerts.js";
import { OutboxProcessor } from "./outbox.js";
import { StreamManager } from "./streaming.js";
import { Bot } from "./core/bot.js";
import { BotRegistry } from "./core/registry.js";
import { createServer, type Server } from "./server.js";
import { WebhookTransport } from "./transport/webhook.js";
import { PollingTransport } from "./transport/polling.js";
import type { Transport } from "./transport/types.js";

const log = logger("main");

export interface StartOptions {
  config: Config;
  secrets: string[];
  autoMigrate?: boolean;
}

export interface RunningGateway {
  server: Server;
  registry: BotRegistry;
  transports: Transport[];
  shutdown(signal: string): Promise<void>;
}

export async function startGateway(opts: StartOptions): Promise<RunningGateway> {
  const { config } = opts;
  setLogLevel(config.gateway.log_level);
  setLogFormat(config.gateway.log_format ?? autoFormat());
  setSecrets(opts.secrets);

  log.info("torana starting", {
    bots: config.bots.map((b) => b.id),
    transport: config.transport.default_mode,
  });

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
  const outbox = new OutboxProcessor(config, db, clients, metrics);
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
  const server = createServer({ port: config.gateway.port });
  registerFixedRoutes(server, config, db, metrics, registry);

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
      }),
    );
  }
  if (pollingClients.size > 0) {
    transports.push(
      new PollingTransport({ config, db, clients: pollingClients }),
    );
  }

  for (const t of transports) {
    await t.start((botId, update) => registry.handleUpdate(botId, update).then(() => {}));
  }

  outbox.start();
  await registry.startAll();

  // Periodic mailbox-backlog alert.
  const backlogTimer = setInterval(() => {
    for (const botId of registry.botIds) {
      const depth = db.getMailboxDepth(botId);
      if (depth >= 5) void alerts.mailboxBacklog(botId, depth);
    }
  }, 30_000);

  const running: RunningGateway = {
    server,
    registry,
    transports,
    async shutdown(signal: string) {
      log.info("shutting down", { signal });
      clearInterval(backlogTimer);
      await Promise.all(transports.map((t) => t.stop()));
      outbox.stop();
      streaming.stopAll();
      await registry.stopAll();
      await server.stop();
      db.close();
      log.info("shutdown complete");
    },
  };
  log.info("torana ready", { port: server.port });
  return running;
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
    server.router.route("GET", `${mountPath}/*`, async (req) => {
      const url = new URL(req.url);
      const rel = url.pathname.slice(mountPath.length) || "/";
      const backendUrl = `${target}${rel}${url.search}`;
      try {
        const proxyReq = new Request(backendUrl, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });
        return await fetch(proxyReq);
      } catch {
        return new Response("Dashboard unavailable", { status: 502 });
      }
    });
  }
}

function runCrashRecovery(
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
        void client.editMessageText(turn.chat_id, ss.active_telegram_message_id, display).catch(() => {});
      }
    }
    if (!turn.first_output_at) {
      log.info("re-queueing orphaned turn", { turn_id: turn.id, bot_id: turn.bot_id });
      db.requeueTurn(turn.id);
      db.cancelPendingOutboxForTurn(turn.id);
    } else {
      log.info("marking orphaned turn interrupted", {
        turn_id: turn.id,
        bot_id: turn.bot_id,
      });
      db.interruptTurn(turn.id, "Gateway restarted during active turn");
      const client = clients.get(turn.bot_id);
      if (client) {
        void client.sendMessage(
          turn.chat_id,
          "\u26a0\ufe0f Gateway restarted during an active turn. The previous response may be incomplete.",
        );
      }
    }
  }

  const pending = db.getPendingOutbox();
  for (const row of pending) {
    if (row.kind === "edit" && db.hasSupersedingEdit(row.telegram_message_id, row.id)) {
      db.markOutboxFailed(row.id, "superseded by later send");
    }
  }

  db.resetAllWorkerStates();
  log.info("crash recovery complete", {
    orphaned_turns: running.length,
    pending_outbox: pending.length,
  });
}
