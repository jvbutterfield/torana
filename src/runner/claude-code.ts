// ClaudeCodeRunner — wraps `claude --print --output-format stream-json ...`
// and translates its NDJSON into RunnerEvent.

import { spawn, type Subprocess } from "bun";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { BotId, ClaudeCodeRunnerConfig } from "../config/schema.js";
import { logger, type Logger } from "../log.js";
import type { Attachment } from "../telegram/types.js";
import {
  RunnerDoesNotSupportSideSessions,
  RunnerEventEmitter,
  type AgentRunner,
  type RunnerEvent,
  type RunnerEventHandler,
  type RunnerEventKind,
  type RunnerStatus,
  type SendTurnResult,
  type TurnId,
  type Unsubscribe,
} from "./types.js";
import { createClaudeNdjsonParser } from "./protocols/claude-ndjson.js";
import { encodeClaudeNdjsonTurn } from "./protocols/shared.js";

const DEFAULT_STARTUP_MS = 2_000;

export interface ClaudeCodeRunnerOptions {
  botId: BotId;
  config: ClaudeCodeRunnerConfig;
  logDir: string;
  /** When true, the first spawn after reset() omits --continue. Default true for first start. */
  freshSession?: boolean;
  /** Test hook — override spawn. */
  spawnImpl?: typeof spawn;
  /** Test hook — override log dir creation. */
  ensureLogDir?: (dir: string) => Promise<void>;
  /** Test hook — fallback time before forcing ready. Default {@link DEFAULT_STARTUP_MS}. */
  startupMs?: number;
  /**
   * Test hook — override the protocol-required flags prepended to the CLI
   * invocation. Production always uses {@link ClaudeCodeRunner.PROTOCOL_FLAGS};
   * tests can pass `[]` to run a mock binary without the real claude flags
   * bleeding into its argv.
   */
  protocolFlags?: string[];
}

export class ClaudeCodeRunner implements AgentRunner {
  readonly botId: BotId;
  private config: ClaudeCodeRunnerConfig;
  private logDir: string;
  private spawnImpl: typeof spawn;
  private ensureLogDir: (dir: string) => Promise<void>;
  private log: Logger;
  private emitter = new RunnerEventEmitter();

  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private logStream: WriteStream | null = null;
  private status: RunnerStatus = "stopped";
  private activeTurn: TurnId | null = null;
  private pendingFreshSession: boolean;
  private stdoutRemainder = "";
  private stderrBuffer: string[] = [];
  private stopping = false;
  private startupMs: number;
  private protocolFlags: readonly string[];

  constructor(opts: ClaudeCodeRunnerOptions) {
    this.botId = opts.botId;
    this.config = opts.config;
    this.logDir = opts.logDir;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.ensureLogDir =
      opts.ensureLogDir ??
      (async (dir) => {
        await mkdir(dir, { recursive: true });
      });
    this.log = logger("runner.claude-code", { bot_id: opts.botId });
    this.pendingFreshSession = opts.freshSession ?? true;
    this.startupMs = opts.startupMs ?? DEFAULT_STARTUP_MS;
    this.protocolFlags = opts.protocolFlags ?? ClaudeCodeRunner.PROTOCOL_FLAGS;
  }

  on<E extends RunnerEventKind>(event: E, handler: RunnerEventHandler<E>): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  isReady(): boolean {
    return this.status === "ready";
  }

  supportsReset(): boolean {
    return true;
  }

  async start(): Promise<void> {
    if (this.status !== "stopped") {
      throw new Error(
        `ClaudeCodeRunner.start() called in state '${this.status}' for bot '${this.botId}'`,
      );
    }
    this.stopping = false;
    await this.spawnOnce();
  }

