// Runtime entry point: wires config → logger → DB → clients → streaming/outbox
// → bots → transports → server, then runs until shut down.

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { Config } from "./config/schema.js";
import type {
  ResolvedAgentApiToken,
  ResolvedPublisherApiToken,
} from "./config/load.js";
import {
  normalizedV1Model,
  type ConfigV2,
  type NormalizedConfigModel,
  type NormalizedEndpointConfig,
} from "./config/v2.js";
import { BuzzProvisioningService } from "./platform/buzz/provisioning.js";
import { BuzzAgentLifecycleService } from "./platform/buzz/agent-lifecycle.js";
import { TombstoneWatcher } from "./platform/buzz/tombstone-watcher.js";
import { AgentTimeoutRegistry } from "./platform/buzz/agent-timeouts.js";
import { provisioningKeyFromEnv } from "./config/provisioning-secrets.js";
import {
  logger,
  setLogLevel,
  setLogFormat,
  setSecrets,
  autoFormat,
  redactString,
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
import type { PlatformAdapter } from "./platform/capabilities.js";
import { TelegramAdapter } from "./platform/telegram/adapter.js";
import { ConversationScheduler } from "./conversation/scheduler.js";
import { BuzzAdapter } from "./platform/buzz/adapter.js";
import {
  BuzzTransport,
  type BuzzEndpointHealth,
} from "./platform/buzz/transport.js";
import { BuzzCredentialBroker } from "./broker/buzz-broker.js";
import { DataDirLock } from "./data-dir-lock.js";
import { PublisherService } from "./publisher/service.js";
import { registerPublisherRoutes } from "./publisher/router.js";

const log = logger("main");

export interface StartOptions {
  config: Config;
  secrets: string[];
  autoMigrate?: boolean;
  /** Resolved agent-api tokens from load.ts — empty when the feature is disabled. */
  agentApiTokens?: ResolvedAgentApiToken[];
  publisherApiTokens?: ResolvedPublisherApiToken[];
  /** Platform-neutral endpoint/session metadata from either config version. */
  normalized?: NormalizedConfigModel;
  /**
   * The parsed v2 config. Required for runtime endpoint provisioning, which
   * re-validates its rows by merging them into this object and running the
   * same schema the YAML went through.
   */
  configV2?: ConfigV2 | null;
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
  const normalized = opts.normalized ?? normalizedV1Model(config);
  setLogLevel(config.gateway.log_level);
  setLogFormat(config.gateway.log_format ?? autoFormat());
  setSecrets(opts.secrets);

  log.info("torana starting", {
    bots: config.bots.map((b) => b.id),
    transport: config.transport.default_mode,
  });

  warnOnEmptyAcl(config, normalized);
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
    const bridgeOnV3 =
      normalized.sourceVersion === 1 && plan.currentVersion === 3;
    if (plan.steps.length > 0 && !bridgeOnV3) {
      throw new Error(
        `database schema is not current (from=${plan.currentVersion} to=${plan.targetVersion}).\n` +
          `Run 'torana migrate --config <path>' first, or pass --auto-migrate.`,
      );
    }
    if (bridgeOnV3) {
      log.warn(
        "running the compatibility bridge on schema v3; use 'torana migrate --to 6' during the maintenance window",
      );
    }
  }

  const db = new GatewayDB(dbPath);
  db.syncNormalizedConfig(normalized);
  const metrics = new Metrics(config);

  const clients = new Map<string, TelegramClient>();
  const telegramAgents = new Set(
    normalized.endpoints
      .filter((endpoint) => endpoint.platform === "telegram")
      .map((endpoint) => endpoint.agentId),
  );
  for (const bot of config.bots) {
    if (!telegramAgents.has(bot.id)) continue;
    clients.set(
      bot.id,
      new TelegramClient({
        botId: bot.id,
        token: bot.token,
        apiBaseUrl: config.telegram.api_base_url,
      }),
    );
  }

  const adapters = new Map<string, PlatformAdapter>();
  for (const [botId, client] of clients) {
    const adapter = new TelegramAdapter(
      db.getEndpointId(botId, "telegram"),
      client,
      botId,
    );
    // Agent-id aliases preserve the v1 transport/runtime contract; endpoint
    // ids are authoritative for normalized outbox delivery.
    adapters.set(botId, adapter);
    adapters.set(adapter.endpoint.id, adapter);
  }
  for (const endpoint of normalized.endpoints) {
    if (endpoint.platform !== "buzz" || !endpoint.buzz) continue;
    adapters.set(endpoint.id, new BuzzAdapter(endpoint));
  }

  const alerts = new AlertManager(config, adapters, normalized);
  const outbox = new OutboxProcessor(config, db, adapters, metrics, alerts, {
    normalized,
  });
  const streaming = new StreamManager(config, db, outbox, adapters, normalized);
  const buzzBroker = new BuzzCredentialBroker({ config, normalized });

  // Build Bot instances.
  const bots: Bot[] = config.bots.map((botConfig) => {
    const endpoint =
      adapters.get(botConfig.id) ??
      normalized.endpoints
        .filter((candidate) => candidate.agentId === botConfig.id)
        .map((candidate) => adapters.get(candidate.id))
        .find((candidate): candidate is PlatformAdapter => !!candidate);
    if (!endpoint) {
      throw new Error(`agent '${botConfig.id}' has no messaging endpoint`);
    }
    return new Bot({
      config,
      botConfig,
      db,
      endpoint,
      streaming,
      outbox,
      metrics,
      alerts,
      buzzBroker,
    });
  });

  const registry = new BotRegistry({
    config,
    db,
    bots,
    adapters,
    streaming,
    outbox,
    metrics,
    alerts,
    buzzBroker,
  });

  // Written by the provisioning service on create and restore, read by the
  // scheduler on every dispatch. Constructed here because the scheduler is
  // built before provisioning is.
  const agentTimeouts = new AgentTimeoutRegistry();

  // The promoted session manager is shared by normalized platform traffic
  // and the Agent API. V1 configurations keep the legacy one-runner path.
  const sessionManager = new SideSessionPool({
    config,
    db,
    registry,
    metrics,
    contextRetentionMs: normalized.sessions.context_retention_ms,
  });
  sessionManager.startSweeper();
  if (normalized.sourceVersion === 2) {
    registry.setConversationScheduler(
      new ConversationScheduler({
        db,
        registry,
        manager: sessionManager,
        normalized,
        workerTuning: config.worker_tuning,
        alerts,
        agentTimeouts,
      }),
    );
  }

  // Crash recovery.
  runCrashRecovery(db, adapters, normalized.sourceVersion === 2);

  // HTTP server + router.
  const server = createServer({
    port: config.gateway.port,
    hostname: config.gateway.bind_host,
  });
  let buzzTransport: BuzzTransport | null = null;
  registerFixedRoutes(
    server,
    config,
    db,
    metrics,
    registry,
    () => buzzTransport?.snapshots() ?? [],
  );

  // /v1/health is always available — operators need to confirm the binary
  // has agent-api support even when the feature is disabled.
  registerAgentApiHealthRoute(server.router, {
    config,
    uptimeSecs: () => metrics.uptimeSecs(),
  });

  // Provisioning is constructed before the routes that use it and before the
  // Buzz transport that it drives; the transport is attached below, once it
  // exists. Endpoints restored from the database are merged into the endpoint
  // list the transport is built from, so a provisioned endpoint starts exactly
  // like a YAML one.
  const provisioningKey = provisioningKeyFromEnv();
  const provisioning = new BuzzProvisioningService({
    db,
    configV2: opts.configV2 ?? null,
    key: provisioningKey,
    transport: null,
    maxEndpoints: normalized.sessions?.max_global,
    provisioning: normalized.provisioning ?? null,
    dataDir: config.gateway.data_dir,
    agentTimeouts,
    recycleSessions: (agentId, reason) =>
      sessionManager.recycleForBot(agentId, reason),
    // Desktop-managed agents are Bots, and Bots are built here rather than in
    // the provisioning service. The service calls back through this so that a
    // create registers a running agent, and a failed create can deregister it.
    agentRuntime: {
      upsert: ({ botConfig, endpoint }) => {
        registry.upsertProvisionedAgent({
          botConfig,
          endpoint: adapterForProvisionedEndpoint(adapters, endpoint),
        });
      },
      remove: (agentId) => {
        registry.removeProvisionedAgent(agentId);
      },
    },
  });

  // The delete pipeline. Both of these outlive every endpoint supervisor by
  // design: the most likely delete sequence is "stop the agent, then delete
  // it", so a watcher owned by an endpoint would have nothing listening at the
  // moment the tombstone publishes (R5.8).
  let tombstoneWatcher: TombstoneWatcher | null = null;
  const agentLifecycle = new BuzzAgentLifecycleService({
    db,
    dataDir: config.gateway.data_dir,
    provisioning: normalized.provisioning ?? null,
    transport: () => buzzTransport,
    alerts,
    agentTimeouts,
    agentRuntime: {
      remove: (agentId) => registry.removeProvisionedAgent(agentId),
    },
    onFleetChanged: () => tombstoneWatcher?.refresh(),
    probeRecords: (coordinates) =>
      tombstoneWatcher?.probeRecords(coordinates) ?? Promise.resolve(new Map()),
  });

  const persisted = provisioning.loadPersisted();
  for (const error of persisted.errors) {
    log.error("provisioned Buzz endpoint could not be restored", { error });
  }
  if (persisted.errors.length > 0 && persisted.endpoints.length === 0) {
    // Fail closed: an operator who deployed an agent through the provider must
    // not silently get a gateway running without it.
    throw new Error(
      `provisioned Buzz endpoints could not be restored: ${persisted.errors.join("; ")}`,
    );
  }
  if (persisted.endpoints.length > 0) {
    log.info("restored provisioned Buzz endpoints", {
      count: persisted.endpoints.length,
    });
  }

  // Provisioned endpoints need adapters in the shared map, exactly as YAML
  // endpoints get above. The transport would otherwise build a private adapter
  // of its own (`transport.ts` reuses a configured one when it finds it), and
  // everything else that resolves an endpoint through this map — alerts, the
  // outbox, a provisioned agent's Bot — would come up empty.
  for (const endpoint of persisted.endpoints) {
    if (endpoint.platform !== "buzz" || !endpoint.buzz) continue;
    adapterForProvisionedEndpoint(adapters, endpoint);
  }

  // Desktop-managed agents are registered here, before the Buzz transport is
  // built and started below. An agent whose endpoint came up with no Bot
  // behind it would authenticate, announce presence, and then drop every
  // message it received.
  //
  // Each is registered independently: one agent whose harness has been removed
  // from the allowlist must not stop the others from starting. The failures
  // land in the same operator-visible list as endpoint restore errors, and
  // doctor C031 reports the same condition from the row side.
  for (const agent of persisted.agents) {
    try {
      registry.upsertProvisionedAgent({
        botConfig: agent.botConfig,
        endpoint: adapterForProvisionedEndpoint(adapters, agent.endpoint),
      });
    } catch (error) {
      log.error("provisioned agent could not be restored", {
        agent_id: agent.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (persisted.agents.length > 0) {
    log.info("restored Desktop-managed agents", {
      count: persisted.agents.length,
    });
  }

  const agentApiUnregs: Unregister[] = [];
  let agentApiPool: SideSessionPool | null = null;
  let agentApiOrphans: OrphanListenerManager | null = null;
  let agentApiIdempotencySweep: ReturnType<typeof setInterval> | null = null;
  if (config.agent_api?.enabled) {
    const tokens = opts.agentApiTokens ?? [];
    agentApiPool = sessionManager;
    agentApiOrphans = new OrphanListenerManager(db, agentApiPool, metrics);
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
        buzzBroker,
        provisioning,
        agentLifecycle,
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

  const publisherUnregs: Unregister[] = [];
  let publisherRetentionSweep: ReturnType<typeof setInterval> | null = null;
  if (normalized.publisherApi?.enabled) {
    const publisherService = new PublisherService({
      normalized,
      db,
      outbox,
      health: () => buzzTransport?.snapshots() ?? [],
    });
    publisherUnregs.push(
      ...registerPublisherRoutes(server.router, {
        tokens: opts.publisherApiTokens ?? [],
        config: normalized.publisherApi,
        db,
        service: publisherService,
        metrics,
      }),
    );
    const retention = normalized.publisherApi.idempotency_retention_ms;
    publisherRetentionSweep = setInterval(
      () => {
        try {
          db.sweepPublisherRetention(Date.now() - retention);
        } catch (error) {
          log.warn("publisher retention sweep failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      60 * 60 * 1000,
    );
    (publisherRetentionSweep as unknown as { unref?: () => void }).unref?.();
    log.info("publisher_api routes registered", {
      publishers: normalized.publishers?.length ?? 0,
      tokens: opts.publisherApiTokens?.length ?? 0,
    });
  }

  // Transports.
  const webhookClients = new Map<string, TelegramClient>();
  const pollingClients = new Map<string, TelegramClient>();
  for (const bot of config.bots) {
    const telegramEndpoint = normalized.endpoints.find(
      (endpoint) =>
        endpoint.agentId === bot.id &&
        endpoint.platform === "telegram" &&
        endpoint.enabled,
    );
    if (!telegramEndpoint) continue;
    const mode = bot.transport_override?.mode ?? config.transport.default_mode;
    const c = clients.get(bot.id);
    if (!c) continue;
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
  if (normalized.buzzPlatform?.enabled) {
    buzzTransport = new BuzzTransport({
      db,
      normalized,
      endpoints: [...normalized.endpoints, ...persisted.endpoints],
      alerts,
      adapters,
      onAccepted: async ({ endpointId, inboundEventId, normalizedEvent }) =>
        await registry.handleRecordedBuzzEvent({
          endpointId,
          inboundEventId,
          event: normalizedEvent,
        }),
      onControl: ({ endpointId, inboundEventId, event }) =>
        registry.handleRecordedBuzzControl({
          endpointId,
          inboundEventId,
          event,
        }),
      onProactive: ({ endpointId, channelId, prompt }) =>
        registry.handleBuzzHeartbeat({ endpointId, channelId, prompt }),
    });
    provisioning.attachTransport(buzzTransport);
    transports.push(buzzTransport);

    // One connection per distinct relay across all provisioned agents, staged
    // ones included, for the lifetime of the process. `refresh()` is what makes
    // it track a fleet that changes at runtime; it is also called directly on
    // every create, stage, restore, and purge.
    if (normalized.provisioning && provisioningKey) {
      tombstoneWatcher = new TombstoneWatcher({
        db,
        lifecycle: agentLifecycle,
        targets: () => provisioning.tombstoneTargets(),
        // YAML identities are never stageable by a relay event, so the watcher
        // needs to recognize them in order to refuse them loudly rather than
        // reporting them as merely unmatched.
        yamlPubkeys: () =>
          new Set(
            normalized.endpoints
              .filter(
                (endpoint) => endpoint.platform === "buzz" && endpoint.buzz,
              )
              .map((endpoint) => endpoint.buzz!.pubkey),
          ),
        maxFrameBytes: normalized.buzzPlatform.max_frame_bytes,
        waitMs: normalized.limits?.relay_ok_wait_ms ?? 5_000,
        reconnect: normalized.buzzPlatform.reconnect,
      });
    }
  }

  // Relay endpoints make accidental overlapping gateway instances externally
  // visible (double subscriptions and independently signed duplicate replies),
  // so Buzz activation requires an exclusive data-directory owner.
  const buzzOperational = normalized.endpoints.some(
    (endpoint) =>
      endpoint.platform === "buzz" && endpoint.buzz && endpoint.enabled,
  );
  const dataDirLock =
    buzzTransport && buzzOperational
      ? DataDirLock.acquire(config.gateway.data_dir)
      : null;
  const releaseDataDirLock = () => dataDirLock?.release();
  if (dataDirLock) process.once("exit", releaseDataDirLock);

  // Start runners and the normalized scheduler before adapters begin intake.
  // This guarantees that every accepted event has an active durable dispatch
  // owner from the moment its enqueue transaction commits.
  try {
    buzzBroker.start();
    await registry.startAll();
    await Promise.all(
      transports.map((t) =>
        t.start((botId, update) =>
          registry.handleUpdate(botId, update).then(() => {}),
        ),
      ),
    );
  } catch (error) {
    await buzzBroker.stop();
    releaseDataDirLock();
    process.off("exit", releaseDataDirLock);
    throw error;
  }

  // Surface any outbox rows left in `in_flight` by a previous process
  // crash. These auto-retry via the grace window in getPendingOutbox; the
  // log line just makes the dup-risk visible.
  outbox.recoverInFlight();
  outbox.start();

  // The delete pipeline comes up after the transports, so staging has a
  // supervisor to drain and purge has one to remove. `start()` runs a purge
  // sweep immediately: deadlines are persisted, so a gateway that was down when
  // one expired must act on it at boot rather than up to 300 s later (R5.4).
  if (normalized.provisioning) {
    agentLifecycle.start();
    tombstoneWatcher?.start();
    if (tombstoneWatcher) {
      log.info("tombstone watcher started", {
        relays: tombstoneWatcher.relayUrls.length,
      });
    }
  }

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

  // Attachment orphan-file sweep: catches the crash window between a
  // multipart/media write and the DB commit for Agent API and Buzz.
  const runOrphanSweep = async (): Promise<void> => {
    const buzzEnabled = normalized.endpoints.some(
      (endpoint) => endpoint.platform === "buzz" && endpoint.enabled,
    );
    if (!config.agent_api?.enabled && !buzzEnabled) return;
    try {
      const result = await sweepUnreferencedAgentApiFiles(
        db,
        config.gateway.data_dir,
        24 * 60 * 60 * 1000,
        Date.now,
        ["agentapi-", "buzz-"],
      );
      if (result.deleted > 0) {
        log.info("attachment orphan sweep", result);
      }
    } catch (err) {
      log.warn("attachment orphan sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  void runOrphanSweep();
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
        if (publisherRetentionSweep) clearInterval(publisherRetentionSweep);
        agentLifecycle.stop();
        // Awaited rather than fired and forgotten: the watcher owns real
        // sockets, and an orphaned relay connection is exactly the overlapping
        // second subscription the data-directory lock exists to prevent.
        if (tombstoneWatcher) await tombstoneWatcher.stop();

        // Unregister agent-api routes so new calls 404 before we tear down.
        for (const u of agentApiUnregs) {
          try {
            u();
          } catch {
            /* best-effort */
          }
        }
        for (const u of publisherUnregs) {
          try {
            u();
          } catch {
            /* best-effort */
          }
        }

        // 1. Stop accepting new updates, but keep outbound connections alive
        //    until all already-accepted work has produced and delivered its
        //    durable outbox operations.
        await Promise.all(transports.map((t) => t.stopIngress()));

        // 2. Finish work accepted before intake stopped. A timeout cancels
        //    active runner turns; queued turns remain durable for restart.
        const runnerDeadline = Math.min(
          deadline,
          Date.now() + config.shutdown.runner_grace_secs * 1000,
        );
        const runnerGraceMs = Math.max(0, runnerDeadline - Date.now());
        const acceptedDrained = await registry.drainAccepted(runnerGraceMs);
        if (!acceptedDrained) {
          log.warn("accepted turn drain budget expired; durable work remains", {
            queued_turns: db.getQueuedConversationTurns().length,
          });
        }

        // 3. Cancel any unfinished stream cadence before draining its durable
        //    delivery operations.
        streaming.stopAll();

        // 4. Drain outbox up to shutdown.outbox_drain_secs.
        const drainBudgetMs = Math.max(
          0,
          Math.min(
            config.shutdown.outbox_drain_secs * 1000,
            deadline - Date.now(),
          ),
        );
        await outbox.drain(drainBudgetMs);
        outbox.stop();

        // 5. The delivery drain is complete; outbound transport connections
        //    can now close without stranding replies created during shutdown.
        await Promise.all(transports.map((t) => t.stop()));

        // 6. Tear down agent-api side sessions before the main runners
        //     so ask handlers observe fatal events rather than hangs.
        const remainingRunnerGraceMs = Math.max(0, runnerDeadline - Date.now());
        if (agentApiOrphans) agentApiOrphans.shutdown();
        await sessionManager.shutdown(remainingRunnerGraceMs);

        await registry.stopAll(remainingRunnerGraceMs);
        await buzzBroker.stop();

        // 7. Close HTTP and persistence sockets last.
        await server.stop();
        db.close();
      } finally {
        releaseDataDirLock();
        process.off("exit", releaseDataDirLock);
        clearTimeout(hardTimer);
      }
      log.info("shutdown complete");
    },
  };
  log.info("torana ready", { port: server.port });
  return running;
}

export function warnOnEmptyAcl(
  config: Config,
  normalized?: NormalizedConfigModel,
): void {
  const globalEmpty = config.access_control.allowed_user_ids.length === 0;
  const telegramAgents = normalized
    ? new Set(
        normalized.endpoints
          .filter(
            (endpoint) => endpoint.platform === "telegram" && endpoint.enabled,
          )
          .map((endpoint) => endpoint.agentId),
      )
    : null;
  const affectedBots = config.bots
    .filter((b) => {
      if (telegramAgents && !telegramAgents.has(b.id)) return false;
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
  buzzHealth: () => BuzzEndpointHealth[] = () => [],
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
    const buzz = buzzHealth();
    if (buzz.some((endpoint) => endpoint.state === "unhealthy")) ok = false;
    const operational = db.operationalMetrics();
    const runtimeByEndpoint = new Map(
      buzz.map((endpoint) => [endpoint.endpointId, endpoint]),
    );
    const endpoints = operational.map((endpoint) => ({
      endpoint_id: endpoint.endpointId,
      agent_id: endpoint.agentId,
      platform: endpoint.platform,
      lifecycle_state: endpoint.lifecycleState,
      runtime_state: runtimeByEndpoint.get(endpoint.endpointId)?.state ?? null,
      connected: runtimeByEndpoint.get(endpoint.endpointId)?.connected ?? null,
      diagnosis: diagnoseBuzzEndpoint(
        runtimeByEndpoint.get(endpoint.endpointId),
      ),
      last_error: runtimeByEndpoint.get(endpoint.endpointId)?.lastError
        ? redactString(runtimeByEndpoint.get(endpoint.endpointId)!.lastError!)
        : null,
      disconnected_since:
        runtimeByEndpoint.get(endpoint.endpointId)?.disconnectedSince ?? null,
      subscriptions:
        runtimeByEndpoint.get(endpoint.endpointId)?.channels ?? null,
      presence: runtimeByEndpoint.get(endpoint.endpointId)?.presence
        ? {
            last_published_at: runtimeByEndpoint.get(endpoint.endpointId)!
              .presence.lastPublishedAt,
            consecutive_failures: runtimeByEndpoint.get(endpoint.endpointId)!
              .presence.consecutiveFailures,
            stale: runtimeByEndpoint.get(endpoint.endpointId)!.presence.stale,
          }
        : null,
      queue: { queued: endpoint.queued, running: endpoint.running },
      conversations: endpoint.conversations,
      sessions: endpoint.sessions,
      outbox: {
        pending: endpoint.outboxPending,
        dead: endpoint.outboxDead,
      },
    }));
    return new Response(
      JSON.stringify({
        status: ok ? "ok" : "degraded",
        bots,
        endpoints,
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
      const runtime = buzzHealth();
      const body = metrics.renderPrometheus(
        botStates,
        db.operationalMetrics(),
        runtime.map((endpoint) => ({
          endpointId: endpoint.endpointId,
          state: endpoint.state,
          channels: endpoint.channels,
          presence: {
            attempted: endpoint.presence.attempted,
            suppressed: endpoint.presence.suppressed,
            failed: endpoint.presence.failed,
            consecutiveFailures: endpoint.presence.consecutiveFailures,
            stale: endpoint.presence.stale,
          },
        })),
      );
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
      //   - Connection: dropped here because we re-set it to "close" below;
      //     a caller-supplied "Connection: keep-alive" must not win.
      // Retain everything else so request routing + Accept/Accept-Language
      // still work for the dashboard UI.
      const forwardedHeaders = new Headers(req.headers);
      const stripList = [
        "proxy-authorization",
        "idempotency-key",
        "x-telegram-bot-api-secret-token",
        "host",
        "connection",
      ];
      if (!forwardFull) {
        stripList.push("authorization", "cookie");
      }
      for (const h of stripList) {
        forwardedHeaders.delete(h);
      }
      // Force the upstream socket to close after this response. Without
      // this, bun's HTTP client parks each torana → upstream connection in
      // its keepalive pool; over multi-hour uptime the pool grows
      // monotonically until it hits an upstream/anyio cap, at which point
      // every new /dashboard/* request blocks waiting for a free slot.
      // GH#16. The cost is one TCP setup per request, but the proxy target
      // is loopback by default so RTT is ~zero; the wedge regression is
      // the worse failure mode.
      forwardedHeaders.set("connection", "close");

      try {
        // - redirect: "manual" stops fetch from following a backend Location:
        //   header. Without this the proxy can be used as an open redirect
        //   / SSRF stepping-stone into anywhere the gateway host can reach.
        //   Kept regardless of forward_full_request.
        // - signal: req.signal propagates client-disconnect into the upstream
        //   fetch. Critical for long-lived responses (SSE / EventSource):
        //   without it, when the browser closes its EventSource the upstream
        //   socket is held until the upstream itself times out, leaking pool
        //   slots one-by-one until /dashboard/* wedges. GH#16.
        const proxyReq = new Request(backendUrl, {
          method: req.method,
          headers: forwardedHeaders,
          body: req.body,
          redirect: "manual",
          signal: req.signal,
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

function diagnoseBuzzEndpoint(
  endpoint: BuzzEndpointHealth | undefined,
): "none" | "key" | "auth" | "membership" | "reconnect" {
  if (!endpoint?.lastError) return "none";
  const error = endpoint.lastError.toLowerCase();
  if (/private key|public key|signature|signing key/.test(error)) return "key";
  if (/auth|nip-42|nip-aa|owner.?auth|expired/.test(error)) return "auth";
  if (
    /member|membership|forbidden|not permitted|no accessible channel/.test(
      error,
    )
  ) {
    return "membership";
  }
  return "reconnect";
}

export function runCrashRecovery(
  db: GatewayDB,
  endpoints: ReadonlyMap<string, PlatformAdapter>,
  atMostOnce = false,
): void {
  const adapters = new Map(endpoints);
  log.info("running crash recovery");
  const running = db.getRunningTurns();
  for (const turn of running) {
    const ss = db.getStreamState(turn.id);
    if (ss?.active_telegram_message_id) {
      const adapter = adapters.get(turn.bot_id);
      if (adapter) {
        const display = ss.buffer_text?.trim() || "(restarted)";
        void adapter
          .deliver(
            {
              platform: "telegram",
              communityId: null,
              endpointId: turn.bot_id,
              channelId: String(turn.chat_id),
              threadRootId: null,
              workflowRunId: null,
              type: "direct",
            },
            {
              kind: "edit",
              externalMessageId: String(ss.active_telegram_message_id),
              text: display,
            },
          )
          .catch(() => {});
      }
    }
    if (!atMostOnce && !turn.first_output_at) {
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
      if (atMostOnce) {
        if (turn.source_update_id !== null) {
          db.setUpdateStatus(turn.source_update_id, "interrupted");
        }
        db.setTurnSourceEventStatus(turn.id, "interrupted");
      }

      // For Agent-API-originated turns (ask / send), the end user in the
      // Telegram chat never initiated anything — the external agent did,
      // and it polls /v1/turns/:id for the outcome. Sending a "Gateway
      // restarted …" message into the user's DM leaks the existence of
      // a backend job the user has no context for. Skip the notify on
      // agent_api_* turns; the polling caller sees the `failed` /
      // `interrupted_by_gateway_restart` status.
      const isAgentApi =
        turn.source === "agent_api_send" || turn.source === "agent_api_ask";
      const delivery = db.getTurnDeliveryContext(turn.id);
      if (!isAgentApi && delivery?.conversation.platform !== "buzz") {
        const adapter = adapters.get(turn.bot_id);
        if (adapter) {
          void adapter.deliver(
            {
              platform: "telegram",
              communityId: null,
              endpointId: turn.bot_id,
              channelId: String(turn.chat_id),
              threadRootId: null,
              workflowRunId: null,
              type: "direct",
            },
            {
              kind: "send",
              text: "\u26a0\ufe0f Gateway restarted during an active turn. The previous response may be incomplete.",
              files: [],
            },
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

/**
 * The adapter for a provisioned Buzz endpoint, created on first use.
 *
 * A provisioned endpoint may not exist when the process starts — a create adds
 * one at runtime — so the shared adapter map cannot be fully built up front the
 * way it is for YAML endpoints. Everything that resolves an endpoint through
 * that map (alerts, the outbox, a provisioned agent's Bot) needs the entry, and
 * the Buzz transport reuses a configured adapter when it finds one, so
 * registering here keeps a single adapter per endpoint rather than two.
 */
function adapterForProvisionedEndpoint(
  adapters: Map<string, PlatformAdapter>,
  endpoint: NormalizedEndpointConfig,
): PlatformAdapter {
  const existing = adapters.get(endpoint.id);
  if (existing) return existing;
  const adapter = new BuzzAdapter(endpoint);
  adapters.set(endpoint.id, adapter);
  return adapter;
}
