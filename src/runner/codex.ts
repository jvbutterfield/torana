// CodexRunner — wraps `codex exec --json …` for the OpenAI Codex CLI.
//
// Architectural difference from ClaudeCodeRunner: Codex is one-shot per turn.
// `codex exec` reads a prompt, runs to completion, and exits. There is no
// long-lived stdin envelope loop. So:
//
//   - `start()` only verifies the binary exists; no subprocess is spawned.
//     The runner emits `ready` immediately.
//   - `sendTurn()` spawns a fresh `codex exec` (or `codex exec resume <id>`)
//     each turn, pipes the user text on stdin, and parses the JSONL stream
//     on stdout until the subprocess exits or emits `turn.completed`.
//   - `reset()` clears the captured `thread_id`, so the next turn starts a
//     new Codex session.
//
// Codex doesn't deliver token-level streaming for the assistant message —
// `item.completed { agent_message }` arrives whole, so torana renders one
// streaming-edit per turn rather than incremental ones. This is an accepted
// limitation, documented in `docs/runners.md`.
//
// Non-image attachments are skipped with a warning (Codex's `--image` flag
// only accepts image files; documents would need a different ingestion path).

import { spawn, type Subprocess } from "bun";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { BotId, CodexRunnerConfig } from "../config/schema.js";
import { logger, redactString, type Logger } from "../log.js";
import type { Attachment } from "../telegram/types.js";
import {
  InvalidSideSessionId,
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
import { createCodexJsonlParser } from "./protocols/codex-jsonl.js";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);

export interface CodexRunnerOptions {
  botId: BotId;
  config: CodexRunnerConfig;
  logDir: string;
  spawnImpl?: typeof spawn;
  ensureLogDir?: (dir: string) => Promise<void>;
  /**
   * Test hook — override the protocol-required flags prepended to argv.
   * Production always uses {@link CodexRunner.PROTOCOL_FLAGS}; tests pass `[]`
   * so a mock binary doesn't see the real codex flags in its argv.
   */
  protocolFlags?: string[];
  /**
   * Seed `currentThreadId` so the first turn after construction issues
   * `codex exec resume <id>` instead of starting a fresh thread. The Bot
   * supplies the value persisted across the previous gateway run. Ignored
   * when `pass_resume_flag` is false.
   */
  initialThreadId?: string | null;
  /**
   * Notified whenever `currentThreadId` changes — both when a new thread is
   * captured from `thread.started` and when `reset()` clears it. The Bot
   * persists the value so the next gateway run can resume the same thread.
   */
  onThreadIdChanged?: (threadId: string | null) => void;
}

/**
 * Per-side-session state. Codex is one-shot per turn, so `currentProc` is
 * null between turns and `threadId` carries session continuity via
 * `codex exec resume <threadId>` on subsequent invocations.
 */
interface CodexSideSession {
  id: string;
  emitter: RunnerEventEmitter;
  threadId: string | null;
  status: "ready" | "busy" | "stopping" | "stopped";
  activeTurn: TurnId | null;
  currentProc: Subprocess<"pipe", "pipe", "pipe"> | null;
  logStream: WriteStream | null;
  stopping: boolean;
  stopPromise: Promise<void> | null;
  /** Set by dispatchSide on the first done/error so watchSideExit can decide whether to synthesize. */
  doneEmittedForCurrentTurn: boolean;
  stderrBuffer: string[];
}

export class CodexRunner implements AgentRunner {
  readonly botId: BotId;
  private config: CodexRunnerConfig;
  private logDir: string;
  private spawnImpl: typeof spawn;
  private ensureLogDir: (dir: string) => Promise<void>;
  private log: Logger;
  private emitter = new RunnerEventEmitter();

  private status: RunnerStatus = "stopped";
  private activeTurn: TurnId | null = null;
  private currentThreadId: string | null = null;
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private logStream: WriteStream | null = null;
  private stopping = false;
  private stderrBuffer: string[] = [];
  private protocolFlags: readonly string[];
  private onThreadIdChanged: ((threadId: string | null) => void) | null;

  // Side-session state — separate subprocesses, separate emitters.
  // Each turn spawns a fresh subprocess; thread_id resume carries continuity.
  private sideSessions = new Map<string, CodexSideSession>();

