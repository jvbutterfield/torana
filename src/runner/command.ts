// CommandRunner — spawns any subprocess and speaks one of the three built-in
// line protocols (jsonl-text, claude-ndjson, codex-jsonl). Reset behavior
// depends on `on_reset`: "signal" sends a reset envelope on stdin, "restart"
// kills and respawns.
//
// Side-sessions (Phase 2c, US-007) are supported for `claude-ndjson` and
// `codex-jsonl` protocols. Each side-session runs as its own long-lived
// subprocess (the user's `cmd` re-spawned) with `TORANA_SESSION_ID=<id>` in
// env so the user's wrapper can distinguish main vs side. Events parsed
// from a side-session's stdout flow *only* to that session's emitter — never
// to the main emitter, never to another side session. `jsonl-text` has no
// session semantics and throws `RunnerDoesNotSupportSideSessions` from the
// side-session methods.

import { spawn, type Subprocess } from "bun";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { BotId, CommandRunnerConfig } from "../config/schema.js";
import { logger, type Logger } from "../log.js";
import type { Attachment } from "../telegram/types.js";
import {
  InvalidSideSessionId,
  RunnerDoesNotSupportSideSessions,
  RunnerEventEmitter,
  SIDE_SESSION_ID_REGEX,
  SideSessionAlreadyExists,
  SideSessionNotFound,
  type AgentRunner,
  type RunnerEvent,
  type RunnerEventHandler,
  type RunnerEventKind,
  type RunnerStatus,
  type SendTurnResult,
  type TurnId,
  type Unsubscribe,
} from "./types.js";
import {
  claudeNdjsonCapabilities,
  createClaudeNdjsonParser,
} from "./protocols/claude-ndjson.js";
import {
  codexJsonlCapabilities,
  createCodexJsonlParser,
} from "./protocols/codex-jsonl.js";
import {
  createJsonlTextParser,
  encodeReset,
  encodeTurn,
  jsonlTextCapabilities,
} from "./protocols/jsonl-text.js";
import {
  encodeClaudeNdjsonTurn,
  type ProtocolCapabilities,
} from "./protocols/shared.js";

const DEFAULT_SIDE_STARTUP_MS = 2_000;

interface CommandSideSession {
  id: string;
  emitter: RunnerEventEmitter;
  proc: Subprocess<"pipe", "pipe", "pipe"> | null;
  logStream: WriteStream | null;
  status: "starting" | "ready" | "busy" | "stopping" | "stopped";
  activeTurn: TurnId | null;
  stopping: boolean;
  stopPromise: Promise<void> | null;
  readyPromise: Promise<void> | null;
  resolveReady: (() => void) | null;
  rejectReady: ((err: Error) => void) | null;
}

export interface CommandRunnerOptions {
  botId: BotId;
  config: CommandRunnerConfig;
  logDir: string;
  spawnImpl?: typeof spawn;
  ensureLogDir?: (dir: string) => Promise<void>;
  /** Test hook — fallback ms before forcing side-session ready if the parser
   *  never emits an explicit ready event. */
  sideStartupMs?: number;
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
  private sideStartupMs: number;

  // Side-session state — one long-lived subprocess per (botId, sessionId),
  // each with its own emitter. Events from a side subprocess are routed
  // only to its emitter; never to the main emitter.
  private sideSessions = new Map<string, CommandSideSession>();

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
    this.sideStartupMs = opts.sideStartupMs ?? DEFAULT_SIDE_STARTUP_MS;
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

  // ---------- Side sessions (Phase 2c / US-007) ----------
  //
  // A side-session runs the user's `cmd` in a dedicated long-lived
  // subprocess with `TORANA_SESSION_ID=<id>` in env so the wrapper can
  // distinguish main vs side. Events parsed from the side subprocess
  // flow *only* to its emitter. For `jsonl-text` the concept has no
  // meaning and the methods throw.

  supportsSideSessions(): boolean {
    return this.protocolCapabilities().sideSessions;
  }

