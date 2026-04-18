import { loadConfig, PERSONAS, type Config, type PersonaName } from "./config.js";
import { GatewayDB } from "./db.js";
import { TelegramClient } from "./telegram.js";
import { WorkerManager, type WorkerEvent, type ResultEvent, type StreamEvent } from "./worker.js";
import { OutboxProcessor } from "./outbox.js";
import { StreamManager } from "./streaming.js";
import { createServer, type HealthProvider } from "./server.js";
import { Metrics } from "./metrics.js";
import { AlertManager } from "./alerts.js";
import { logger, setLogLevel } from "./log.js";
import { mkdirSync } from "node:fs";

const log = logger("main");

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  log.info("telegram gateway starting", { personas: PERSONAS });

  mkdirSync(`${config.dataRoot}/gateway`, { recursive: true });
  mkdirSync(`${config.dataRoot}/logs`, { recursive: true });
  for (const p of PERSONAS) {
    mkdirSync(`${config.dataRoot}/gateway/attachments/${p}`, { recursive: true });
  }

  const db = new GatewayDB(config.dbPath);
  const metrics = new Metrics();

  const clients = new Map<PersonaName, TelegramClient>();
  for (const p of PERSONAS) {
    clients.set(p, new TelegramClient(p, config.botTokens[p]));
  }

  const alerts = new AlertManager(config, clients);
  const outbox = new OutboxProcessor(config, db, clients, metrics);
  const stream = new StreamManager(config, db, outbox, clients);

  runCrashRecovery(db, clients);

  const workers = new Map<PersonaName, WorkerManager>();
  for (const p of PERSONAS) {
    const worker = new WorkerManager(config, db, p, metrics, alerts, (persona, event) => {
      handleWorkerEvent(persona, event, db, stream, workers, config, metrics);
    });
    workers.set(p, worker);
  }

  function tryDispatch(persona: PersonaName) {
    const worker = workers.get(persona);
    if (!worker || !worker.isIdle()) return;

    const queued = db.getQueuedTurns(persona);
    if (queued.length === 0) return;

    const turn = queued[0];
    const text = db.getTurnText(turn.id);
    if (text === null) {
      log.error("turn has no text", { persona, turnId: turn.id });
      db.completeTurn(turn.id, "no message text");
      return;
    }

    const attachments = db.getTurnAttachments(turn.id);
    stream.startTurn(persona, turn.id, turn.chat_id);
    const ok = worker.sendTurn(turn.id, text, attachments);
    if (!ok) {
      db.completeTurn(turn.id, "worker dispatch failed");
      return;
    }
    db.setUpdateStatus(turn.source_update_id, "processing");
  }

  function handleInbound(
    persona: PersonaName,
    updateRowId: number,
    chatId: number,
    _messageId: number,
    _fromUserId: string,
    text: string,
    attachmentPaths: string[],
    _payloadJson: string,
  ) {
    // /new command: reset the Claude session for any persona.
    // Intercept before turn creation — no turn is enqueued, nothing is forwarded
    // to Claude.
    if (text.trim() === "/new") {
      db.setUpdateStatus(updateRowId, "completed");
      log.info("fresh restart requested via /new", { persona, chatId });
      const worker = workers.get(persona)!;
      const client = clients.get(persona)!;
      worker.freshRestart(() => {
        client.sendMessage(chatId, "Session cleared. Fresh start ready.").catch(() => {});
      });
      return;
    }

    const turnId = db.createTurn(persona, chatId, updateRowId, attachmentPaths.length > 0 ? attachmentPaths : undefined);
    metrics.inc(persona, "turns_queued");
    log.info("turn queued", { persona, turnId, updateRowId });
    tryDispatch(persona);
  }

  const getHealth: HealthProvider = () => {
    const result: Record<string, any> = {};
    const metricsSnapshot = metrics.snapshot();
    for (const p of PERSONAS) {
      const ws = db.getWorkerState(p);
      result[p] = {
        worker: ws?.status ?? "unknown",
        mailbox_depth: db.getMailboxDepth(p),
        last_turn_at: db.getLastTurnAt(p),
        counters: metricsSnapshot[p].counters,
        timers: metricsSnapshot[p].timers,
      };
      if (ws?.status === "degraded" && ws.last_error) {
        result[p].error = ws.last_error;
      }
    }
    return result as any;
  };

  const server = createServer(config, db, clients, handleInbound, getHealth, metrics);

  for (const p of PERSONAS) {
    const webhookUrl = `${config.webhookBaseUrl}/webhook/${p}`;
    const client = clients.get(p)!;
    try {
      await client.setWebhook(webhookUrl, config.webhookSecret);
    } catch (err) {
      log.error("webhook registration failed", { persona: p, error: String(err) });
    }
  }

  outbox.start();

  for (const p of PERSONAS) {
    workers.get(p)!.start();
  }

  // Periodic dispatch check — catches any missed dispatches (e.g., after worker recovery)
  setInterval(() => {
    for (const p of PERSONAS) tryDispatch(p);
  }, 2000);

  // Periodic health check — alert on mailbox backlog
  setInterval(() => {
    for (const p of PERSONAS) {
      const depth = db.getMailboxDepth(p);
      if (depth >= 5) {
        alerts.mailboxBacklog(p, depth);
      }
    }
  }, 30_000);

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });

    server.stop();
    outbox.stop();
    stream.stopAll();

    await Promise.all(PERSONAS.map(p => workers.get(p)!.stop()));

    db.close();
    log.info("shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  log.info("gateway ready", { port: config.port, personas: PERSONAS });
}

