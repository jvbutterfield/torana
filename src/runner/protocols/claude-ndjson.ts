// Translates Claude Code's --output-format=stream-json NDJSON into RunnerEvent.
// See §3.3 of the plan for the full mapping table. Unknown event shapes are
// dropped (logged at debug) for forward compat with newer Claude Code versions.

import { logger } from "../../log.js";
import type { RunnerEvent, TurnId } from "../types.js";

const log = logger("claude-ndjson");

export interface ClaudeNdjsonParseOptions {
  /** The turn id currently in flight — attached to text/done/error events. */
  currentTurnId: () => TurnId | null;
}

export interface ClaudeNdjsonParser {
  /** Feed a stdout chunk; invokes `onEvent` for every normalized event. */
  feed(chunk: string, onEvent: (event: RunnerEvent) => void): void;
  /** Flush any buffered partial line (call on stream close). */
  flush(onEvent: (event: RunnerEvent) => void): void;
}

export function createClaudeNdjsonParser(opts: ClaudeNdjsonParseOptions): ClaudeNdjsonParser {
  let remainder = "";

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
        // thinking_delta is intentionally dropped (matches v0 behavior).
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
      // content_block_stop and message_* stream events don't produce surfaces.
      return;
    }

    if (type === "assistant") {
      // mid-turn assistant event — stream_event is authoritative, drop.
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

      const stopReason = normalizeStopReason(ev.stop_reason);
      onEvent({
        kind: "done",
        turnId,
        stopReason,
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

  function handleLine(line: string, onEvent: (event: RunnerEvent) => void): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      log.debug("non-json line dropped", { line: trimmed.slice(0, 120) });
      return;
    }
    translate(parsed, onEvent);
  }

  return {
    feed(chunk, onEvent) {
      remainder += chunk;
      const lines = remainder.split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) handleLine(line, onEvent);
    },
    flush(onEvent) {
      if (remainder) {
        handleLine(remainder, onEvent);
        remainder = "";
      }
    },
  };
}

function normalizeStopReason(
  raw: unknown,
): "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | undefined {
  if (raw === "end_turn" || raw === "max_tokens" || raw === "stop_sequence" || raw === "tool_use") {
    return raw;
  }
  return undefined;
}

function extractUsage(
  ev: Record<string, unknown>,
): { input_tokens?: number; output_tokens?: number } | undefined {
  const u = ev.usage as Record<string, unknown> | undefined;
  if (!u) return undefined;
  const out: { input_tokens?: number; output_tokens?: number } = {};
  if (typeof u.input_tokens === "number") out.input_tokens = u.input_tokens;
  if (typeof u.output_tokens === "number") out.output_tokens = u.output_tokens;
  return Object.keys(out).length ? out : undefined;
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
