// AgentRunner interface and the normalized event shape all runners emit.

import type { BotId } from "../config/schema.js";
import type { Attachment } from "../telegram/types.js";

export type TurnId = string;

export type Unsubscribe = () => void;

export type RunnerStatus = "stopped" | "starting" | "ready" | "busy" | "stopping";

export type RunnerEventKind =
  | "ready"
  | "text_delta"
  | "done"
  | "error"
  | "fatal"
  | "rate_limit"
  | "status";

export type RunnerEvent =
  | { kind: "ready" }
  | { kind: "text_delta"; turnId: TurnId; text: string }
  | {
      kind: "done";
      turnId: TurnId;
      stopReason?: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
      usage?: { input_tokens?: number; output_tokens?: number };
      finalText?: string;
      durationMs?: number;
    }
  | { kind: "error"; turnId: TurnId; message: string; retriable: boolean }
  | {
      kind: "fatal";
      message: string;
      code?: "auth" | "spawn" | "exit" | "protocol";
    }
  | { kind: "rate_limit"; turnId?: TurnId; retry_after_ms: number }
  | {
      kind: "status";
      turnId?: TurnId;
      phase: "thinking" | "tool_use" | "waiting" | string;
    };

export type RunnerEventHandler<E extends RunnerEventKind = RunnerEventKind> = (
  event: Extract<RunnerEvent, { kind: E }>,
) => void;

export type SendTurnResult =
  | { accepted: true; turnId: TurnId }
  | {
      accepted: false;
      reason: "busy" | "not_ready";
    };

export interface AgentRunner {
  readonly botId: BotId;

  start(): Promise<void>;
  /**
   * Stop the runner. Implementations send SIGTERM, wait `graceMs` for the
   * subprocess to exit, then SIGKILL if still alive. Default grace is 5000ms.
   */
  stop(graceMs?: number): Promise<void>;

  sendTurn(turnId: TurnId, text: string, attachments: Attachment[]): SendTurnResult;

  reset(): Promise<void>;
  supportsReset(): boolean;
  isReady(): boolean;

  on<E extends RunnerEventKind>(
    event: E,
    handler: RunnerEventHandler<E>,
  ): Unsubscribe;

  // ---------- Agent API side-sessions ----------
  //
  // A side-session is a *second* subprocess owned by the runner: the pool
  // acquires one per (bot, session_id) pair to service agent-api `ask`
  // requests without polluting the main Telegram-facing runner. Events
  // parsed from a side-session's stdout must flow *only* to that session's
  // emitter — never to the main emitter, never to another side session.
  //
  // Default behaviour from AgentRunnerDefaults: supportsSideSessions() =>
  // false; all other methods throw `RunnerDoesNotSupportSideSessions`.

  supportsSideSessions(): boolean;

  startSideSession(sessionId: string): Promise<void>;

  sendSideTurn(
    sessionId: string,
    turnId: TurnId,
    text: string,
    attachments: Attachment[],
  ): SendTurnResult;

  stopSideSession(sessionId: string, graceMs?: number): Promise<void>;

  onSide<E extends RunnerEventKind>(
    sessionId: string,
    event: E,
    handler: RunnerEventHandler<E>,
  ): Unsubscribe;
}

/**
 * Thrown by runners whose underlying protocol can't multiplex a second
 * subprocess (e.g. jsonl-text command runner).
 */
export class RunnerDoesNotSupportSideSessions extends Error {
  readonly code = "runner_does_not_support_side_sessions";
  constructor(message = "runner does not support side sessions") {
    super(message);
    this.name = "RunnerDoesNotSupportSideSessions";
  }
}

export class SideSessionAlreadyExists extends Error {
  readonly code = "side_session_already_exists";
  constructor(sessionId: string) {
    super(`side session '${sessionId}' already exists`);
    this.name = "SideSessionAlreadyExists";
  }
}

export class SideSessionNotFound extends Error {
  readonly code = "side_session_not_found";
  constructor(sessionId: string) {
    super(`side session '${sessionId}' not found`);
    this.name = "SideSessionNotFound";
  }
}

export class InvalidSideSessionId extends Error {
  readonly code = "invalid_session_id";
  constructor(sessionId: string) {
    super(`invalid session id: '${sessionId}' (must match [A-Za-z0-9_-]{1,64})`);
    this.name = "InvalidSideSessionId";
  }
}

/**
 * Default implementations for AgentRunner side-session methods. Runners
 * that don't support side sessions can opt-in by spreading these into
 * their class via delegation or by copying the patterns. For TypeScript
 * ergonomics we expose them as a concrete object runners can `Object.assign`
 * onto their prototype, but the simplest path — and the one runner/*.ts
 * takes — is manual implementation returning these shapes directly.
 */
export const SIDE_SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export function validateSideSessionId(sessionId: string): void {
  if (!SIDE_SESSION_ID_REGEX.test(sessionId)) {
    throw new InvalidSideSessionId(sessionId);
  }
}

/** Simple typed event emitter — shared by runner implementations. */
export class RunnerEventEmitter {
  private handlers = new Map<RunnerEventKind, Set<(event: RunnerEvent) => void>>();

  on<E extends RunnerEventKind>(
    event: E,
    handler: RunnerEventHandler<E>,
  ): Unsubscribe {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (event: RunnerEvent) => void);
    return () => {
      const s = this.handlers.get(event);
      s?.delete(handler as (event: RunnerEvent) => void);
    };
  }

  emit(event: RunnerEvent): void {
    const set = this.handlers.get(event.kind);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(event);
      } catch (err) {
        // Handler errors are swallowed so one bad listener doesn't break the runner.
        // eslint-disable-next-line no-console
        console.error("runner event handler threw", err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
