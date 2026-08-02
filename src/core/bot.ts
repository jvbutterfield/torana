import { logger, type Logger } from "../log.js";
import { nextBackoffMs } from "../backoff.js";
import type { BotConfig, Config } from "../config/schema.js";
import type { GatewayDB } from "../db/gateway-db.js";
import type {
  AgentRunner,
  RunnerEvent,
  RunnerSession,
  Unsubscribe,
} from "../runner/types.js";
import { ClaudeCodeRunner } from "../runner/claude-code.js";
import { CodexRunner } from "../runner/codex.js";
import { CommandRunner } from "../runner/command.js";
import type { StreamManager } from "../streaming.js";
import type { OutboxProcessor } from "../outbox.js";
import type { Metrics } from "../metrics.js";
import type { AlertManager } from "../alerts.js";
import type { PlatformAdapter } from "../platform/capabilities.js";
import type { BuzzCredentialBroker } from "../broker/buzz-broker.js";

export interface BotOptions {
  config: Config;
  botConfig: BotConfig;
  db: GatewayDB;
  endpoint: PlatformAdapter;
  streaming: StreamManager;
  outbox: OutboxProcessor;
  metrics: Metrics;
  alerts: AlertManager;
  /** Test-only: inject a pre-built runner instead of instantiating from config. */
  runner?: AgentRunner;
  buzzBroker?: BuzzCredentialBroker;
}

export type ManagedTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; reason: string }
  | { kind: "interrupted"; reason: string; code?: string }
  | { kind: "cancelled"; reason: string };

export class Bot {
  readonly botConfig: BotConfig;
  readonly endpoint: PlatformAdapter;
  readonly runner: AgentRunner;

  private config: Config;
  private db: GatewayDB;
  private streaming: StreamManager;
  private outbox: OutboxProcessor;
  private metrics: Metrics;
  private alerts: AlertManager;
  private log: Logger;

  private activeTurnId: number | null = null;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private managedTurns = new Map<number, (reason: string) => void>();
  private buzzBroker?: BuzzCredentialBroker;

  constructor(opts: BotOptions) {
    this.config = opts.config;
    this.botConfig = opts.botConfig;
    this.endpoint = opts.endpoint;
    this.db = opts.db;
    this.streaming = opts.streaming;
    this.outbox = opts.outbox;
    this.metrics = opts.metrics;
    this.alerts = opts.alerts;
    this.log = logger("bot", { bot_id: opts.botConfig.id });
    this.buzzBroker = opts.buzzBroker;
    this.runner = opts.runner ?? this.instantiateRunner();

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
    this.db.initBotState(this.botConfig.id);
    await this.runner.start();
  }

  /** Initialize a v2 agent whose turns are owned exclusively by sessions. */
  startSessionHost(): void {
    this.db.initWorkerState(this.botConfig.id);
    this.db.initBotState(this.botConfig.id);
    this.db.updateWorkerState(this.botConfig.id, {
      status: "ready",
      last_ready_at: new Date().toISOString(),
    });
  }

