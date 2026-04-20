// Simple line-delimited JSON protocol for the CommandRunner.

import { logger } from "../../log.js";
import type { Attachment } from "../../telegram/types.js";
import type { RunnerEvent, TurnId } from "../types.js";
import {
  createLineBufferedParser,
  extractUsage,
  normalizeStopReason,
  type LineBufferedParser,
  type ProtocolCapabilities,
} from "./shared.js";

const log = logger("jsonl-text");

export const jsonlTextCapabilities: ProtocolCapabilities = {
  sideSessions: false,
};

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

export type JsonlTextParser = LineBufferedParser;

export function createJsonlTextParser(): JsonlTextParser {
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

  return createLineBufferedParser("jsonl-text", translate);
}
