import { spawn } from "bun";
import { logger } from "./log.js";
import { type GatewayDB } from "./db.js";
import type { Config, PersonaName } from "./config.js";
import type { Metrics } from "./metrics.js";
import type { AlertManager } from "./alerts.js";
import { createWriteStream, type WriteStream } from "node:fs";

const log = logger("worker");

// --- Event types from the spike ---

export interface SystemEvent {
  type: "system";
  subtype: string;
  session_id: string;
  tools?: string[];
}

export interface StreamEvent {
  type: "stream_event";
  event: {
    type: string;
    index?: number;
    content_block?: { type: string };
    delta?: { type: string; text?: string; thinking?: string };
    message?: { model?: string; id?: string };
  };
  session_id: string;
  uuid?: string;
}

export interface UserEvent {
  type: "user";
  message: { role: string; content: string };
  isReplay?: boolean;
  timestamp?: string;
}

export interface AssistantEvent {
  type: "assistant";
  message: {
    role: string;
    content: Array<{ type: string; text?: string }>;
  };
}

export interface ResultEvent {
  type: "result";
  subtype: string;
  is_error: boolean;
  duration_ms: number;
  result: string;
  stop_reason: string;
  session_id: string;
}

export interface RateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: { status: string; rateLimitType: string };
}

export type WorkerEvent = SystemEvent | StreamEvent | UserEvent | AssistantEvent | ResultEvent | RateLimitEvent | { type: string };

export type WorkerStatus = "starting" | "ready" | "busy" | "restarting" | "degraded";

export type WorkerEventHandler = (persona: PersonaName, event: WorkerEvent) => void;

export class WorkerManager {
  private config: Config;
  private db: GatewayDB;
  private persona: PersonaName;
  private metrics: Metrics;
  private alerts: AlertManager;
  private proc: any = null;
  private generation = 0;
  private status: WorkerStatus = "starting";
  private stderrBuffer: string[] = [];
  private logStream: WriteStream | null = null;
  private onEvent: WorkerEventHandler;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private turnTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private activeTurnId: number | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private stdoutRemainder = "";
  private restartStartedAt: number | null = null;
  private pendingFreshRestart = false;
  private onReadyCallback: (() => void) | null = null;

  constructor(config: Config, db: GatewayDB, persona: PersonaName, metrics: Metrics, alerts: AlertManager, onEvent: WorkerEventHandler) {
    this.config = config;
    this.db = db;
    this.persona = persona;
    this.metrics = metrics;
    this.alerts = alerts;
    this.onEvent = onEvent;
  }

  getStatus(): WorkerStatus { return this.status; }
  getGeneration(): number { return this.generation; }
  getActiveTurnId(): number | null { return this.activeTurnId; }
  isIdle(): boolean { return this.status === "ready" && this.activeTurnId === null; }

  /**
   * Request a fresh session restart — spawns Claude WITHOUT --continue so the
   * conversation history is cleared. Safe to call at any time:
   *   - If idle: kills the current proc immediately; watchExit respawns fresh.
   *   - If busy: defers the kill until turnCompleted() is called so the active
   *     turn can finish before the session is wiped.
   * The optional onReady callback is invoked once the new worker reaches
   * "ready" status (the 2-second startup settle timer in spawnWorker).
   */
  freshRestart(onReady?: () => void) {
    log.info("fresh restart requested", { persona: this.persona, status: this.status });
    this.pendingFreshRestart = true;
    this.onReadyCallback = onReady ?? null;
    if (this.isIdle()) {
      // Kill now — watchExit will spawn fresh
      this.killWorker();
    }
    // If busy: deferred — turnCompleted() will kill after the turn finishes.
    // If proc is null / still starting: pendingFreshRestart will be picked up
    // by the next spawnWorker() call regardless.
  }

  async start() {
    this.db.initWorkerState(this.persona);
    await this.spawnWorker();
  }

