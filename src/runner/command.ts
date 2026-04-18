// CommandRunner — spawns any subprocess and speaks one of the two built-in
// line protocols (jsonl-text or claude-ndjson). Reset behavior depends on
// `on_reset`: "signal" sends a reset envelope on stdin, "restart" kills and
// respawns.

import { spawn, type Subprocess } from "bun";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { BotId, CommandRunnerConfig } from "../config/schema.js";
import { logger, type Logger } from "../log.js";
import type { Attachment } from "../telegram/types.js";
import {
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
import {
  createJsonlTextParser,
  encodeReset,
  encodeTurn,
} from "./protocols/jsonl-text.js";
import { encodeClaudeNdjsonTurn } from "./protocols/shared.js";

export interface CommandRunnerOptions {
  botId: BotId;
  config: CommandRunnerConfig;
  logDir: string;
  spawnImpl?: typeof spawn;
  ensureLogDir?: (dir: string) => Promise<void>;
}

export class CommandRunner implements AgentRunner {
  readonly botId: BotId;
  private config: CommandRunnerConfig;
  private logDir: string;
  private spawnImpl: typeof spawn;
  private ensureLogDir: (dir: string) => Promise<void>;
  private log: Logger;
  private emitter = new RunnerEventEmitter();

  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private logStream: WriteStream | null = null;
  private status: RunnerStatus = "stopped";
  private activeTurn: TurnId | null = null;
  private stopping = false;

  constructor(opts: CommandRunnerOptions) {
    this.botId = opts.botId;
    this.config = opts.config;
    this.logDir = opts.logDir;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.ensureLogDir =
      opts.ensureLogDir ??
      (async (dir) => {
        await mkdir(dir, { recursive: true });
      });
    this.log = logger("runner.command", { bot_id: opts.botId });
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
      throw new Error(`CommandRunner.start() in state '${this.status}'`);
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
        /* dead */
      }
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
      throw new Error(`CommandRunner.reset() with in-flight turn '${this.activeTurn}'`);
    }
    if (!this.proc) return;

    if (this.config.on_reset === "restart") {
      this.stopping = false; // we'll respawn from watchExit
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* dead */
      }
      // watchExit respawns automatically; a "ready" event will follow.
      return;
    }

    // signal mode: send a reset envelope on stdin (only meaningful for jsonl-text).
    if (this.config.protocol !== "jsonl-text") {
      this.log.warn(
        "on_reset=signal is a no-op for claude-ndjson protocol; consider on_reset=restart",
      );
      return;
    }
    try {
      this.proc.stdin.write(encodeReset());
      this.proc.stdin.flush();
    } catch (err) {
      this.log.error("failed to send reset envelope", { error: String(err) });
    }
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

    const payload =
      this.config.protocol === "jsonl-text"
        ? encodeTurn(turnId, text, attachments)
        : encodeClaudeNdjsonTurn(text, attachments);

    try {
      this.proc.stdin.write(payload);
      this.proc.stdin.flush();
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

    const env = this.buildEnv();
    this.log.info("spawning runner", { cmd: this.config.cmd[0], protocol: this.config.protocol });
    this.status = "starting";

    try {
      this.proc = this.spawnImpl({
        cmd: this.config.cmd,
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

    // jsonl-text protocol emits its own "ready" when ready. claude-ndjson
    // does the same via {type:"system", subtype:"init"}. As a fallback —
    // if neither event arrives within startup_timeout_secs, the orchestrator
    // treats the runner as stuck. For MVP we wait for the explicit event and
    // promote to ready when it arrives. No timer fallback here; the bot
    // supervisor layer handles startup timeouts.
  }

  private buildEnv(): Record<string, string> {
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
    const parser =
      this.config.protocol === "jsonl-text"
        ? createJsonlTextParser()
        : createClaudeNdjsonParser({ currentTurnId: () => this.activeTurn });

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
      }
    } catch {
      /* expected on exit */
    }
  }

  private async watchExit(proc: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    const exitCode = await proc.exited;
    if (this.proc !== proc) return;

    this.logStream?.end();
    this.logStream = null;
    this.proc = null;

    if (this.stopping) return;

    this.log.warn("subprocess exited", { code: exitCode });
    this.emitter.emit({
      kind: "fatal",
      code: "exit",
      message: `command runner exited with code ${exitCode}`,
    });
    this.activeTurn = null;
    this.status = "stopped";
  }

  private dispatchEvent(ev: RunnerEvent): void {
    if (ev.kind === "ready" && (this.status === "starting" || this.status === "busy")) {
      this.status = "ready";
    }
    if (ev.kind === "done" || ev.kind === "error") {
      this.activeTurn = null;
      // Don't flip to "ready" if we're already tearing down.
      if (this.status === "busy") this.status = "ready";
    }
    this.emitter.emit(ev);
  }
}
