// Canonical error codes + their HTTP status mapping for the agent-api surface.
// See tasks/impl-agent-api.md §3.3 "errors.ts — canonical error map".

import type { AuthFailure, Scope } from "./types.js";

export type AgentApiErrorCode =
  | "missing_auth"
  | "invalid_token"
  | "bot_not_permitted"
  | "scope_not_permitted"
  | "unknown_bot"
  | "invalid_body"
  | "invalid_timeout"
  | "missing_target"
  | "missing_idempotency_key"
  | "invalid_idempotency_key"
  | "user_not_opened_bot"
  | "chat_not_permitted"
  | "target_not_authorized"
  | "runner_does_not_support_side_sessions"
  | "side_session_capacity"
  | "side_session_busy"
  | "runner_error"
  | "runner_fatal"
  | "attachment_too_large"
  | "body_too_large"
  | "too_many_files"
  | "attachment_mime_not_allowed"
  | "insufficient_storage"
  | "turn_not_found"
  | "turn_result_expired"
  | "session_not_found"
  | "gateway_shutting_down"
  | "method_not_allowed"
  | "internal_error";

const STATUS_MAP: Record<AgentApiErrorCode, number> = {
  missing_auth: 401,
  invalid_token: 401,
  bot_not_permitted: 403,
  scope_not_permitted: 403,
  unknown_bot: 404,
  invalid_body: 400,
  invalid_timeout: 400,
  missing_target: 400,
  missing_idempotency_key: 400,
  invalid_idempotency_key: 400,
  user_not_opened_bot: 409,
  chat_not_permitted: 403,
  target_not_authorized: 403,
  runner_does_not_support_side_sessions: 501,
  side_session_capacity: 429,
  side_session_busy: 429,
  runner_error: 500,
  runner_fatal: 503,
  attachment_too_large: 413,
  body_too_large: 413,
  too_many_files: 413,
  attachment_mime_not_allowed: 415,
  insufficient_storage: 507,
  turn_not_found: 404,
  turn_result_expired: 410,
  session_not_found: 404,
  gateway_shutting_down: 503,
  method_not_allowed: 405,
  internal_error: 500,
};

export function statusFor(code: AgentApiErrorCode): number {
  return STATUS_MAP[code];
}

/** Build a JSON error response with the canonical body shape. */
export function errorResponse(
  code: AgentApiErrorCode,
  message?: string,
  extra?: Record<string, unknown>,
): Response {
  const body: Record<string, unknown> = {
    error: code,
    message: message ?? defaultMessage(code),
  };
  if (extra) Object.assign(body, extra);
  return new Response(JSON.stringify(body), {
    status: STATUS_MAP[code],
    headers: { "Content-Type": "application/json" },
  });
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function mapAuthFailure(a: AuthFailure): Response {
  switch (a.kind) {
    case "missing_auth":
    case "invalid_token":
      return errorResponse(a.kind);
    case "bot_not_permitted":
      return errorResponse("bot_not_permitted", undefined, { bot_id: a.botId });
    case "scope_not_permitted":
      return errorResponse("scope_not_permitted", undefined, { scope: a.scope });
  }
}

function defaultMessage(code: AgentApiErrorCode): string {
  switch (code) {
    case "missing_auth":
      return "missing or malformed Authorization header";
    case "invalid_token":
      return "bearer token not recognized";
    case "bot_not_permitted":
      return "token is not permitted for this bot";
    case "scope_not_permitted":
      return "token does not carry the required scope for this route";
    case "unknown_bot":
      return "no bot with that id";
    case "invalid_body":
      return "request body failed validation";
    case "invalid_timeout":
      return "timeout_ms is outside the allowed range (1000–300000)";
    case "missing_target":
      return "send requires either user_id or chat_id";
    case "missing_idempotency_key":
      return "send requires the Idempotency-Key header";
    case "invalid_idempotency_key":
      return "Idempotency-Key must be 16–128 chars of [A-Za-z0-9_-]";
    case "user_not_opened_bot":
      return "the target user has not DMed this bot yet";
    case "chat_not_permitted":
      return "chat_id is not associated with this bot";
    case "target_not_authorized":
      return "the resolved user is not in the access-control list";
    case "runner_does_not_support_side_sessions":
      return "this bot's runner cannot service ask requests";
    case "side_session_capacity":
      return "side-session pool is at capacity";
    case "side_session_busy":
      return "another turn is in flight on this session id";
    case "runner_error":
      return "runner reported an error";
    case "runner_fatal":
      return "runner emitted a fatal event";
    case "attachment_too_large":
      return "an attachment exceeds the per-file size cap";
    case "body_too_large":
      return "request body exceeds the aggregate size cap";
    case "too_many_files":
      return "too many files for a single request";
    case "attachment_mime_not_allowed":
      return "attachment mime type is not in the allowlist";
    case "insufficient_storage":
      return "attachment storage is over the configured cap";
    case "turn_not_found":
      return "no turn with that id, or not visible to this caller";
    case "turn_result_expired":
      return "turn result has been evicted (older than 24h)";
    case "session_not_found":
      return "no live side-session with that id";
    case "gateway_shutting_down":
      return "gateway is shutting down";
    case "method_not_allowed":
      return "method not allowed for this route";
    case "internal_error":
      return "internal error";
  }
}

export type { Scope };
