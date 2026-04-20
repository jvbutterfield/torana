// Agent API /v1/* route registration.

import type { HttpRouter, Unregister } from "../transport/types.js";
import { authenticate, authorize } from "./auth.js";
import { errorResponse, jsonResponse, mapAuthFailure } from "./errors.js";
import type { AgentApiDeps, AuthedHandler, Scope } from "./types.js";
import type { SideSessionPool } from "./pool.js";
import type { OrphanListenerManager } from "./orphan-listeners.js";
import { handleAsk } from "./handlers/ask.js";
import { handleInject } from "./handlers/inject.js";
import { handleGetTurn } from "./handlers/turns.js";
import {
  handleListSessions,
  handleDeleteSession,
} from "./handlers/sessions.js";

import pkg from "../../package.json" with { type: "json" };

export interface AgentApiRouterDeps extends AgentApiDeps {
  pool: SideSessionPool;
  orphans: OrphanListenerManager;
}

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
  deps: AgentApiRouterDeps,
): Unregister[] {
  const unregs: Unregister[] = [];

  const askHandler = handleAsk(deps);
  const injectHandler = handleInject(deps);
  const listSessions = handleListSessions(deps);
  const deleteSession = handleDeleteSession(deps);

  unregs.push(
    router.route(
      "POST",
      "/v1/bots/:bot_id/ask",
      authed(deps, "ask", askHandler),
    ),
  );

  unregs.push(
    router.route(
      "POST",
      "/v1/bots/:bot_id/inject",
      authed(deps, "inject", injectHandler),
    ),
  );

  unregs.push(router.route("GET", "/v1/turns/:turn_id", handleGetTurn(deps)));

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
            supports_side_sessions: bot.runner.supportsSideSessions(),
          };
        });
      return jsonResponse(200, { bots });
    }),
  );

  unregs.push(
    router.route(
      "GET",
      "/v1/bots/:bot_id/sessions",
      authed(deps, "ask", listSessions),
    ),
  );

  unregs.push(
    router.route(
      "DELETE",
      "/v1/bots/:bot_id/sessions/:session_id",
      authed(deps, "ask", deleteSession),
    ),
  );

  return unregs;
}

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