  constructor(opts: CodexRunnerOptions) {
    this.botId = opts.botId;
    this.config = opts.config;
    this.logDir = opts.logDir;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.ensureLogDir =
      opts.ensureLogDir ??
      (async (dir) => {
        await mkdir(dir, { recursive: true });
      });
    this.log = logger("runner.codex", { bot_id: opts.botId });
    this.protocolFlags = opts.protocolFlags ?? CodexRunner.PROTOCOL_FLAGS;
    this.onThreadIdChanged = opts.onThreadIdChanged ?? null;
    if (this.config.pass_resume_flag && opts.initialThreadId) {
      this.currentThreadId = opts.initialThreadId;
    }
  }

  on<E extends RunnerEventKind>(
    event: E,
    handler: RunnerEventHandler<E>,
  ): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  isReady(): boolean {
    return this.status === "ready";
  }

  supportsReset(): boolean {
    return true;
  }

  // ---------- Side sessions (US-006) ----------

  supportsSideSessions(): boolean {
    return true;
  }

  /**
   * Create a side-session entry. Unlike Claude, no subprocess is spawned —
   * Codex is per-turn, so the entry just holds the threadId that will carry
   * session continuity across turns. `ready` is emitted on the next
   * microtask so callers can subscribe BEFORE the event fires.
   */
  async startSideSession(sessionId: string): Promise<void> {
    if (!SIDE_SESSION_ID_REGEX.test(sessionId)) {
      throw new InvalidSideSessionId(sessionId);
    }
    if (this.sideSessions.has(sessionId)) {
      throw new SideSessionAlreadyExists(sessionId);
    }
    await this.ensureLogDir(this.logDir);

    const logStream = createWriteStream(
      resolve(this.logDir, `${this.botId}.side.${sessionId}.log`),
      { flags: "a" },
    );
    // Error handler prevents ENOENT (data dir removed) or EACCES
    // (permissions change) from surfacing as an unhandled stream error
    // and crashing the process — demote to a warn log instead.
    logStream.on("error", (err: Error) => {
      this.log.warn("side-session logStream error", {
        bot_id: this.botId,
        session_id: sessionId,
        error: err.message,
      });
    });
    const entry: CodexSideSession = {
      id: sessionId,
      emitter: new RunnerEventEmitter(),
      threadId: null,
      status: "ready",
      activeTurn: null,
      currentProc: null,
      logStream,
      stopping: false,
      stopPromise: null,
      doneEmittedForCurrentTurn: false,
      stderrBuffer: [],
    };
    this.sideSessions.set(sessionId, entry);
    queueMicrotask(() => {
      // The entry could have been stopped before the microtask fires; only
      // emit ready if it's still in "ready" state.
      if (
        this.sideSessions.get(sessionId) === entry &&
        entry.status === "ready"
      ) {
        entry.emitter.emit({ kind: "ready" });
      }
    });
  }

  /**
   * Spawn a fresh `codex exec [resume <threadId>] --json …` subprocess for
   * this turn. Reuses the captured threadId on subsequent turns so the
   * Codex CLI's session continuity semantics hold across calls.
   */
  sendSideTurn(
    sessionId: string,
    turnId: TurnId,
    text: string,
    attachments: Attachment[],
  ): SendTurnResult {
    const entry = this.sideSessions.get(sessionId);
    if (!entry || entry.status === "stopping" || entry.status === "stopped") {
      return { accepted: false, reason: "not_ready" };
    }
    // Busy check BEFORE readiness — a session mid-turn must surface "busy",
    // not "not_ready", so the pool can return 429 instead of 500.
    if (entry.activeTurn !== null) {
      return { accepted: false, reason: "busy" };
    }
    if (entry.status !== "ready") {
      return { accepted: false, reason: "not_ready" };
    }

    // Skip non-image attachments with a warning; mirrors main runner.
    const images: string[] = [];
    for (const a of attachments) {
      if (isImagePath(a.path)) {
        images.push(a.path);
      } else {
        this.log.warn("skipping non-image attachment for codex side-session", {
          session_id: sessionId,
          path: a.path,
          turn_id: turnId,
        });
      }
    }

    const args = this.buildSideArgs(entry, images);
    const env = this.buildEnv();
    let proc: Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = this.spawnImpl({
        cmd: [this.config.cli_path, ...args],
        cwd: this.config.cwd ?? process.cwd(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
      }) as Subprocess<"pipe", "pipe", "pipe">;
    } catch (err) {
      this.log.error("side-session spawn failed", {
        session_id: sessionId,
        error: String(err),
      });
      return { accepted: false, reason: "not_ready" };
    }

    entry.activeTurn = turnId;
    entry.status = "busy";
    entry.currentProc = proc;
    entry.doneEmittedForCurrentTurn = false;
    entry.stderrBuffer = [];

    // Pipe the prompt on stdin and end so `codex exec` knows it's complete.
    try {
      proc.stdin.write(text);
      proc.stdin.end();
    } catch (err) {
      this.log.error("side-session stdin write failed", {
        session_id: sessionId,
        error: String(err),
      });
      // Spawned but stdin failed; let watchExit synthesize an error event.
    }

    void this.runSideTurn(entry, proc, turnId);
    return { accepted: true, turnId };
  }

