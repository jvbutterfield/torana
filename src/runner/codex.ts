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
    this.currentThreadId = null;
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
    const resuming = this.config.pass_resume_flag && this.currentThreadId !== null;
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
    const env: Record<string, string> = { ...this.config.env };
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
        if (this.config.pass_resume_flag) this.currentThreadId = id;
      },
    });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        this.logStream?.write(chunk);
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

  private dispatchEvent(ev: RunnerEvent): void {
    if (ev.kind === "done" || ev.kind === "error") {
      this.activeTurn = null;
      if (this.status === "busy") this.status = "ready";
    }
    this.emitter.emit(ev);
  }

  private looksLikeAuthFailure(): boolean {
    const blob = this.stderrBuffer.join(" ").toLowerCase();
    return (
      blob.includes("unauthorized") ||
      blob.includes("authentication") ||
      blob.includes("not logged in") ||
      blob.includes("invalid api key") ||
      blob.includes("api key") ||
      blob.includes("openai_api_key")
    );
  }
}

function isImagePath(p: string): boolean {
  const dot = p.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(p.slice(dot).toLowerCase());
}