  async startSideSession(sessionId: string): Promise<void> {
    this.requireSideSessionSupport();
    if (!SIDE_SESSION_ID_REGEX.test(sessionId)) {
      throw new InvalidSideSessionId(sessionId);
    }
    if (this.sideSessions.has(sessionId)) {
      throw new SideSessionAlreadyExists(sessionId);
    }

    await this.ensureLogDir(this.logDir);

    const entry: CommandSideSession = {
      id: sessionId,
      emitter: new RunnerEventEmitter(),
      proc: null,
      logStream: null,
      status: "starting",
      activeTurn: null,
      stopping: false,
      stopPromise: null,
      readyPromise: null,
      resolveReady: null,
      rejectReady: null,
    };
    entry.readyPromise = new Promise<void>((resolve, reject) => {
      entry.resolveReady = resolve;
      entry.rejectReady = reject;
    });
    this.sideSessions.set(sessionId, entry);

    try {
      const env = this.buildEnv();
      env.TORANA_SESSION_ID = sessionId;

      entry.proc = this.spawnImpl({
        cmd: this.config.cmd,
        cwd: this.config.cwd ?? process.cwd(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
      }) as Subprocess<"pipe", "pipe", "pipe">;
      entry.logStream = createWriteStream(
        resolve(this.logDir, `${this.botId}.side.${sessionId}.log`),
        { flags: "a" },
      );

      void this.pumpSideStdout(entry);
      void this.pumpSideStderr(entry);
      void this.watchSideExit(entry);

      // Ready gate: parser fires {kind:"ready"} from the protocol's startup
      // signal, or we fall back after sideStartupMs so a wrapper that forgets
      // the initial event doesn't strand the caller.
      const timer = setTimeout(() => {
        if (entry.status === "starting") {
          entry.status = "ready";
          entry.emitter.emit({ kind: "ready" });
          entry.resolveReady?.();
          entry.resolveReady = null;
          entry.rejectReady = null;
        }
      }, this.sideStartupMs);
      (timer as unknown as { unref?: () => void }).unref?.();

      await entry.readyPromise;
    } catch (err) {
      // Spawn/setup failure: scrub the entry so pool retry works cleanly.
      entry.status = "stopped";
      try {
        entry.proc?.kill();
      } catch {
        /* already dead */
      }
      try {
        entry.logStream?.end();
      } catch {
        /* best-effort */
      }
      this.sideSessions.delete(sessionId);
      throw err;
    }
  }

  sendSideTurn(
    sessionId: string,
    turnId: TurnId,
    text: string,
    attachments: Attachment[],
  ): SendTurnResult {
    this.requireSideSessionSupport();
    const entry = this.sideSessions.get(sessionId);
    if (!entry || entry.status === "stopping" || entry.status === "stopped") {
      return { accepted: false, reason: "not_ready" };
    }
    // Busy check BEFORE readiness — a session mid-turn surfaces "busy" so
    // the pool can return 429 instead of 500 for legitimate contention.
    if (entry.activeTurn !== null) {
      return { accepted: false, reason: "busy" };
    }
    if (entry.status !== "ready" || !entry.proc) {
      return { accepted: false, reason: "not_ready" };
    }

    // For claude-ndjson the user envelope has no turn_id field; for
    // codex-jsonl we reuse the jsonl-text envelope (current CommandRunner
    // main-runner behavior).
    const payload =
      this.config.protocol === "claude-ndjson"
        ? encodeClaudeNdjsonTurn(text, attachments)
        : encodeTurn(turnId, text, attachments);

    try {
      entry.proc.stdin.write(payload);
      entry.proc.stdin.flush();
    } catch (err) {
      this.log.warn("side-session stdin write failed", {
        session_id: sessionId,
        error: String(err),
      });
      return { accepted: false, reason: "not_ready" };
    }

    entry.activeTurn = turnId;
    entry.status = "busy";
    return { accepted: true, turnId };
  }

  async stopSideSession(sessionId: string, graceMs = 5000): Promise<void> {
    this.requireSideSessionSupport();
    const entry = this.sideSessions.get(sessionId);
    if (!entry) return;
    if (entry.stopPromise) return entry.stopPromise;

    entry.stopping = true;
    entry.status = "stopping";
    entry.stopPromise = (async () => {
      const proc = entry.proc;
      if (proc) {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* already dead */
        }
        const killer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ok */
          }
        }, graceMs);
        (killer as unknown as { unref?: () => void }).unref?.();
        try {
          await proc.exited;
        } catch {
          /* ignore */
        }
        clearTimeout(killer);
      }
      try {
        entry.logStream?.end();
      } catch {
        /* ok */
      }
      entry.proc = null;
      entry.logStream = null;
      entry.status = "stopped";
      this.sideSessions.delete(sessionId);
    })();
    return entry.stopPromise;
  }

  onSide<E extends RunnerEventKind>(
    sessionId: string,
    event: E,
    handler: RunnerEventHandler<E>,
  ): Unsubscribe {
    this.requireSideSessionSupport();
    const entry = this.sideSessions.get(sessionId);
    if (!entry) throw new SideSessionNotFound(sessionId);
    return entry.emitter.on(event, handler);
  }

  private requireSideSessionSupport(): void {
    if (!this.protocolCapabilities().sideSessions) {
      throw new RunnerDoesNotSupportSideSessions(
        `command runner with protocol '${this.config.protocol}' does not support side sessions`,
      );
    }
  }

  private protocolCapabilities(): ProtocolCapabilities {
    switch (this.config.protocol) {
      case "claude-ndjson":
        return claudeNdjsonCapabilities;
      case "codex-jsonl":
        return codexJsonlCapabilities;
      case "jsonl-text":
        return jsonlTextCapabilities;
      default:
        // zod schema restricts protocol to the three above; default is
        // defensive and matches the safe-by-default posture.
        return { sideSessions: false };
    }
  }

  private async pumpSideStdout(entry: CommandSideSession): Promise<void> {
    const proc = entry.proc;
    if (!proc) return;
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const parser =
      this.config.protocol === "claude-ndjson"
        ? createClaudeNdjsonParser({ currentTurnId: () => entry.activeTurn })
        : createCodexJsonlParser({ currentTurnId: () => entry.activeTurn });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        entry.logStream?.write(chunk);
        parser.feed(chunk, (ev) => this.dispatchSide(entry, ev));
      }
      parser.flush((ev) => this.dispatchSide(entry, ev));
    } catch (err) {
      if (!entry.stopping) {
        this.log.warn("side-session stdout read error", {
          session_id: entry.id,
          error: String(err),
        });
      }
    }
  }

  private async pumpSideStderr(entry: CommandSideSession): Promise<void> {
    const proc = entry.proc;
    if (!proc) return;
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        entry.logStream?.write(`[stderr] ${text}`);
      }
    } catch {
      /* expected on exit */
    }
  }

  private async watchSideExit(entry: CommandSideSession): Promise<void> {
    const proc = entry.proc;
    if (!proc) return;
    const code = await proc.exited;
    if (entry.proc !== proc) return;
    try {
      entry.logStream?.end();
    } catch {
      /* ok */
    }
    entry.proc = null;
    entry.logStream = null;

    if (entry.stopping) {
      // Expected teardown; stopSideSession handles state transitions.
      return;
    }

    // Unexpected exit: route fatal to the side-session emitter only.
    entry.status = "stopped";
    entry.activeTurn = null;
    if (entry.resolveReady) {
      entry.rejectReady?.(
        new Error(
          `command side-session subprocess exited before ready (code=${code})`,
        ),
      );
      entry.resolveReady = null;
      entry.rejectReady = null;
    }
    entry.emitter.emit({
      kind: "fatal",
      code: "exit",
      message: `command side-session subprocess exited with code ${code}`,
    });
  }

  private dispatchSide(entry: CommandSideSession, ev: RunnerEvent): void {
    if (ev.kind === "ready" && entry.status === "starting") {
      entry.status = "ready";
      entry.emitter.emit(ev);
      entry.resolveReady?.();
      entry.resolveReady = null;
      entry.rejectReady = null;
      return;
    }
    if (ev.kind === "done" || ev.kind === "error") {
      entry.activeTurn = null;
      if (entry.status === "busy") entry.status = "ready";
    }
    entry.emitter.emit(ev);
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
        `on_reset=signal is a no-op for ${this.config.protocol} protocol; consider on_reset=restart`,
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

    // Stdin envelope by protocol. `codex-jsonl` reuses the jsonl-text envelope
    // shape because Codex itself doesn't accept stdin envelopes — wrappers
    // around the codex CLI multiplex turns themselves.
    const payload =
      this.config.protocol === "claude-ndjson"
        ? encodeClaudeNdjsonTurn(text, attachments)
        : encodeTurn(turnId, text, attachments);

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
        : this.config.protocol === "claude-ndjson"
          ? createClaudeNdjsonParser({ currentTurnId: () => this.activeTurn })
          : createCodexJsonlParser({ currentTurnId: () => this.activeTurn });

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