  async stop(graceMs = 5000): Promise<void> {
    this.stopping = true;
    this.status = "stopping";
    const proc = this.proc;
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      // Wait up to graceMs for clean exit; then SIGKILL.
      const killer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ok */
        }
      }, graceMs);
      try {
        await proc.exited;
      } catch {
        /* ignore */
      }
      clearTimeout(killer);
      this.proc = null;
    }
    this.logStream?.end();
    this.logStream = null;
    this.status = "stopped";
  }

  async reset(): Promise<void> {
    if (this.activeTurn) {
      throw new Error(
        `ClaudeCodeRunner.reset() called while turn '${this.activeTurn}' is in flight`,
      );
    }
    this.pendingFreshSession = true;
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
    // watchExit will pick up pendingFreshSession and respawn without --continue.
  }

  // ---------- Side sessions (stub — full implementation in Phase 2) ----------

  supportsSideSessions(): boolean {
    return false;
  }

  async startSideSession(_sessionId: string): Promise<void> {
    throw new RunnerDoesNotSupportSideSessions();
  }

  sendSideTurn(
    _sessionId: string,
    _turnId: TurnId,
    _text: string,
    _attachments: Attachment[],
  ): SendTurnResult {
    throw new RunnerDoesNotSupportSideSessions();
  }

  async stopSideSession(_sessionId: string, _graceMs?: number): Promise<void> {
    throw new RunnerDoesNotSupportSideSessions();
  }

  onSide<E extends RunnerEventKind>(
    _sessionId: string,
    _event: E,
    _handler: RunnerEventHandler<E>,
  ): Unsubscribe {
    throw new RunnerDoesNotSupportSideSessions();
  }

  sendTurn(turnId: TurnId, text: string, attachments: Attachment[]): SendTurnResult {
    // Order matters: a runner mid-turn has status "busy", and the caller
    // needs to distinguish that from "hasn't finished starting yet".
    if (this.activeTurn !== null) {
      return { accepted: false, reason: "busy" };
    }
    if (this.status !== "ready" || !this.proc) {
      return { accepted: false, reason: "not_ready" };
    }

    try {
      const stdin = this.proc.stdin;
      stdin.write(encodeClaudeNdjsonTurn(text, attachments));
      stdin.flush();
    } catch (err) {
      this.log.error("stdin write failed", { error: String(err) });
      return { accepted: false, reason: "not_ready" };
    }

    this.activeTurn = turnId;
    this.status = "busy";
    return { accepted: true, turnId };
  }

  // --- internals ---

  private async spawnOnce(): Promise<void> {
    if (this.stopping) return;

    await this.ensureLogDir(this.logDir);
    const logPath = resolve(this.logDir, `${this.botId}.log`);
    await this.ensureLogDir(dirname(logPath));
    this.logStream = createWriteStream(logPath, { flags: "a" });

    const fresh = this.pendingFreshSession;
    this.pendingFreshSession = false;

    const args = this.buildArgs(fresh);
    this.log.info("spawning runner", { cli_path: this.config.cli_path, fresh });

    this.status = "starting";
    this.stdoutRemainder = "";
    this.stderrBuffer = [];

    const env = this.buildEnv();
    try {
      this.proc = this.spawnImpl({
        cmd: [this.config.cli_path, ...args],
        cwd: this.config.cwd ?? process.cwd(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
      }) as Subprocess<"pipe", "pipe", "pipe">;
    } catch (err) {
      this.log.error("spawn failed", { error: String(err) });
      this.emitter.emit({
        kind: "fatal",
        code: "spawn",
        message: err instanceof Error ? err.message : String(err),
      });
      this.status = "stopped";
      return;
    }

    void this.readStdout(this.proc);
    void this.readStderr(this.proc);
    void this.watchExit(this.proc);

    // Readiness: the parser emits "ready" on {type:"system", subtype:"init"}
    // and dispatchEvent promotes status at that point. The timer below is a
    // fallback for older Claude CLI builds that don't emit init before stdin
    // is drained.
    setTimeout(() => {
      if (this.status === "starting" && this.proc) {
        this.status = "ready";
        this.emitter.emit({ kind: "ready" });
      }
    }, this.startupMs);
  }

  // Protocol-required flags — these make the CLI emit the NDJSON shape
  // torana parses. Not user-configurable.
  private static readonly PROTOCOL_FLAGS = Object.freeze([
    "--print",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--replay-user-messages",
    "--verbose",
    "--dangerously-skip-permissions",
  ]);

  private buildArgs(freshSession: boolean): string[] {
    const base = [...this.protocolFlags, ...this.config.args];
    if (this.config.pass_continue_flag && !freshSession && !base.includes("--continue")) {
      base.push("--continue");
    }
    return base;
  }

  private buildEnv(): Record<string, string> {
    // runner.env is the complete env except PATH, which inherits by default.
    const env: Record<string, string> = { ...this.config.env };
    if (!("PATH" in env)) {
      env.PATH = process.env.PATH ?? "";
    } else if (env.PATH === "") {
      delete env.PATH;
    }
    return env;
  }

  private async readStdout(proc: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const parser = createClaudeNdjsonParser({
      currentTurnId: () => this.activeTurn,
    });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        this.logStream?.write(chunk);
        parser.feed(chunk, (ev) => this.dispatchEvent(ev));
      }
      parser.flush((ev) => this.dispatchEvent(ev));
    } catch (err) {
      if (!this.stopping) {
        this.log.warn("stdout read error", { error: String(err) });
      }
    }
  }

  private async readStderr(proc: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        this.logStream?.write(`[stderr] ${text}`);
        for (const line of text.split("\n")) {
          if (line.trim()) {
            this.stderrBuffer.push(line.trim());
            if (this.stderrBuffer.length > 50) this.stderrBuffer.shift();
          }
        }
      }
    } catch {
      /* expected on exit */
    }
  }

  private async watchExit(proc: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    const exitCode = await proc.exited;
    if (this.proc !== proc) return; // stale

    this.logStream?.end();
    this.logStream = null;
    this.proc = null;

    if (this.stopping) return;

    this.log.warn("subprocess exited", { code: exitCode, hadTurn: this.activeTurn !== null });

    // Fresh-session respawn always wins over fatal — it's a requested restart.
    if (this.pendingFreshSession) {
      this.status = "starting";
      await this.spawnOnce();
      return;
    }

    // Synthesize fatal/exit if no explicit fatal has been emitted by the parser.
    // Never include the stderr tail in `ev.message`: it flows through the Bot
    // layer into persisted state that a redactor can't know about (upstream
    // API keys in a stack trace, etc.). The full stderr is already captured
    // to the per-bot log file for operator debugging.
    const fatalCode: "auth" | "exit" = this.looksLikeAuthFailure() ? "auth" : "exit";
    this.emitter.emit({
      kind: "fatal",
      code: fatalCode,
      message: `claude subprocess exited with code ${exitCode}`,
    });
    this.activeTurn = null;
    this.status = "stopped";
  }

  private dispatchEvent(ev: RunnerEvent): void {
    if (ev.kind === "ready" && this.status === "starting") {
      this.status = "ready";
    }
    if (ev.kind === "done" || ev.kind === "error") {
      this.activeTurn = null;
      // Don't flip to "ready" if we're already tearing down — the subprocess
      // could be about to exit, and promoting status would let sendTurn race
      // into a dead pipe.
      if (this.status === "busy") this.status = "ready";
    }
    this.emitter.emit(ev);
  }

  private looksLikeAuthFailure(): boolean {
    const blob = this.stderrBuffer.join(" ").toLowerCase();
    return (
      blob.includes("unauthorized") ||
      blob.includes("authentication") ||
      blob.includes("oauth") ||
      blob.includes("not logged in")
    );
  }
}
