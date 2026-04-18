// Translates Claude Code's --output-format=stream-json NDJSON into RunnerEvent.
// Unknown event shapes are dropped (logged at debug) for forward compat with
// newer Claude Code versions.

import { logger } from "../../log.js";
import type { RunnerEvent, TurnId } from "../types.js";
import {
  createLineBufferedParser,
  extractUsage,
  normalizeStopReason,
  type LineBufferedParser,
} from "./shared.js";

const log = logger("claude-ndjson");

export interface ClaudeNdjsonParseOptions {
  /** The turn id currently in flight — attached to text/done/error events. */
  currentTurnId: () => TurnId | null;
}

export type ClaudeNdjsonParser = LineBufferedParser;

export function createClaudeNdjsonParser(opts: ClaudeNdjsonParseOptions): ClaudeNdjsonParser {
  function translate(raw: unknown, onEvent: (event: RunnerEvent) => void): void {
    if (!raw || typeof raw !== "object") return;
    const ev = raw as Record<string, unknown>;
    const type = ev.type;

    if (type === "system" && ev.subtype === "init") {
      onEvent({ kind: "ready" });
      return;
    }

    if (type === "stream_event") {
      const inner = ev.event as Record<string, unknown> | undefined;
      if (!inner) return;

      const innerType = inner.type;
      if (innerType === "content_block_delta") {
        const delta = inner.delta as Record<string, unknown> | undefined;
        if (!delta) return;
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          const turnId = opts.currentTurnId();
          if (turnId !== null) {
            onEvent({ kind: "text_delta", turnId, text: delta.text });
          }
        }
        // thinking_delta is intentionally not surfaced to the user.
        return;
      }

      if (innerType === "content_block_start") {
        const block = inner.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") {
          const turnId = opts.currentTurnId();
          onEvent({ kind: "status", turnId: turnId ?? undefined, phase: "tool_use" });
        }
        return;
      }
      return;
    }

    if (type === "assistant") {
      // mid-turn assistant event — stream_event is authoritative.
      return;
    }

    if (type === "result") {
      const turnId = opts.currentTurnId();
      if (turnId === null) return;

      const isError = ev.is_error === true;
      const duration = typeof ev.duration_ms === "number" ? ev.duration_ms : undefined;
      const finalText = typeof ev.result === "string" ? ev.result : undefined;

      if (isError) {
        onEvent({
          kind: "error",
          turnId,
          message: finalText ?? "runner reported error",
          retriable: false,
        });
        return;
      }

      onEvent({
        kind: "done",
        turnId,
        stopReason: normalizeStopReason(ev.stop_reason),
        usage: extractUsage(ev),
        finalText,
        durationMs: duration,
      });
      return;
    }

    if (type === "rate_limit_event") {
      const info = ev.rate_limit_info as Record<string, unknown> | undefined;
      if (!info || info.status === "allowed") return;
      const retryAfterMs = parseRetryAfter(info) ?? 60_000;
      const turnId = opts.currentTurnId();
      onEvent({ kind: "rate_limit", turnId: turnId ?? undefined, retry_after_ms: retryAfterMs });
      return;
    }

    log.debug("unknown ndjson event — dropped", { type: String(type) });
  }

  return createLineBufferedParser("claude-ndjson", translate);
}

function parseRetryAfter(info: Record<string, unknown>): number | undefined {
  if (typeof info.resetAt === "string") {
    const ts = Date.parse(info.resetAt);
    if (!Number.isNaN(ts)) {
      const diff = ts - Date.now();
      return diff > 0 ? diff : undefined;
    }
  }
  if (typeof info.retry_after_ms === "number") return info.retry_after_ms;
  if (typeof info.retry_after === "number") return info.retry_after * 1000;
  return undefined;
}
