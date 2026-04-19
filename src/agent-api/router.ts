// Agent API /v1/* route registration. Handlers are stubs in Phase 1 —
// Phase 4+ fills in the bodies.

import type { HttpRouter, Unregister } from "../transport/types.js";
import { authenticate, authorize } from "./auth.js";
import { errorResponse, jsonResponse, mapAuthFailure } from "./errors.js";
import type { AgentApiDeps, AuthedHandler, Scope } from "./types.js";

import pkg from "../../package.json" with { type: "json" };

/**
 * Register `/v1/health` — public, no auth. Always available so operators
 * can probe whether the running binary supports the agent API, regardless
 * of whether `agent_api.enabled` is true.
 */
export function registerAgentApiHealthRoute(
  router: HttpRouter,
  deps: Pick<AgentApiDeps, "config"> & { uptimeSecs: () => number },
): Unregister {
  return router.route("GET", "/v1/health", async () =>
    jsonResponse(200, {
      ok: true,
      version: pkg.version,
      agent_api_enabled: deps.config.agent_api?.enabled === true,
      uptime_secs: deps.uptimeSecs(),
    }),
  );
}

/**
 * Register the full agent-api route surface. Called only when
 * `config.agent_api.enabled` is true. Returns unregister callbacks so
 * the gateway can tear the routes down during shutdown (new calls 404).
 */
export function registerAgentApiRoutes(
  router: HttpRouter,
  deps: AgentApiDeps,
): Unregister[] {
  const unregs: Unregister[] = [];

  // POST /v1/bots/:bot_id/ask  (scope: ask)
  unregs.push(
    router.route(
      "POST",
      "/v1/bots/:bot_id/ask",
      authed(deps, "ask", async () =>
        // Phase 4 will replace this.
        errorResponse("internal_error", "ask handler not yet implemented"),
      ),
    ),
  );

  // POST /v1/bots/:bot_id/inject  (scope: inject)
  unregs.push(
    router.route(
      "POST",
      "/v1/bots/:bot_id/inject",
      authed(deps, "inject", async () =>
        errorResponse("internal_error", "inject handler not yet implemented"),
      ),
    ),
  );

  // GET /v1/turns/:turn_id  — auth in-handler (scope depends on turn origin).
  unregs.push(
    router.route("GET", "/v1/turns/:turn_id", async (req, params) => {
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
      const needed: Scope = turn.source === "agent_api_ask" ? "ask" : "inject";
      const authz = authorize(a.token, turn.bot_id, needed);
      if (authz) return mapAuthFailure(authz);

      // Phase 4 fills in the per-status body logic.
      return jsonResponse(200, {
        turn_id: turn.id,
        status:
          turn.status === "queued" || turn.status === "running"
            ? "in_progress"
            : turn.status === "completed"
              ? "done"
              : "failed",
        text: turn.final_text ?? undefined,
      });
    }),
  );

  // GET /v1/bots — caller-scoped listing.
  unregs.push(
    router.route("GET", "/v1/bots", async (req) => {
      const a = authenticate(deps.tokens, req.headers.get("Authorization"));
      if ("kind" in a) return mapAuthFailure(a);
      const permitted = new Set(a.token.bot_ids);
      const bots = deps.registry.botIds
        .filter((id) => permitted.has(id))
        .sort()
        .map((id) => {
          const bot = deps.registry.bot(id)!;
          return {
            bot_id: id,
            runner_type: bot.botConfig.runner.type,
            supports_side_sessions: false, // Phase 2 flips this per-runner.
          };
        });
      return jsonResponse(200, { bots });
    }),
  );

  // GET /v1/bots/:bot_id/sessions — admin read, scope=ask.
  unregs.push(
    router.route(
      "GET",
      "/v1/bots/:bot_id/sessions",
      authed(deps, "ask", async () =>
        // Phase 3 will read from the live pool.
        jsonResponse(200, { sessions: [] }),
      ),
    ),
  );

  // DELETE /v1/bots/:bot_id/sessions/:session_id — admin kill, scope=ask.
  unregs.push(
    router.route(
      "DELETE",
      "/v1/bots/:bot_id/sessions/:session_id",
      authed(deps, "ask", async () => errorResponse("session_not_found")),
    ),
  );

  return unregs;
}

/**
 * Wrap a handler with the standard authenticate → known-bot → authorize
 * preamble used by `/v1/bots/:bot_id/*` routes. `bot_not_permitted` and
 * `scope_not_permitted` happen *before* we probe the DB / pool so callers
 * can't enumerate bot ids by latency.
 */
function authed(
  deps: AgentApiDeps,
  scope: Scope,
  handler: AuthedHandler,
): (req: Request, params: Record<string, string>) => Promise<Response> {
  return async (req, params) => {
    const botId = params.bot_id!;
    if (!deps.registry.bot(botId)) return errorResponse("unknown_bot");
    const a = authenticate(deps.tokens, req.headers.get("Authorization"));
    if ("kind" in a) return mapAuthFailure(a);
    const authz = authorize(a.token, botId, scope);
    if (authz) return mapAuthFailure(authz);
    return handler(req, { ...params, token: a.token, botId });
  };
}
