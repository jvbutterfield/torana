// One `Bot` bundles: config, Telegram client, runner, and references to
// shared services (DB, streaming, outbox, metrics, alerts). The BotRegistry
// (below, in registry.ts) owns the collection of Bot instances.
//
// Lifecycle:
//   - new Bot(...)
//   - start(): initializes runner, subscribes to its events
//   - stop(): cleanly stops the runner

import { logger, type Logger } from "../log.js";
import type { BotConfig, Config } from "../config/schema.js";
import type { TelegramClient } from "../telegram/client.js";
import type { GatewayDB } from "../db/gateway-db.js";
import type { AgentRunner, RunnerEvent } from "../runner/types.js";
import { ClaudeCodeRunner } from "../runner/claude-code.js";
import { CommandRunner } from "../runner/command.js";
import type { StreamManager } from "../streaming.js";
import type { OutboxProcessor } from "../outbox.js";
import type { Metrics } from "../metrics.js";
import type { AlertManager } from "../alerts.js";

export interface BotOptions {
  config: Config;
  botConfig: BotConfig;
  db: GatewayDB;
  telegram: TelegramClient;
  streaming: StreamManager;
  outbox: OutboxProcessor;
  metrics: Metrics;
  alerts: AlertManager;
}

export class Bot {
  readonly botConfig: BotConfig;
  readonly telegram: TelegramClient;
  readonly runner: AgentRunner;

  private config: Config;
  private db: GatewayDB;
  private streaming: StreamManager;
  private outbox: OutboxProcessor;
  private metrics: Metrics;
  private alerts: AlertManager;
  private log: Logger;

  private activeTurnId: number | null = null;
  private readyOnce = false;

  constructor(opts: BotOptions) {
    this.config = opts.config;
    this.botConfig = opts.botConfig;
    this.telegram = opts.telegram;
    this.db = opts.db;
    this.streaming = opts.streaming;
    this.outbox = opts.outbox;
    this.metrics = opts.metrics;
    this.alerts = opts.alerts;
    this.log = logger("bot", { bot_id: opts.botConfig.id });
    this.runner = this.instantiateRunner();

    this.runner.on("ready", () => this.onRunnerReady());
    this.runner.on("text_delta", (ev) => this.onTextDelta(ev));
    this.runner.on("done", (ev) => this.onDone(ev));
    this.runner.on("error", (ev) => this.onError(ev));
    this.runner.on("fatal", (ev) => this.onFatal(ev));
    this.runner.on("rate_limit", (ev) => this.onRateLimit(ev));
  }

  get id(): string {
    return this.botConfig.id;
  }

  get isReady(): boolean {
    return this.runner.isReady() && this.activeTurnId === null;
  }

  get activeTurn(): number | null {
    return this.activeTurnId;
  }

  async start(): Promise<void> {
    this.db.initWorkerState(this.botConfig.id);
    await this.runner.start();
  }

  async stop(): Promise<void> {
    await this.runner.stop();
  }

  /**
   * Dispatch the given turn to the runner. Returns true if dispatch succeeded.
   * Called by the BotRegistry's dispatch loop.
   */
  dispatchTurn(turnId: number, chatId: number, text: string, attachmentPaths: string[]): boolean {
    if (!this.isReady) return false;

    const attachments = attachmentPaths.map((p) => ({
      kind: "document" as const,
      path: p,
      bytes: 0, // unknown after the fact — the runner doesn't typically need this
    }));

    // Assign our integer turn id to the runner as a string TurnId.
    const tid = String(turnId);
    this.streaming.startTurn(this.botConfig.id, turnId, chatId);

    const result = this.runner.sendTurn(tid, text, attachments);
    if (!result.accepted) {
      this.log.warn("runner rejected turn", { turn_id: turnId, reason: result.reason });
      // Unwind the stream start so we don't leave a dangling "thinking..." placeholder.
      this.streaming.cancelTurn(this.botConfig.id);
      return false;
    }

    this.activeTurnId = turnId;
    const gen = this.db.incrementWorkerGeneration(this.botConfig.id);
    this.db.startTurn(turnId, gen);
    this.metrics.inc(this.botConfig.id, "turns_dispatched");
    return true;
  }

  // --- Runner event handlers ---

  private onRunnerReady(): void {
    if (!this.readyOnce) {
      this.readyOnce = true;
      this.log.info("runner ready");
    }
    this.db.updateWorkerState(this.botConfig.id, {
      status: "ready",
      last_ready_at: new Date().toISOString(),
    });
  }

  private onTextDelta(ev: Extract<RunnerEvent, { kind: "text_delta" }>): void {
    if (!this.activeTurnId) return;
    this.streaming.appendText(this.botConfig.id, ev.text);
  }

  private onDone(ev: Extract<RunnerEvent, { kind: "done" }>): void {
    if (this.activeTurnId === null) return;
    const turnId = this.activeTurnId;
    this.activeTurnId = null;

    this.db.completeTurn(turnId);
    this.streaming.finalizeTurn(this.botConfig.id, ev.finalText ?? "");
    this.metrics.inc(this.botConfig.id, "turns_completed");
    if (ev.durationMs !== undefined) {
      this.metrics.recordTimer(
        this.botConfig.id,
        "last_turn_duration_ms",
        ev.durationMs,
      );
    }

    const srcId = this.db.getTurnSourceUpdateId(turnId);
    if (srcId !== null) this.db.setUpdateStatus(srcId, "processed");
  }

  private onError(ev: Extract<RunnerEvent, { kind: "error" }>): void {
    if (this.activeTurnId === null) return;
    const turnId = this.activeTurnId;
    this.activeTurnId = null;

    this.db.completeTurn(turnId, ev.message);
    this.streaming.finalizeTurn(
      this.botConfig.id,
      ev.message || "An error occurred.",
    );
    this.metrics.inc(this.botConfig.id, "turns_failed");

    const srcId = this.db.getTurnSourceUpdateId(turnId);
    if (srcId !== null) this.db.setUpdateStatus(srcId, "processed");
  }

  private onFatal(ev: Extract<RunnerEvent, { kind: "fatal" }>): void {
    this.log.error("runner fatal", { code: ev.code, message: ev.message });

    if (this.activeTurnId !== null) {
      const turnId = this.activeTurnId;
      this.activeTurnId = null;
      this.db.interruptTurn(turnId, `runner fatal: ${ev.message}`);
      this.streaming.cancelTurn(this.botConfig.id);
    }

    if (ev.code === "auth") {
      this.db.setBotDisabled(this.botConfig.id, `auth failure: ${ev.message}`);
      void this.alerts.tokenInvalid(this.botConfig.id);
    } else {
      void this.alerts.workerCrashLoop(this.botConfig.id, 1);
    }

    this.db.updateWorkerState(this.botConfig.id, { status: "degraded", last_error: ev.message });
  }

  private onRateLimit(ev: Extract<RunnerEvent, { kind: "rate_limit" }>): void {
    this.log.warn("rate limited", { retry_after_ms: ev.retry_after_ms });
  }

  private instantiateRunner(): AgentRunner {
    const runnerConfig = this.botConfig.runner;
    const logDir = `${this.config.gateway.data_dir}/logs`;
    if (runnerConfig.type === "claude-code") {
      return new ClaudeCodeRunner({
        botId: this.botConfig.id,
        config: runnerConfig,
        logDir,
      });
    }
    return new CommandRunner({
      botId: this.botConfig.id,
      config: runnerConfig,
      logDir,
    });
  }
}
