// Shared helpers used by both built-in protocols (claude-ndjson, jsonl-text).

import { logger } from "../../log.js";
import type { Attachment } from "../../telegram/types.js";
import type { RunnerEvent } from "../types.js";

const log = logger("protocol");

export type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";

export function normalizeStopReason(raw: unknown): StopReason | undefined {
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

export function extractUsage(
  ev: Record<string, unknown>,
): { input_tokens?: number; output_tokens?: number } | undefined {
  const u = ev.usage as Record<string, unknown> | undefined;
  if (!u) return undefined;
  const out: { input_tokens?: number; output_tokens?: number } = {};
  if (typeof u.input_tokens === "number") out.input_tokens = u.input_tokens;
  if (typeof u.output_tokens === "number") out.output_tokens = u.output_tokens;
  return Object.keys(out).length ? out : undefined;
}

export interface LineBufferedParser {
  feed(chunk: string, onEvent: (event: RunnerEvent) => void): void;
  flush(onEvent: (event: RunnerEvent) => void): void;
}

/**
 * Generic line-buffered parser. `translate` receives the parsed JSON value and
 * the event sink. Non-JSON lines are dropped at debug log level.
 */
export function createLineBufferedParser(
  name: string,
  translate: (raw: unknown, onEvent: (event: RunnerEvent) => void) => void,
): LineBufferedParser {
  let remainder = "";

  function handleLine(line: string, onEvent: (event: RunnerEvent) => void): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      log.debug("non-json line dropped", { parser: name, line: trimmed.slice(0, 120) });
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

/**
 * Build the user-message envelope the Claude Code CLI expects on stdin.
 * Attachments are surfaced as plain-text "[Attached file: <path>]" lines — the
 * CLI reads files itself from the injected paths.
 */
export function encodeClaudeNdjsonTurn(text: string, attachments: Attachment[]): string {
  const content =
    attachments.length > 0
      ? `${text}\n\n${attachments.map((a) => `[Attached file: ${a.path}]`).join("\n")}`
      : text;
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}