  async stop(graceMs?: number): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    await this.runner.stop(graceMs);
  }

  /**
   * Dispatch the given turn to the runner. Returns true if dispatch succeeded.
   * Called by the BotRegistry's dispatch loop.
   */
  dispatchTurn(
    turnId: number,
    chatId: number,
    text: string,
    attachmentPaths: string[],
  ): boolean {
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
      this.log.warn("runner rejected turn", {
        turn_id: turnId,
        reason: result.reason,
      });
      // Unwind the stream start so the typing timer / activeTurns entry
      // don't outlive the turn.
      this.streaming.cancelTurn(this.botConfig.id);
      return false;
    }

    this.activeTurnId = turnId;
    const gen = this.db.incrementWorkerGeneration(this.botConfig.id);
    this.db.startTurn(turnId, gen);
    const srcId = this.db.getTurnSourceUpdateId(turnId);
    if (srcId !== null) this.db.setUpdateStatus(srcId, "dispatched");
    this.metrics.inc(this.botConfig.id, "turns_dispatched");
    return true;
  }

  cancelManagedTurn(turnId: number, reason = "cancelled by operator"): boolean {
    const cancel = this.managedTurns.get(turnId);
    if (!cancel) return false;
    cancel(reason);
    return true;
  }

  /** Dispatch one normalized conversation turn through an independent session. */
  dispatchSessionTurn(
    sessionKey: string,
    session: RunnerSession,
    turnId: number,
    chatId: number,
    text: string,
    attachmentPaths: string[],
    onTerminal: (outcome: ManagedTurnOutcome) => void,
  ): boolean {
    const delivery = this.db.getTurnDeliveryContext(turnId);
    const isBuzz = delivery?.conversation.platform === "buzz";
    if (delivery) {
      this.buzzBroker?.issueCapability({
        agentId: this.botConfig.id,
        sessionId: session.id,
        conversation: delivery.conversation,
      });
    }
    const attachments = attachmentPaths.map((path) => ({
      kind: "document" as const,
      path,
      bytes: 0,
    }));
    const tid = String(turnId);
    const unsubs: Unsubscribe[] = [];
    let terminal = false;
    const cleanup = (outcome: ManagedTurnOutcome) => {
      if (terminal) return;
      terminal = true;
      for (const unsub of unsubs) unsub();
      this.managedTurns.delete(turnId);
      this.buzzBroker?.revokeCapability(session.id);
      onTerminal(outcome);
    };
    unsubs.push(
      session.on("text_delta", (ev) => {
        if (String(ev.turnId) === tid) {
          this.streaming.appendText(this.botConfig.id, ev.text, turnId);
        }
      }),
      session.on("done", (ev) => {
        if (String(ev.turnId) !== tid) return;
        const finalText = ev.finalText ?? "";
        if (isBuzz) {
          this.db.setTurnFinalText(
            turnId,
            finalText,
            null,
            ev.durationMs ?? null,
          );
        } else {
          this.db.completeTurn(turnId);
        }
        void this.streaming.finalizeTurn(this.botConfig.id, finalText, turnId);
        this.metrics.inc(this.botConfig.id, "turns_completed");
        const srcId = this.db.getTurnSourceUpdateId(turnId);
        if (srcId !== null) this.db.setUpdateStatus(srcId, "processed");
        this.db.setTurnSourceEventStatus(turnId, "processed");
        cleanup({ kind: "completed" });
      }),
      session.on("error", (ev) => {
        if (String(ev.turnId) !== tid) return;
        const display = ev.message || "An error occurred.";
        this.db.completeTurn(turnId, ev.message);
        void this.streaming.finalizeTurn(this.botConfig.id, display, turnId);
        this.metrics.inc(this.botConfig.id, "turns_failed");
        const srcId = this.db.getTurnSourceUpdateId(turnId);
        if (srcId !== null) this.db.setUpdateStatus(srcId, "processed");
        this.db.setTurnSourceEventStatus(turnId, "processed");
        cleanup({ kind: "failed", reason: ev.message });
      }),
      session.on("fatal", (ev) => {
        this.db.interruptTurn(turnId, `runner_${ev.code ?? "unknown"}`);
        const srcId = this.db.getTurnSourceUpdateId(turnId);
        if (srcId !== null) this.db.setUpdateStatus(srcId, "interrupted");
        this.db.setTurnSourceEventStatus(turnId, "interrupted");
        this.streaming.cancelTurn(this.botConfig.id, turnId);
        cleanup({
          kind: "interrupted",
          reason: `runner_${ev.code ?? "unknown"}`,
          code: ev.code,
        });
      }),
    );
    this.managedTurns.set(turnId, (reason) => {
      this.db.interruptTurn(turnId, reason);
      const srcId = this.db.getTurnSourceUpdateId(turnId);
      if (srcId !== null) this.db.setUpdateStatus(srcId, "interrupted");
      this.db.setTurnSourceEventStatus(turnId, "interrupted");
      this.streaming.cancelTurn(this.botConfig.id, turnId);
      cleanup({
        kind: reason === "cancelled by operator" ? "cancelled" : "interrupted",
        reason,
      });
    });
    this.streaming.startTurn(this.botConfig.id, turnId, chatId);
    const result = session.sendTurn(tid, text, attachments);
    if (!result.accepted) {
      for (const unsub of unsubs) unsub();
      this.managedTurns.delete(turnId);
      this.buzzBroker?.revokeCapability(session.id);
      this.streaming.cancelTurn(this.botConfig.id, turnId);
      this.log.warn("conversation session rejected turn", {
        session_key: sessionKey,
        turn_id: turnId,
        reason: result.reason,
      });
      return false;
    }
    const gen = this.db.incrementWorkerGeneration(this.botConfig.id);
    this.db.startTurn(turnId, gen);
    this.db.setTurnSourceEventStatus(turnId, "dispatched");
    this.metrics.inc(this.botConfig.id, "turns_dispatched");
    return true;
  }

  // --- Runner event handlers ---

  private onRunnerReady(): void {
    // Reset the consecutive_failures counter on any successful start. A
    // runner that reaches 'ready' again after a crash loop clears its
    // credit, so the next fatal starts backoff from zero.
    const state = this.db.getWorkerState(this.botConfig.id);
    if (state && state.consecutive_failures > 0) {
      this.log.info("crash loop recovered", {
        prior_failures: state.consecutive_failures,
      });
      this.db.updateWorkerState(this.botConfig.id, { consecutive_failures: 0 });
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
    // `ev.message` may contain a tail of subprocess stderr — potentially
    // including third-party secrets the redactor can't know about (upstream
    // API keys printed in a stack trace, etc.). Persist and log the stable
    // code only. The full stderr is already captured to the per-bot log
    // file at ${data_dir}/logs/<bot_id>.log for operator debugging.
    const stableCode = `runner_${ev.code ?? "unknown"}`;
    this.log.error("runner fatal", { code: ev.code });
    this.metrics.inc(this.botConfig.id, "worker_restarts");

    if (this.activeTurnId !== null) {
      const turnId = this.activeTurnId;
      this.activeTurnId = null;
      this.db.interruptTurn(turnId, stableCode);
      this.streaming.cancelTurn(this.botConfig.id);
    }

    // Auth failures never retry — the credential is wrong, not transient.
    if (ev.code === "auth") {
      this.db.setBotDisabled(this.botConfig.id, "auth_failure");
      this.db.updateWorkerState(this.botConfig.id, {
        status: "degraded",
        last_error: stableCode,
      });
      this.metrics.inc(this.botConfig.id, "worker_startup_failures");
      void this.alerts.tokenInvalid(this.botConfig.id);
      return;
    }

    // Non-auth: increment consecutive_failures and decide whether to retry.
    const state = this.db.getWorkerState(this.botConfig.id);
    const failures = (state?.consecutive_failures ?? 0) + 1;
    this.db.updateWorkerState(this.botConfig.id, {
      consecutive_failures: failures,
      last_error: stableCode,
    });

    const max = this.config.worker_tuning.max_consecutive_failures;
    if (failures >= max) {
      this.log.error("max consecutive failures — stopping retries", {
        failures,
      });
      this.db.updateWorkerState(this.botConfig.id, { status: "degraded" });
      void this.alerts.workerDegraded(
        this.botConfig.id,
        `${failures} consecutive failures — stopped retrying`,
      );
      return;
    }

    if (failures >= 3) {
      void this.alerts.workerCrashLoop(this.botConfig.id, failures);
    }

    if (this.stopping) return;

    const backoff = nextBackoffMs(
      failures - 1,
      this.config.worker_tuning.crash_loop_backoff_base_ms,
      this.config.worker_tuning.crash_loop_backoff_cap_ms,
    );
    this.log.info("scheduling runner restart", {
      failures,
      backoff_ms: backoff,
    });
    this.db.updateWorkerState(this.botConfig.id, { status: "restarting" });

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      void this.runner.start().catch((err) => {
        this.log.error("runner restart failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, backoff);
  }

  private onRateLimit(ev: Extract<RunnerEvent, { kind: "rate_limit" }>): void {
    this.log.warn("rate limited", { retry_after_ms: ev.retry_after_ms });
  }

  private instantiateRunner(): AgentRunner {
    const configured = this.botConfig.runner;
    const brokerEnv =
      this.buzzBroker?.runnerEnvironment(this.botConfig.id) ?? {};
    const runnerConfig = {
      ...configured,
      env: { ...configured.env, ...brokerEnv },
    } as typeof configured;
    const logDir = `${this.config.gateway.data_dir}/logs`;
    if (runnerConfig.type === "claude-code") {
      // freshSession defaults to true in the runner, which is the right
      // default for tests but wrong for production: it would force the
      // first spawn after every gateway restart to omit `--continue`,
      // losing the conversation. Pass false here so the persisted
      // on-disk Claude session resumes across restarts. Users who want a
      // truly stateless runner can still set `pass_continue_flag: false`
      // in the bot config.
      return new ClaudeCodeRunner({
        botId: this.botConfig.id,
        config: runnerConfig,
        logDir,
        freshSession: false,
      });
    }
    if (runnerConfig.type === "codex") {
      // Codex's thread_id is captured per-process by the JSONL parser. To
      // resume across gateway restarts we hydrate it from worker_state on
      // construction and persist any future change.
      const initialThreadId = runnerConfig.pass_resume_flag
        ? this.db.getCodexThreadId(this.botConfig.id)
        : null;
      return new CodexRunner({
        botId: this.botConfig.id,
        config: runnerConfig,
        logDir,
        initialThreadId,
        onThreadIdChanged: (id) =>
          this.db.setCodexThreadId(this.botConfig.id, id),
      });
    }
    return new CommandRunner({
      botId: this.botConfig.id,
      config: runnerConfig,
      logDir,
    });
  }
}
