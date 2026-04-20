// Stable exit codes for the agent-api subcommands. The CLI guarantees
// these in `--help` output (impl plan §8.1) and downstream automation
// scripts (skill packages, monitoring) rely on them.
//
//   0  success
//   1  unspecified error / internal error
//   2  bad usage          — flag parser, missing required arg
//   3  authentication failed (401, 403)
//   4  not found          (404, 410)
//   5  server error       (500, 502, 503, 5xx)
//   6  timeout            — async ask returned 202 in_progress
//   7  capacity / busy    (429)
//
// Mapping from `AgentApiError.code` lives in `exitCodeFor`.

import type { ErrorKind } from "../../agent-api/client.js";

export const ExitCode = {
  success: 0,
  internal: 1,
  badUsage: 2,
  authFailed: 3,
  notFound: 4,
  serverError: 5,
  timeout: 6,
  capacity: 7,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Map a parsed AgentApi error code to an exit code. Status fallback is used
 * for codes not enumerated by the gateway today (defence-in-depth — if the
 * gateway adds a new code without updating this file, the CLI still maps to
 * a sensible exit category by HTTP-status class).
 */
export function exitCodeFor(code: ErrorKind, status?: number): ExitCodeValue {
  switch (code) {
    case "missing_auth":
    case "invalid_token":
    case "bot_not_permitted":
    case "scope_not_permitted":
    case "chat_not_permitted":
    case "target_not_authorized":
      return ExitCode.authFailed;

    case "unknown_bot":
    case "turn_not_found":
    case "session_not_found":
    case "turn_result_expired":
      return ExitCode.notFound;

    case "side_session_capacity":
    case "side_session_busy":
      return ExitCode.capacity;

    case "invalid_body":
    case "missing_target":
    case "missing_idempotency_key":
    case "invalid_idempotency_key":
    case "user_not_opened_bot":
    case "attachment_too_large":
    case "body_too_large":
    case "too_many_files":
    case "attachment_mime_not_allowed":
    case "method_not_allowed":
      return ExitCode.badUsage;

    case "runner_does_not_support_side_sessions":
    case "runner_error":
    case "runner_fatal":
    case "insufficient_storage":
    case "gateway_shutting_down":
    case "internal_error":
    case "network":
      return ExitCode.serverError;

    case "malformed_response":
      return ExitCode.internal;

    default: {
      if (typeof status === "number") {
        if (status === 401 || status === 403) return ExitCode.authFailed;
        if (status === 404 || status === 410) return ExitCode.notFound;
        if (status === 429) return ExitCode.capacity;
        if (status >= 500) return ExitCode.serverError;
        if (status >= 400) return ExitCode.badUsage;
      }
      return ExitCode.internal;
    }
  }
}
