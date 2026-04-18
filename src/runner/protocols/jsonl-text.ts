// Simple line-delimited JSON protocol for the CommandRunner.
// See §3.3 of the plan for the wire format.

import { logger } from "../../log.js";
import type { Attachment } from "../../telegram/types.js";
import type { RunnerEvent, TurnId } from "../types.js";

const log = logger("jsonl-text");

export interface JsonlTextInput {
  type: "turn" | "reset";
  turn_id?: TurnId;
  text?: string;
  attachments?: Attachment[];
}

export function encodeTurn(turnId: TurnId, text: string, attachments: Attachment[]): string {
  const envelope: JsonlTextInput = { type: "turn", turn_id: turnId, text, attachments };
  return JSON.stringify(envelope) + "\n";
}

export function encodeReset(): string {
  const envelope: JsonlTextInput = { type: "reset" };
  return JSON.stringify(envelope) + "\n";
}

export interface JsonlTextParser {
  feed(chunk: string, onEvent: (event: RunnerEvent) => void): void;
  flush(onEvent: (event: RunnerEvent) => void): void;
}

export function createJsonlTextParser(): JsonlTextParser {
  let remainder = "";

  function translate(raw: unknown, onEvent: (event: RunnerEvent) => void): void {
    if (!raw || typeof raw !== "object") return;
    const ev = raw as Record<string, unknown>;
    const type = ev.type;

    if (type === "ready") {
      onEvent({ kind: "ready" });
      return;
    }

    if (type === "text") {
      const turnId = typeof ev.turn_id === "string" ? ev.turn_id : null;
      const text = typeof ev.text === "string" ? ev.text : null;
      if (!turnId || text === null) return;
      onEvent({ kind: "text_delta", turnId, text });
      return;
    }

    if (type === "done") {
      const turnId = typeof ev.turn_id === "string" ? ev.turn_id : null;
      if (!turnId) return;
      onEvent({
        kind: "done",
        turnId,
        stopReason: normalizeStopReason(ev.stop_reason),
        usage: extractUsage(ev),
        finalText: typeof ev.final_text === "string" ? ev.final_text : undefined,
      });
      return;
    }

    if (type === "error") {
      const turnId = typeof ev.turn_id === "string" ? ev.turn_id : null;
      const message = typeof ev.message === "string" ? ev.message : "runner error";
      const retriable = ev.retriable === true;
      if (!turnId) return;
      onEvent({ kind: "error", turnId, message, retriable });
      return;
    }

    if (type === "status") {
      const turnId = typeof ev.turn_id === "string" ? ev.turn_id : undefined;
      const phase = typeof ev.phase === "string" ? ev.phase : "thinking";
      onEvent({ kind: "status", turnId, phase });
      return;
    }

    if (type === "rate_limit") {
      const retryAfter =
        typeof ev.retry_after_ms === "number" ? ev.retry_after_ms : 60_000;
      const turnId = typeof ev.turn_id === "string" ? ev.turn_id : undefined;
      onEvent({ kind: "rate_limit", turnId, retry_after_ms: retryAfter });
      return;
    }

    log.debug("unknown jsonl-text event — dropped", { type: String(type) });
  }

  function handleLine(line: string, onEvent: (event: RunnerEvent) => void): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
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
  if (
    raw === "end_turn" ||
    raw === "max_tokens" ||
    raw === "stop_sequence" ||
    raw === "tool_use"
  ) {
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