  private async spawnWorker() {
    if (this.stopping) return;

    this.generation = this.db.incrementWorkerGeneration(this.persona);
    this.setStatus("starting");

    const logPath = `${this.config.dataRoot}/logs/claude-${this.persona}.log`;
    this.logStream = createWriteStream(logPath, { flags: "a" });

    // Fresh restart: launch WITHOUT --continue to wipe the session.
    // Clear the flag here so subsequent automatic crash-restarts use --continue.
    const isFreshRestart = this.pendingFreshRestart;
    this.pendingFreshRestart = false;

    const cmd = [
      "claude",
      "--print",
      ...(isFreshRestart ? [] : ["--continue"]),
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--include-partial-messages",
      "--replay-user-messages",
      "--verbose",
      "--dangerously-skip-permissions",
      "--agent", this.persona,
    ];

    log.info("spawning worker", { persona: this.persona, generation: this.generation });

    const proc = spawn({
      cmd,
      cwd: process.env.WORKER_CWD || "/app",
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        HOME: "/home/node",
        PERSONA: this.persona,
        CLAUDE_CONFIG_DIR: `${this.config.dataRoot}/state/claude-config/${this.persona}`,
        CLAUDE_CODE_OAUTH_TOKEN: this.config.oauthToken,
        GITHUB_TOKEN: this.config.githubToken,
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_AUTOUPDATER: "1",
        // PATH is set by entrypoint.sh to include /data/shared/tools/bin so
        // runtime-installed CLIs (npm/pip) are available without a redeploy
        PATH: process.env.PATH || "",
        // Runtime tool install prefix — see entrypoint.sh for the full setup.
        // Forwarding these to workers so `npm install -g X` and `pip install X`
        // from inside a claude session land on the persistent volume.
        AGENT_TOOLS_PREFIX: process.env.AGENT_TOOLS_PREFIX || "",
        NPM_CONFIG_PREFIX: process.env.NPM_CONFIG_PREFIX || "",
        NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE || "",
        PIP_TARGET: process.env.PIP_TARGET || "",
        PIP_CACHE_DIR: process.env.PIP_CACHE_DIR || "",
        PYTHONPATH: process.env.PYTHONPATH || "",
      },
    });

    this.proc = proc;
    this.stderrBuffer = [];
    this.stdoutRemainder = "";

    this.db.updateWorkerState(this.persona, {
      pid: proc.pid,
      generation: this.generation,
      status: "starting",
      started_at: new Date().toISOString(),
    });

    // Read stdout
    this.readStdout(proc);
    // Read stderr
    this.readStderr(proc);
    // Watch for exit
    this.watchExit(proc);

