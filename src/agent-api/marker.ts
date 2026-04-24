// System-message marker — prefixed to send-path prompts so the runner sees
// a clear boundary between torana-generated framing and caller-supplied
// text.
//
// Two invariants guard against marker spoofing:
//   1. `source` must match SOURCE_LABEL_RE (schema-enforced; keeps the
//      quote character out of the label so it can't close the outer
//      envelope early).
//   2. `text` must not contain a line-starting `[system-message from "…"]`
//      header (MARKER_INJECTION_RE — schema-enforced on SendBodySchema).
//      Without this check, an authenticated caller's body could inject a
//      second marker attributing subsequent content to any source label it
//      chooses, undermining the framing the runner relies on to
//      distinguish operator-initiated from user-initiated turns.
//
// This function is called *after* schema validation, but we re-assert
// here so any future code path that wraps text without going through the
// body schema still fails closed rather than silently emitting a spoofable
// envelope.
//
// See tasks/impl-agent-api.md §6.4 + §12.5.

import { MARKER_INJECTION_RE, SOURCE_LABEL_RE } from "./schemas.js";

export function wrapSystemMessage(text: string, source: string): string {
  if (!SOURCE_LABEL_RE.test(source)) {
    throw new Error(
      `wrapSystemMessage: source must match SOURCE_LABEL_RE (got ${JSON.stringify(source)})`,
    );
  }
  if (MARKER_INJECTION_RE.test(text)) {
    throw new Error(
      "wrapSystemMessage: text contains a line-starting `[system-message from \"` sequence and would spoof the gateway marker",
    );
  }
  return `[system-message from "${source}"]\n\n${text}`;
}
