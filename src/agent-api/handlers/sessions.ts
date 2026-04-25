// GET /v1/bots/:bot_id/sessions  and  DELETE /v1/bots/:bot_id/sessions/:sid.
// Both scoped to "ask"; both read from the live in-memory pool snapshot.

import type { AgentApiDeps, AuthedHandler } from "../types.js";
import type { SideSessionPool } from "../pool.js";
import { errorResponse, jsonResponse } from "../errors.js";

export interface SessionsDeps extends AgentApiDeps {
  pool: SideSessionPool;
}

export function handleListSessions(deps: SessionsDeps): AuthedHandler {
  return async (_req, { botId }) => {
    const sessions = deps.pool.listForBot(botId);
    return jsonResponse(200, {
      sessions: sessions.map((s) => ({
        session_id: s.sessionId,
        started_at: new Date(s.startedAtMs).toISOString(),
        last_used_at: new Date(s.lastUsedAtMs).toISOString(),
        hard_expires_at: new Date(s.hardExpiresAtMs).toISOString(),
        state: s.state,
        inflight: s.inflight,
        ephemeral: s.ephemeral,
      })),
    });
  };
}

export function handleDeleteSession(deps: SessionsDeps): AuthedHandler {
  return async (_req, params) => {
    const botId = params.botId;
    const sessionId = (params.session_id as string | undefined) ?? "";
    const snap = deps.pool
      .listForBot(botId)
      .find((s) => s.sessionId === sessionId);
    if (!snap) return errorResponse("session_not_found");
    await deps.pool.stop(
      botId,
      sessionId,
      deps.config.shutdown.runner_grace_secs * 1000,
    );
    return new Response(null, { status: 204 });
  };
}