    // Readiness: wait a short period then mark ready if alive
    setTimeout(() => {
      if (this.proc === proc && this.status === "starting") {
        this.setStatus("ready");
        if (this.restartStartedAt) {
          this.metrics.recordTimer(this.persona, "last_restart_recovery_ms", Date.now() - this.restartStartedAt);
          this.restartStartedAt = null;
        }
        // Fire the fresh-restart ready callback (e.g. to send the confirmation message)
        if (this.onReadyCallback) {
          const cb = this.onReadyCallback;
          this.onReadyCallback = null;
          cb();
        }
        log.info("worker ready", { persona: this.persona, generation: this.generation, pid: proc.pid });
      }
    }, 2000);
  }

  private async readStdout(proc: any) {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        this.logStream?.write(chunk);

        // Parse NDJSON lines
        this.stdoutRemainder += chunk;
        const lines = this.stdoutRemainder.split("\n");
        this.stdoutRemainder = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as WorkerEvent;
            this.handleEvent(event);
          } catch {
            this.logStream?.write(`[non-json] ${trimmed}\n`);
          }
        }
      }
    } catch (err) {
      if (!this.stopping) {
        log.warn("stdout read error", { persona: this.persona, error: String(err) });
      }
    }
  }

  private async readStderr(proc: any) {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        this.logStream?.write(`[stderr] ${text}`);

        // Buffer recent stderr for error reports
        for (const line of text.split("\n")) {
          if (line.trim()) {
            this.stderrBuffer.push(line.trim());
            if (this.stderrBuffer.length > 50) this.stderrBuffer.shift();
          }
        }
      }
    } catch {
      // expected on process exit
    }
  }

  private async watchExit(proc: any) {
    const exitCode = await proc.exited;

    if (this.proc !== proc) return; // stale

    this.logStream?.end();
    this.logStream = null;

    if (this.stopping) {
      log.info("worker stopped cleanly", { persona: this.persona, exitCode });
      return;
    }

    log.warn("worker exited unexpectedly", {
      persona: this.persona,
      exitCode,
      generation: this.generation,
      hadActiveTurn: this.activeTurnId !== null,
    });

    // Handle active turn failure
    if (this.activeTurnId !== null) {
      this.handleTurnFailure(exitCode);
    }

    this.clearTimers();
    this.proc = null;

    this.metrics.inc(this.persona, "worker_restarts");

    // Fresh restart requested — skip consecutive_failures, auth check, and backoff.
    // pendingFreshRestart is cleared inside spawnWorker() after the cmd is built,
    // so only this one spawn omits --continue; all subsequent restarts use --continue.
    if (this.pendingFreshRestart) {
      log.info("fresh restart: spawning without --continue", { persona: this.persona });
      this.setStatus("restarting");
      this.restartStartedAt = Date.now();
      this.spawnWorker();
      return;
    }

    // Check for auth failure
    if (this.isAuthError()) {
      log.error("auth failure detected", { persona: this.persona });
      this.setStatus("degraded");
      this.db.updateWorkerState(this.persona, {
        status: "degraded",
        last_error: "Auth failure — check CLAUDE_CODE_OAUTH_TOKEN",
      });
      this.metrics.inc(this.persona, "worker_startup_failures");
      this.alerts.workerDegraded(this.persona, "Auth failure — check CLAUDE_CODE_OAUTH_TOKEN");
      return;
    }

    // Restart with backoff
    const state = this.db.getWorkerState(this.persona);
    const failures = (state?.consecutive_failures ?? 0) + 1;
    this.db.updateWorkerState(this.persona, {
      consecutive_failures: failures,
      last_error: `exit code ${exitCode}`,
    });

    if (failures >= this.config.maxConsecutiveFailures) {
      log.error("max consecutive failures reached", { persona: this.persona, failures });
      this.setStatus("degraded");
      this.db.updateWorkerState(this.persona, { status: "degraded" });
      this.alerts.workerDegraded(this.persona, `${failures} consecutive failures — stopped retrying`);
      return;
    }

    if (failures >= 3) {
      this.alerts.workerCrashLoop(this.persona, failures);
    }

    const backoff = Math.min(
      this.config.crashLoopBackoffBaseMs * Math.pow(2, failures - 1),
      this.config.crashLoopBackoffCapMs,
    );

    log.info("scheduling restart", { persona: this.persona, backoffMs: backoff, failures });
    this.setStatus("restarting");
    this.restartStartedAt = Date.now();

    this.restartTimer = setTimeout(() => {
      this.spawnWorker();
    }, backoff);
  }

  private lastEventDbWrite = 0;
  private static EVENT_DB_WRITE_INTERVAL = 5_000; // Throttle DB heartbeat to every 5s

  private handleEvent(event: WorkerEvent) {
    this.resetStallTimer();

    // Throttle the DB heartbeat write — stall detection uses in-memory timers,
    // the DB timestamp is only for crash-recovery observability
    const now = Date.now();
    if (now - this.lastEventDbWrite >= WorkerManager.EVENT_DB_WRITE_INTERVAL) {
      this.lastEventDbWrite = now;
      this.db.updateWorkerState(this.persona, { last_event_at: new Date().toISOString() });
    }

    this.onEvent(this.persona, event);
  }

  private handleTurnFailure(exitCode: number) {
    const turnId = this.activeTurnId!;
    const turn = this.db.getStreamState(turnId);
    const hadOutput = turn?.buffer_text && turn.buffer_text.length > 0;

    if (hadOutput) {
      this.db.interruptTurn(turnId, `Worker exited (code ${exitCode}) after partial output`);
    } else {
      // No output — will be retried after restart
      this.db.interruptTurn(turnId, `Worker exited (code ${exitCode}) before output`);
    }

    this.activeTurnId = null;
  }

  private isAuthError(): boolean {
    const combined = this.stderrBuffer.join(" ").toLowerCase();
    return combined.includes("oauth") ||
      combined.includes("authentication") ||
      combined.includes("unauthorized") ||
      combined.includes("not logged in");
  }

  /** Send a turn to the worker. */
  sendTurn(turnId: number, text: string, attachments: string[]) {
    if (!this.proc || this.status !== "ready") {
      log.warn("cannot send turn — worker not ready", { persona: this.persona, status: this.status });
      return false;
    }

    this.activeTurnId = turnId;
    this.setStatus("busy");

    // Build content: plain text, or text + attachment references
    let content: string;
    if (attachments.length > 0) {
      const paths = attachments.map(p => `[Attached file: ${p}]`).join("\n");
      content = `${text}\n\n${paths}`;
    } else {
      content = text;
    }

    const input = {
      type: "user",
      message: {
        role: "user",
        content,
      },
    };

    const inputJson = JSON.stringify(input) + "\n";

    try {
      const stdin = this.proc.stdin as import("bun").FileSink;
      stdin.write(inputJson);
      stdin.flush();
    } catch (err) {
      log.error("failed to write to worker stdin", { persona: this.persona, error: String(err) });
      return false;
    }

    this.db.startTurn(turnId, this.generation);
    this.startStallTimer();
    this.startTurnTimeout(turnId);

    log.info("turn dispatched", { persona: this.persona, turnId, generation: this.generation });
    return true;
  }

  /** Called by the orchestrator when a result event indicates turn completion. */
  turnCompleted() {
    this.activeTurnId = null;
    this.clearTimers();

    // Fresh restart was deferred until the turn finished — kill now so watchExit
    // picks it up and spawns without --continue.
    if (this.pendingFreshRestart) {
      log.info("killing worker for fresh restart after turn completed", { persona: this.persona });
      this.setStatus("restarting");
      this.killWorker();
      return;
    }

    this.setStatus("ready");

    // Reset consecutive failures after stability window
    const state = this.db.getWorkerState(this.persona);
    if (state && state.consecutive_failures > 0) {
      this.db.updateWorkerState(this.persona, { consecutive_failures: 0 });
    }
  }

  private setStatus(status: WorkerStatus) {
    this.status = status;
    const updates: Record<string, string | number | null> = { status };
    if (status === "ready") updates.last_ready_at = new Date().toISOString();
    this.db.updateWorkerState(this.persona, updates);
  }

  private startStallTimer() {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      log.warn("worker stalled — no events", { persona: this.persona, turnId: this.activeTurnId });
      if (this.activeTurnId !== null) {
        this.alerts.turnStalled(this.persona, this.activeTurnId);
      }
      // Second chance
      this.stallTimer = setTimeout(() => {
        log.error("worker stalled twice — terminating", { persona: this.persona, turnId: this.activeTurnId });
        this.killWorker();
      }, this.config.workerStallTimeoutMs);
    }, this.config.workerStallTimeoutMs);
  }

  private resetStallTimer() {
    if (this.activeTurnId !== null) {
      this.startStallTimer();
    }
  }

  private startTurnTimeout(turnId: number) {
    this.clearTurnTimeout();
    this.turnTimeoutTimer = setTimeout(() => {
      log.error("turn hard timeout", { persona: this.persona, turnId });
      this.killWorker();
    }, this.config.workerTurnTimeoutMs);
  }

  private clearStallTimer() {
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
  }

  private clearTurnTimeout() {
    if (this.turnTimeoutTimer) { clearTimeout(this.turnTimeoutTimer); this.turnTimeoutTimer = null; }
  }

  private clearTimers() {
    this.clearStallTimer();
    this.clearTurnTimeout();
  }

  private killWorker() {
    if (this.proc) {
      try { this.proc.kill("SIGTERM"); } catch { /* already dead */ }
    }
  }

  async stop() {
    this.stopping = true;
    this.clearTimers();
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.proc) {
      log.info("stopping worker", { persona: this.persona });
      try {
        this.proc.kill("SIGTERM");
        // Wait up to 10s for clean exit
        const timeout = setTimeout(() => {
          try { this.proc?.kill("SIGKILL"); } catch { /* ok */ }
        }, 10_000);
        await this.proc.exited;
        clearTimeout(timeout);
      } catch { /* ok */ }
    }
    this.logStream?.end();
  }
}