  async stopSideSession(sessionId: string, graceMs = 5000): Promise<void> {
    const entry = this.sideSessions.get(sessionId);
    if (!entry) return;
    if (entry.stopPromise) return entry.stopPromise;

    entry.stopping = true;
    entry.status = "stopping";
    entry.stopPromise = (async () => {
      const proc = entry.currentProc;
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
      entry.currentProc = null;
      entry.logStream = null;
      entry.activeTurn = null;
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
    const entry = this.sideSessions.get(sessionId);
    if (!entry) throw new SideSessionNotFound(sessionId);
    return entry.emitter.on(event, handler);
  }

  // --- side-session internals ---

  /**
   * Drive a single side-session turn from spawn to exit. Pumps stdout +
   * stderr concurrently, awaits subprocess exit, awaits stream flushes,
   * synthesizes an `error` event if the subprocess exited without ever
   * emitting a terminal event, and finally clears `activeTurn`/promotes
   * status back to `ready` (unless the entry was torn down meanwhile).
   */
  private async runSideTurn(
    entry: CodexSideSession,
    proc: Subprocess<"pipe", "pipe", "pipe">,
    turnId: TurnId,
  ): Promise<void> {
    const stdoutP = this.pumpCodexSideStdout(entry, proc);
    const stderrP = this.pumpCodexSideStderr(entry, proc);
    let exitCode: number;
    try {
      exitCode = await proc.exited;
    } catch {
      exitCode = -1;
    }
    await Promise.allSettled([stdoutP, stderrP]);

    if (entry.currentProc === proc) entry.currentProc = null;

    // If the subprocess exited without emitting done/error, synthesize one.
    // Codex auth failures get the same special-case treatment as the main
    // runner: surfaced as fatal(auth) so the bot supervisor can react.
    if (entry.activeTurn === turnId && !entry.doneEmittedForCurrentTurn) {
      const auth = looksLikeAuthFailure(entry.stderrBuffer);
      if (entry.stopping) {
        entry.activeTurn = null;
        if (entry.status !== "stopped") entry.status = "stopped";
      } else if (auth) {
        entry.activeTurn = null;
        if (entry.status === "busy") entry.status = "ready";
        entry.emitter.emit({
          kind: "fatal",
          code: "auth",
          message: `codex side-session subprocess exited with code ${exitCode}`,
        });
      } else {
        entry.activeTurn = null;
        if (entry.status === "busy") entry.status = "ready";
        entry.emitter.emit({
          kind: "error",
          turnId,
          message: `codex exited with code ${exitCode} before completing the turn`,
          retriable: false,
        });
      }
    } else if (entry.activeTurn === turnId) {
      // Defensive: dispatchSide already cleared activeTurn on done/error,
      // but if the parser somehow attached to a stale id, clear here.
      entry.activeTurn = null;
      if (entry.status === "busy") entry.status = "ready";
    }
  }

  private async pumpCodexSideStdout(
    entry: CodexSideSession,
    proc: Subprocess<"pipe", "pipe", "pipe">,
  ): Promise<void> {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const parser = createCodexJsonlParser({
      currentTurnId: () => entry.activeTurn,
      onThreadStarted: (id) => {
        if (this.config.pass_resume_flag) {
          entry.threadId = id;
        }
      },
    });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        entry.logStream?.write(redactString(chunk));
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

  private async pumpCodexSideStderr(
    entry: CodexSideSession,
    proc: Subprocess<"pipe", "pipe", "pipe">,
  ): Promise<void> {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        entry.logStream?.write(`[stderr] ${redactString(text)}`);
        for (const line of text.split("\n")) {
          if (line.trim()) {
            entry.stderrBuffer.push(line.trim());
            if (entry.stderrBuffer.length > 50) entry.stderrBuffer.shift();
          }
        }
      }
    } catch {
      /* expected on exit */
    }
  }

  private dispatchSide(entry: CodexSideSession, ev: RunnerEvent): void {
    if (ev.kind === "done" || ev.kind === "error") {
      entry.doneEmittedForCurrentTurn = true;
      entry.activeTurn = null;
      if (entry.status === "busy") entry.status = "ready";
    }
    entry.emitter.emit(ev);
  }

  /**
   * Build argv for a side-session turn. Mirrors `buildArgs` but reads
   * `entry.threadId` instead of `this.currentThreadId`, and never appends
   * `--continue` semantics (Codex doesn't have one).
   */
  private buildSideArgs(entry: CodexSideSession, images: string[]): string[] {
    const args: string[] = [...this.protocolFlags];
    args.push("exec");
    const resuming = this.config.pass_resume_flag && entry.threadId !== null;
    if (resuming) {
      args.push("resume", entry.threadId!);
    }
    args.push("--json");

    if (this.config.approval_mode === "full-auto") {
      args.push("--full-auto");
    } else if (this.config.approval_mode === "yolo") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("-c", `approval_policy=${this.config.approval_mode}`);
    }
    if (!resuming && this.config.approval_mode !== "yolo") {
      args.push("--sandbox", this.config.sandbox);
    }
    args.push("--skip-git-repo-check");

    if (this.config.model) args.push("--model", this.config.model);
    args.push(...this.config.args);

    for (const img of images) {
      args.push("--image", img);
    }
    args.push("-");
    return args;
  }