function handleWorkerEvent(
  persona: PersonaName,
  event: WorkerEvent,
  db: GatewayDB,
  stream: StreamManager,
  workers: Map<PersonaName, WorkerManager>,
  config: Config,
  metrics: Metrics,
) {
  const worker = workers.get(persona)!;
  const turnId = worker.getActiveTurnId();

  if (event.type === "stream_event") {
    const se = event as StreamEvent;
    const inner = se.event;
    if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta" && inner.delta.text) {
      if (turnId !== null) {
        stream.appendText(persona, inner.delta.text);
      }
    }
  } else if (event.type === "result") {
    const re = event as ResultEvent;
    if (turnId !== null) {
      if (re.is_error) {
        db.completeTurn(turnId, re.result || "unknown error");
        stream.finalizeTurn(persona, re.result || "An error occurred.");
        metrics.inc(persona, "turns_failed");
      } else {
        db.completeTurn(turnId);
        stream.finalizeTurn(persona, re.result);
        metrics.inc(persona, "turns_completed");
      }
      if (re.duration_ms) {
        metrics.recordTimer(persona, "last_turn_duration_ms", re.duration_ms);
      }

      const sourceId = db.getTurnSourceUpdateId(turnId);
      if (sourceId !== null) {
        db.setUpdateStatus(sourceId, re.is_error ? "failed" : "completed");
      }
    }

    worker.turnCompleted();

    // Dispatch next queued turn (reuse tryDispatch — no inline copy)
    // tryDispatch is in the closure scope of main(); we receive it indirectly
    // through the workers map. Use a short delay to let the worker settle.
    setTimeout(() => {
      if (worker.isIdle()) {
        const queued = db.getQueuedTurns(persona);
        if (queued.length > 0) {
          // The periodic dispatch will pick it up within 2s, or we could
          // emit an event. For now, the 2s interval handles this.
        }
      }
    }, 100);
  } else if (event.type === "rate_limit_event") {
    const rle = event as any;
    if (rle.rate_limit_info?.status !== "allowed") {
      log.warn("rate limited", { persona, info: rle.rate_limit_info });
    }
  }
}

function runCrashRecovery(db: GatewayDB, clients: Map<PersonaName, TelegramClient>) {
  log.info("running crash recovery");

  const runningTurns = db.getRunningTurns();
  for (const turn of runningTurns) {
    // Clean up any orphaned placeholder message from the previous process.
    // Without this, re-queuing the turn causes a second "thinking..." to be
    // sent while the old one sits there forever.
    const streamState = db.getStreamState(turn.id);
    if (streamState?.active_telegram_message_id) {
      const client = clients.get(turn.persona as PersonaName);
      if (client) {
        const display = streamState.buffer_text?.trim() || "(restarted)";
        client.editMessageText(turn.chat_id, streamState.active_telegram_message_id, display).catch(() => {});
      }
    }

    if (!turn.first_output_at) {
      log.info("re-queuing orphaned turn (no output)", { turnId: turn.id, persona: turn.persona });
      db.requeueTurn(turn.id);
      // Cancel any pending placeholder send so it isn't delivered after restart.
      // Without this, the stale "thinking..." outbox item fires alongside the
      // new placeholder that startTurn creates, producing two "thinking..." messages.
      db.cancelPendingOutboxForTurn(turn.id);
    } else {
      log.info("marking orphaned turn interrupted (had output)", { turnId: turn.id, persona: turn.persona });
      db.interruptTurn(turn.id, "Gateway restarted during active turn");

      const client = clients.get(turn.persona as PersonaName);
      if (client) {
        client.sendMessage(turn.chat_id, "\u26a0\ufe0f Gateway restarted during an active turn. The previous response may be incomplete.").catch(() => {});
      }
    }
  }

  const pendingOutbox = db.getPendingOutbox();
  for (const row of pendingOutbox) {
    if (row.kind === "edit" && db.hasSupersedingEdit(row.telegram_message_id, row.id)) {
      db.markOutboxFailed(row.id, "superseded by later send");
    }
    // Leave remaining pending/retrying items for the outbox processor
  }

  db.resetAllWorkerStates();

  log.info("crash recovery complete", {
    orphanedTurns: runningTurns.length,
    pendingOutbox: pendingOutbox.length,
  });
}

main().catch(err => {
  log.error("fatal startup error", { error: String(err) });
  process.exit(1);
});
