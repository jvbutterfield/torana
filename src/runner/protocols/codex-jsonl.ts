// Translates `codex exec --json` newline-delimited events into RunnerEvent.
//
// Codex emits state-change events, NOT token-level deltas. The assistant
// reply arrives whole as `item.completed` with `item.type == "agent_message"`,
// which the parser surfaces as a single `text_delta` followed by `done` on
// `turn.completed`. Streaming-edit semantics still work, but with one big
// edit per turn rather than incremental deltas.
//
// Unknown event shapes are dropped (logged at debug) for forward compat.

import { logger } from "../../log.js";
import type { RunnerEvent, TurnId } from "../types.js";
import {
  createLineBufferedParser,
  type LineBufferedParser,
  type ProtocolCapabilities,
} from "./shared.js";

const log = logger("codex-jsonl");

export const codexJsonlCapabilities: ProtocolCapabilities = {
  sideSessions: true,
};

export interface CodexJsonlParseOptions {
  /** Turn id currently in flight — attached to text/done/error events. */
  currentTurnId: () => TurnId | null;
  /**
   * Called when a new `thread.started` event arrives so the runner can capture
   * the `thread_id` for `codex exec resume <id>` on subsequent turns.
   */
  onThreadStarted?: (threadId: string) => void;
}

export type CodexJsonlParser = LineBufferedParser;

export function createCodexJsonlParser(
  opts: CodexJsonlParseOptions,
): CodexJsonlParser {
  function translate(
    raw: unknown,
    onEvent: (event: RunnerEvent) => void,
  ): void {
    if (!raw || typeof raw !== "object") return;
    const ev = raw as Record<string, unknown>;
    const type = ev.type;

    if (type === "thread.started") {
      const threadId = typeof ev.thread_id === "string" ? ev.thread_id : null;
      if (threadId && opts.onThreadStarted) opts.onThreadStarted(threadId);
      // No RunnerEvent emitted: readiness is signaled by the runner once the
      // subprocess is spawned, not per-turn by the protocol.
      return;
    }

    // Synthetic startup signal — Codex itself doesn't emit a per-process
    // ready event (each `codex exec` is one-shot), so long-lived wrappers
    // using `protocol: codex-jsonl` in the `command` runner can emit
    // `{"type":"ready"}` once on startup to promote the runner to ready.
    if (type === "ready") {
      onEvent({ kind: "ready" });
      return;
    }

    if (type === "turn.started") {
      // No-op: the runner already knows a turn is in flight.
      return;
    }

    if (type === "item.started") {
      const item = ev.item as Record<string, unknown> | undefined;
      const itemType = item?.type;
      // Surface tool-ish work as a status event so the bot layer can render
      // a "thinking..." indicator. We treat command_execution, mcp_tool_call,
      // file_change, and web_search as tool_use; reasoning and agent_message
      // are silent until completion.
      if (
        itemType === "command_execution" ||
        itemType === "mcp_tool_call" ||
        itemType === "file_change" ||
        itemType === "web_search"
      ) {
        const turnId = opts.currentTurnId();
        onEvent({
          kind: "status",
          turnId: turnId ?? undefined,
          phase: "tool_use",
        });
      }
      return;
    }

    if (type === "item.completed") {
      const item = ev.item as Record<string, unknown> | undefined;
      if (!item) return;
      if (
        item.type === "agent_message" &&
        typeof item.text === "string" &&
        item.text
      ) {
        const turnId = opts.currentTurnId();
        if (turnId !== null) {
          onEvent({ kind: "text_delta", turnId, text: item.text });
        }
      }
      // reasoning/plan/tool-result item.completed events are intentionally
      // dropped — they're already represented via item.started status events.
      return;
    }

    if (type === "turn.completed") {
      const turnId = opts.currentTurnId();
      if (turnId === null) return;
      onEvent({
        kind: "done",
        turnId,
        stopReason: "end_turn",
        usage: extractCodexUsage(ev),
      });
      return;
    }

    if (type === "turn.failed") {
      const turnId = opts.currentTurnId();
      if (turnId === null) return;
      const err = ev.error as Record<string, unknown> | undefined;
      const message =
        (typeof err?.message === "string" && err.message) ||
        (typeof ev.message === "string" && ev.message) ||
        "codex turn failed";
      onEvent({ kind: "error", turnId, message, retriable: false });
      return;
    }

    if (type === "error") {
      const turnId = opts.currentTurnId();
      const message =
        (typeof ev.message === "string" && ev.message) || "codex error";
      if (turnId !== null) {
        onEvent({ kind: "error", turnId, message, retriable: false });
      }
      return;
    }

    log.debug("unknown codex event — dropped", { type: String(type) });
  }

  return createLineBufferedParser("codex-jsonl", translate);
}

/**
 * Codex usage shape differs from Claude: it includes a `cached_input_tokens`
 * field. We surface input/output only — caching detail is preserved in the
 * per-bot log file but doesn't fit the RunnerEvent abstraction.
 */
function extractCodexUsage(
  ev: Record<string, unknown>,
): { input_tokens?: number; output_tokens?: number } | undefined {
  const u = ev.usage as Record<string, unknown> | undefined;
  if (!u) return undefined;
  const out: { input_tokens?: number; output_tokens?: number } = {};
  if (typeof u.input_tokens === "number") out.input_tokens = u.input_tokens;
  if (typeof u.output_tokens === "number") out.output_tokens = u.output_tokens;
  return Object.keys(out).length ? out : undefined;
}