  async start(): Promise<void> {
    if (this.status !== "stopped") {
      throw new Error(
        `CodexRunner.start() called in state '${this.status}' for bot '${this.botId}'`,
      );
    }
    this.stopping = false;

    // Pre-create the per-bot log file so stderr from per-turn invocations has
    // somewhere to land without racing on first turn.
    await this.ensureLogDir(this.logDir);

    this.status = "ready";
    this.emitter.emit({ kind: "ready" });
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
      throw new Error(
        `CodexRunner.reset() called while turn '${this.activeTurn}' is in flight`,
      );
    }
    // Drop the captured thread_id so the next turn starts a fresh Codex
    // session instead of resuming.
    this.setCurrentThreadId(null);
  }

  sendTurn(
    turnId: TurnId,
    text: string,
    attachments: Attachment[],
  ): SendTurnResult {
    // Order matters: a runner mid-turn has status "busy", and the caller
    // needs to distinguish that from "hasn't finished starting yet".
    if (this.activeTurn !== null) {
      return { accepted: false, reason: "busy" };
    }
    if (this.status !== "ready") {
      return { accepted: false, reason: "not_ready" };
    }

    this.activeTurn = turnId;
    this.status = "busy";
    void this.runTurn(turnId, text, attachments).catch((err) => {
      this.log.error("runTurn unexpected throw", { error: String(err) });
      // Synthesize a fatal so the bot supervisor can recover.
      this.activeTurn = null;
      this.status = "ready";
      this.emitter.emit({
        kind: "fatal",
        code: "spawn",
        message: err instanceof Error ? err.message : String(err),
      });
    });
    return { accepted: true, turnId };
  }

  // --- internals ---

  // Anything here is prepended BEFORE the `exec` subcommand. Default empty;
  // tests override this to inject `bun run <mock>` so the mock script ends up
  // between the cli_path (`bun`) and the runner-injected `exec`.
  private static readonly PROTOCOL_FLAGS = Object.freeze([] as string[]);

  private async runTurn(
    turnId: TurnId,
    text: string,
    attachments: Attachment[],
  ): Promise<void> {
    if (this.stopping) {
      this.activeTurn = null;
      this.status = "ready";
      return;
    }

    await this.ensureLogDir(this.logDir);
    const logPath = resolve(this.logDir, `${this.botId}.log`);
    await this.ensureLogDir(dirname(logPath));
    if (!this.logStream) {
      this.logStream = createWriteStream(logPath, { flags: "a" });
    }

    // Skip non-image attachments with a warning. Codex's --image flag accepts
    // only images; documents would need a separate ingestion path.
    const images: string[] = [];
    for (const a of attachments) {
      if (isImagePath(a.path)) {
        images.push(a.path);
      } else {
        this.log.warn("skipping non-image attachment for codex runner", {
          path: a.path,
          turn_id: turnId,
        });
      }
    }

    const args = this.buildArgs(images);
    this.stderrBuffer = [];
    this.log.info("spawning codex turn", {
      cli_path: this.config.cli_path,
      resuming: this.config.pass_resume_flag && this.currentThreadId !== null,
      images: images.length,
    });

    const env = this.buildEnv();
    let proc: Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = this.spawnImpl({
        cmd: [this.config.cli_path, ...args],
        cwd: this.config.cwd ?? process.cwd(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
      }) as Subprocess<"pipe", "pipe", "pipe">;
    } catch (err) {
      this.log.error("spawn failed", { error: String(err) });
      this.activeTurn = null;
      this.status = "ready";
      this.emitter.emit({
        kind: "fatal",
        code: "spawn",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    this.proc = proc;

    // Pipe the user text on stdin (we pass `-` as the prompt argument so the
    // CLI reads it here). End the stream so `codex exec` knows the prompt is
    // complete.
    try {
      proc.stdin.write(text);
      proc.stdin.end();
    } catch (err) {
      this.log.error("stdin write failed", { error: String(err) });
    }

    let doneEmitted = false;
    const captureDone = (ev: RunnerEvent): void => {
      if (ev.kind === "done" || ev.kind === "error") doneEmitted = true;
      this.dispatchEvent(ev);
    };

    const stdoutP = this.readStdout(proc, captureDone);
    const stderrP = this.readStderr(proc);
    const exitCode = await proc.exited;
    await Promise.allSettled([stdoutP, stderrP]);

    if (this.proc === proc) this.proc = null;

    // If the subprocess exited without emitting turn.completed/turn.failed,
    // synthesize an error or fatal so the bot layer doesn't hang.
    if (this.activeTurn === turnId && !doneEmitted) {
      const auth = this.looksLikeAuthFailure();
      if (this.stopping) {
        this.activeTurn = null;
        this.status = "ready";
      } else if (auth) {
        this.activeTurn = null;
        this.status = "ready";
        this.emitter.emit({
          kind: "fatal",
          code: "auth",
          message: `codex subprocess exited with code ${exitCode}`,
        });
      } else {
        // Treat it as a per-turn error rather than a runner-fatal: the binary
        // is still healthy, just this turn failed.
        this.dispatchEvent({
          kind: "error",
          turnId,
          message: `codex exited with code ${exitCode} before completing the turn`,
          retriable: false,
        });
      }
    } else if (this.activeTurn === turnId) {
      // Defensive: dispatchEvent on done/error already cleared activeTurn,
      // but if the parser somehow attached to a stale turn id, clear here.
      this.activeTurn = null;
      this.status = "ready";
    }
  }

  private buildArgs(images: string[]): string[] {
    // protocolFlags is anything prepended BEFORE `exec` (default empty; tests
    // inject `bun run <mock>` so the mock script lands between cli_path and
    // the subcommand).
    const args: string[] = [...this.protocolFlags];

    // exec or exec resume <thread_id>. The set of flags accepted DIFFERS between
    // these two subcommands — `exec resume` does NOT accept `--sandbox` (the
    // sandbox policy is inherited from the original session), `--profile`,
    // `--output-schema`, `--cd`, etc. Verified against codex-cli 0.121.0.
    args.push("exec");
    const resuming =
      this.config.pass_resume_flag && this.currentThreadId !== null;
    if (resuming) {
      args.push("resume", this.currentThreadId!);
    }

    // --json selects the JSONL event stream torana parses. Must come AFTER
    // the subcommand (it's a flag of `exec`/`exec resume`, not of top-level
    // `codex`).
    args.push("--json");

    // Approval mode. --ask-for-approval is a TOP-LEVEL codex flag and is
    // rejected by `codex exec`. For non-full-auto/non-yolo modes we use
    // `-c approval_policy=<mode>` which IS accepted by both exec and resume.
    if (this.config.approval_mode === "full-auto") {
      args.push("--full-auto");
    } else if (this.config.approval_mode === "yolo") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("-c", `approval_policy=${this.config.approval_mode}`);
    }

    // --sandbox is only accepted on `exec` (not `exec resume`); on resume the
    // sandbox is inherited from the original session.
    if (!resuming && this.config.approval_mode !== "yolo") {
      args.push("--sandbox", this.config.sandbox);
    }

    // Codex refuses to run outside a git repo by default. Bot data dirs aren't
    // typically git repos, so we always skip this check. Accepted by both
    // exec and resume.
    args.push("--skip-git-repo-check");

    if (this.config.model) args.push("--model", this.config.model);

    // User-extra args (e.g. --profile, -c key=value). Note: users passing flags
    // here that aren't accepted by `exec resume` will get failures only on
    // resume turns — document this.
    args.push(...this.config.args);

    // Images via repeated --image flags.
    for (const img of images) {
      args.push("--image", img);
    }

    // Prompt sentinel — read prompt from stdin.
    args.push("-");
    return args;
  }

  private buildEnv(): Record<string, string> {
    // runner.env is the complete env except PATH, which inherits by default.
    // runner.secrets merges on top — same shape, registered with the log
    // redactor at load time. Schema rejects key collisions between the two.
    const env: Record<string, string> = {
      ...this.config.env,
      ...(this.config.secrets ?? {}),
    };
    if (!("PATH" in env)) {
      env.PATH = process.env.PATH ?? "";
    } else if (env.PATH === "") {
      delete env.PATH;
    }
    return env;
  }

  private async readStdout(
    proc: Subprocess<"pipe", "pipe", "pipe">,
    onEvent: (ev: RunnerEvent) => void,
  ): Promise<void> {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const parser = createCodexJsonlParser({
      currentTurnId: () => this.activeTurn,
      onThreadStarted: (id) => {
        if (this.config.pass_resume_flag) this.setCurrentThreadId(id);
      },
    });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        this.logStream?.write(redactString(chunk));
        parser.feed(chunk, onEvent);
      }
      parser.flush(onEvent);
    } catch (err) {
      if (!this.stopping) {
        this.log.warn("stdout read error", { error: String(err) });
      }
    }
  }

  private async readStderr(
    proc: Subprocess<"pipe", "pipe", "pipe">,
  ): Promise<void> {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        this.logStream?.write(`[stderr] ${redactString(text)}`);
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

  private dispatchEvent(ev: RunnerEvent): void {
    if (ev.kind === "done" || ev.kind === "error") {
      this.activeTurn = null;
      if (this.status === "busy") this.status = "ready";
    }
    this.emitter.emit(ev);
  }

  private setCurrentThreadId(id: string | null): void {
    if (this.currentThreadId === id) return;
    this.currentThreadId = id;
    try {
      this.onThreadIdChanged?.(id);
    } catch (err) {
      this.log.warn("onThreadIdChanged callback threw", { error: String(err) });
    }
  }

  private looksLikeAuthFailure(): boolean {
    return looksLikeAuthFailure(this.stderrBuffer);
  }
}

function looksLikeAuthFailure(stderrBuffer: readonly string[]): boolean {
  const blob = stderrBuffer.join(" ").toLowerCase();
  return (
    blob.includes("unauthorized") ||
    blob.includes("authentication") ||
    blob.includes("not logged in") ||
    blob.includes("invalid api key") ||
    blob.includes("api key") ||
    blob.includes("openai_api_key")
  );
}

function isImagePath(p: string): boolean {
  const dot = p.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(p.slice(dot).toLowerCase());
}
