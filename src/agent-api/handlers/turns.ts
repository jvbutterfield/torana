// GET /v1/turns/:turn_id handler.
//
// Auth order (timing-attack-safe — tasks/impl-agent-api.md §6.2):
//   1. Parse turn_id from path. Malformed → 404 turn_not_found.
//   2. Authenticate first (before any DB lookup) so latency doesn't leak
//      whether the id exists.
//   3. Lookup turn. If missing / telegram-origin / another caller's turn,
//      return the same 404 turn_not_found.
//   4. Authorize: ask-turn needs scope "ask"; send-turn needs "send".
//   5. Body by status.

import type { AgentApiDeps } from "../types.js";
import type { RouteHandler } from "../../transport/types.js";
import { authenticate, authorize } from "../auth.js";
import { errorResponse, jsonResponse, mapAuthFailure } from "../errors.js";

const TURN_RESULT_TTL_MS = 24 * 60 * 60 * 1000;

export function handleGetTurn(deps: AgentApiDeps): RouteHandler {
  return async (req, params) => {
    const turnId = Number(params.turn_id);
    if (!Number.isInteger(turnId) || turnId < 1) {
      return errorResponse("turn_not_found");
    }

    const a = authenticate(deps.tokens, req.headers.get("Authorization"));
    if ("kind" in a) return mapAuthFailure(a);

    const turn = deps.db.getTurnExtended(turnId);
    if (
      !turn ||
      !turn.agent_api_token_name ||
      turn.agent_api_token_name !== a.token.name
    ) {
      return errorResponse("turn_not_found");
    }

    const needed: "ask" | "send" =
      turn.source === "agent_api_ask" ? "ask" : "send";
    const authz = authorize(a.token, turn.bot_id, needed);
    if (authz) return mapAuthFailure(authz);

    switch (turn.status) {
      case "queued":
      case "running":
        return jsonResponse(200, { turn_id: turnId, status: "in_progress" });

      case "completed": {
        const completedAtMs = turn.completed_at
          ? Date.parse(turn.completed_at)
          : NaN;
        const now = (deps.clock ?? Date.now)();
        const age = Number.isFinite(completedAtMs) ? now - completedAtMs : 0;
        if (age > TURN_RESULT_TTL_MS) {
          return errorResponse("turn_result_expired");
        }
        if (turn.source === "agent_api_ask") {
          const usage = parseUsage(turn.usage_json);
          return jsonResponse(200, {
            turn_id: turnId,
            status: "done",
            text: turn.final_text ?? "",
            usage,
            duration_ms: turn.duration_ms ?? undefined,
          });
        }
        return jsonResponse(200, { turn_id: turnId, status: "done" });
      }

      case "failed":
      case "dead":
        return jsonResponse(200, {
          turn_id: turnId,
          status: "failed",
          error: turn.error_text,
        });

      case "interrupted":
        return jsonResponse(200, {
          turn_id: turnId,
          status: "failed",
          error: turn.error_text ?? "interrupted_by_gateway_restart",
        });

      default:
        return errorResponse(
          "runner_error",
          `unknown turn status: ${turn.status}`,
        );
    }
  };
}

function parseUsage(
  raw: string | null,
): { input_tokens?: number; output_tokens?: number } | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: { input_tokens?: number; output_tokens?: number } = {};
    if (typeof parsed.input_tokens === "number")
      out.input_tokens = parsed.input_tokens;
    if (typeof parsed.output_tokens === "number")
      out.output_tokens = parsed.output_tokens;
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}
