// AgentRunner interface and the normalized event shape all runners emit.
// See §3.3 of docs/plans/oss-gateway-plan.md for the full contract.

import type { BotId } from "../config/schema.js";
import type { Attachment } from "../telegram/types.js";

export type TurnId = string;

export type Unsubscribe = () => void;

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
      reason: "busy" | "not_ready" | "unsupported_attachment";
      detail?: string;
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
