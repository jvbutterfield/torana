// Agent API /v1/* route registration.

import type { HttpRouter, Unregister } from "../transport/types.js";
import { authenticate, authorize } from "./auth.js";
import { errorResponse, jsonResponse, mapAuthFailure } from "./errors.js";
import type {
  AgentApiDeps,
  AuthedHandler,
  ResolvedAgentApiToken,
  Scope,
} from "./types.js";
import type { SideSessionPool } from "./pool.js";
import type { OrphanListenerManager } from "./orphan-listeners.js";
import { handleAsk } from "./handlers/ask.js";
import { handleSend } from "./handlers/send.js";
import { handleGetTurn } from "./handlers/turns.js";
import {
  handleListSessions,
  handleDeleteSession,
} from "./handlers/sessions.js";

import {
  ProvisioningError,
  ProvisionRequestSchema,
  type BuzzProvisioningService,
} from "../platform/buzz/provisioning.js";

import pkg from "../../package.json" with { type: "json" };

export interface AgentApiRouterDeps extends AgentApiDeps {
  pool: SideSessionPool;
  orphans: OrphanListenerManager;
  /**
   * Present when Buzz endpoint provisioning is available. Absent leaves the
   * routes registered but answering 503, so a probe can tell "this build has
   * no provisioning" from "this path is not routed at all".
   */
  provisioning?: BuzzProvisioningService;
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
  const sendHandler = handleSend(deps);
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
      "/v1/bots/:bot_id/send",
      authed(deps, "send", sendHandler),
    ),
  );

  unregs.push(router.route("GET", "/v1/turns/:turn_id", handleGetTurn(deps)));

  unregs.push(
    router.route("GET", "/v1/bots", async (req) => {
      const a = authenticate(deps.tokens, req.headers.get("Authorization"));
      if ("kind" in a) return mapAuthFailure(a);
      const permitted = new Set(a.token.bot_ids);
      const exposeRunner = deps.config.agent_api?.expose_runner_type === true;
      const bots = deps.registry.botIds
        .filter((id) => permitted.has(id))
        .sort()
        .map((id) => {
          const bot = deps.registry.bot(id)!;
          const item: {
            bot_id: string;
            supports_side_sessions: boolean;
            runner_type?: string;
          } = {
            bot_id: id,
            supports_side_sessions: bot.runner.supportsSideSessions(),
          };
          if (exposeRunner) item.runner_type = bot.botConfig.runner.type;
          return item;
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

  registerAdminRoutes(unregs, router, deps);
  registerProvisioningRoutes(unregs, router, deps);

  return unregs;
}

/**
 * Buzz endpoint provisioning — the only `/v1/*` surface deliberately exposed
 * through the public edge, because a provider running on an operator's Desktop
 * has to reach it. Three consequences, all enforced here:
 *
 *  - the routes require the dedicated `endpoints:admin` scope, never `ask`;
 *  - the request body is capped before it is parsed;
 *  - the token's `bot_ids` still bound which agents it may attach endpoints to.
 *
 * These must stay under `/v1/`. The deployment's edge proxy 404s `/v1/*` except
 * for a literal allowlist of these paths and forwards everything else
 * verbatim, so a route mounted at a bare `/admin/...` would be silently public.
 */
function registerProvisioningRoutes(
  unregs: Unregister[],
  router: HttpRouter,
  deps: AgentApiRouterDeps,
): void {
  const path = "/v1/admin/buzz/endpoints/:endpoint_id";

  unregs.push(
    router.route(
      "PUT",
      path,
      provisionAuthed(deps, async (req, params, token) => {
        const provisioning = deps.provisioning;
        if (!provisioning) return provisioningUnavailable();
        const endpointId = decodeURIComponent(params.endpoint_id!);
        const raw = await readCappedBody(req);
        if (raw === null) {
          return errorResponse(
            "invalid_body",
            `request body exceeds ${PROVISION_MAX_BODY_BYTES} bytes`,
          );
        }
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return errorResponse("invalid_body", "body must be JSON");
        }
        const parsed = ProvisionRequestSchema.safeParse(body);
        if (!parsed.success) {
          return errorResponse(
            "invalid_body",
            parsed.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; "),
          );
        }
        if (!token.bot_ids.includes(parsed.data.agent_id)) {
          return mapAuthFailure({
            kind: "bot_not_permitted",
            botId: parsed.data.agent_id,
          });
        }
        try {
          const outcome = await provisioning.upsert(
            endpointId,
            parsed.data,
            token.name,
          );
          return jsonResponse(200, {
            endpoint_id: outcome.endpointId,
            agent_id: parsed.data.agent_id,
            pubkey: outcome.pubkey,
            result: outcome.kind,
          });
        } catch (error) {
          return provisioningError(error);
        }
      }),
    ),
  );

  unregs.push(
    router.route(
      "GET",
      path,
      provisionAuthed(deps, async (_req, params, token) => {
        const provisioning = deps.provisioning;
        if (!provisioning) return provisioningUnavailable();
        const status = provisioning.status(
          decodeURIComponent(params.endpoint_id!),
        );
        if (!status || !token.bot_ids.includes(status.agentId)) {
          return adminNotFound();
        }
        return jsonResponse(200, {
          endpoint_id: status.endpointId,
          agent_id: status.agentId,
          pubkey: status.pubkey,
          lifecycle_state: status.lifecycleState,
          runtime_state: status.runtimeState,
          connected: status.connected,
          presence: status.presence
            ? {
                last_published_at: status.presence.lastPublishedAt,
                consecutive_failures: status.presence.consecutiveFailures,
                stale: status.presence.stale,
              }
            : null,
          created_at: status.createdAt,
          updated_at: status.updatedAt,
          provisioned_by: status.provisionedBy,
        });
      }),
    ),
  );

  unregs.push(
    router.route(
      "DELETE",
      path,
      provisionAuthed(deps, async (_req, params, token) => {
        const provisioning = deps.provisioning;
        if (!provisioning) return provisioningUnavailable();
        const endpointId = decodeURIComponent(params.endpoint_id!);
        const status = provisioning.status(endpointId);
        if (!status || !token.bot_ids.includes(status.agentId)) {
          return adminNotFound();
        }
        await provisioning.remove(endpointId);
        return jsonResponse(200, {
          endpoint_id: endpointId,
          result: "removed",
        });
      }),
    ),
  );
}

const PROVISION_MAX_BODY_BYTES = 64 * 1024;

/** Read at most the cap. Returns null when the body is larger. */
async function readCappedBody(req: Request): Promise<string | null> {
  const declared = req.headers.get("Content-Length");
  if (declared && Number(declared) > PROVISION_MAX_BODY_BYTES) return null;
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > PROVISION_MAX_BODY_BYTES) return null;
  return raw;
}

function provisioningUnavailable(): Response {
  return jsonResponse(503, {
    error: "unavailable",
    message: "endpoint provisioning is not configured on this gateway",
  });
}

function provisioningError(error: unknown): Response {
  if (error instanceof ProvisioningError) {
    switch (error.code) {
      case "unknown_agent":
      case "invalid_request":
        return errorResponse("invalid_body", error.message);
      case "conflict":
      case "capacity":
        return adminConflict(error.message);
      case "not_configured":
        return jsonResponse(503, {
          error: "unavailable",
          message: error.message,
        });
    }
  }
  throw error;
}

function provisionAuthed(
  deps: AgentApiDeps,
  handler: AdminHandler,
): (req: Request, params: Record<string, string>) => Promise<Response> {
  return async (req, params) => {
    const a = authenticate(deps.tokens, req.headers.get("Authorization"));
    if ("kind" in a) return mapAuthFailure(a);
    if (!a.token.scopes.includes("endpoints:admin")) {
      return mapAuthFailure({
        kind: "scope_not_permitted",
        scope: "endpoints:admin",
      });
    }
    return handler(req, params, a.token);
  };
}

function registerAdminRoutes(
  unregs: Unregister[],
  router: HttpRouter,
  deps: AgentApiRouterDeps,
): void {
  unregs.push(
    router.route(
      "GET",
      "/v1/admin/endpoints",
      adminAuthed(deps, async (_req, _params, token) => {
        const permitted = new Set(token.bot_ids);
        const endpoints = deps.db
          .listExternalEndpoints()
          .filter((row) => permitted.has(row.agentId))
          .map((row) => ({
            ...row,
            backlog: deps.db.endpointBacklog(row.endpointId),
          }));
        return jsonResponse(200, { endpoints });
      }),
    ),
    router.route(
      "GET",
      "/v1/admin/conversations",
      adminAuthed(deps, async (req, _params, token) => {
        const permitted = new Set(token.bot_ids);
        const conversations = deps.db
          .listOperationalConversations(adminLimit(req))
          .filter((row) => permitted.has(row.agentId));
        return jsonResponse(200, { conversations });
      }),
    ),
    router.route(
      "GET",
      "/v1/admin/sessions",
      adminAuthed(deps, async (req, _params, token) => {
        const permitted = new Set(token.bot_ids);
        const sessions = deps.db
          .listOperationalSessions(adminLimit(req))
          .filter((row) => permitted.has(row.agentId));
        return jsonResponse(200, { sessions });
      }),
    ),
    router.route(
      "POST",
      "/v1/admin/sessions/:session_key/rotate",
      adminAuthed(deps, async (_req, params, token) => {
        const sessionKey = decodeURIComponent(params.session_key!);
        const session = deps.db.getConversationSession(sessionKey);
        if (!session || !token.bot_ids.includes(session.agent_id)) {
          return adminNotFound();
        }
        if (session.state === "busy") {
          return adminConflict("session is busy; cancel or drain it first");
        }
        deps.db.resetConversationSession(session.session_key);
        return jsonResponse(200, {
          session_key: session.session_key,
          generation: session.generation + 1,
          state: "stopped",
        });
      }),
    ),
    router.route(
      "GET",
      "/v1/admin/outbox",
      adminAuthed(deps, async (req, _params, token) => {
        const permitted = new Set(token.bot_ids);
        const outbox = deps.db
          .listOperationalOutbox(adminLimit(req))
          .filter((row) => permitted.has(row.agentId));
        return jsonResponse(200, { outbox });
      }),
    ),
  );

  for (const action of ["replay", "dead-letter"] as const) {
    unregs.push(
      router.route(
        "POST",
        `/v1/admin/outbox/:outbox_id/${action}`,
        adminAuthed(deps, async (_req, params, token) => {
          const id = Number(params.outbox_id);
          const row = Number.isSafeInteger(id)
            ? deps.db.getOperationalOutbox(id)
            : null;
          if (!row || !token.bot_ids.includes(row.agentId)) {
            return adminNotFound();
          }
          const changed =
            action === "replay"
              ? deps.db.replayOutbox(id)
              : deps.db.deadLetterOutbox(
                  id,
                  "operator dead-lettered outbox row through admin API",
                );
          if (!changed) {
            return adminConflict(
              action === "replay"
                ? "outbox row is not dead or failed"
                : "outbox row is not in a dead-letterable state",
            );
          }
          return jsonResponse(200, {
            id,
            status: action === "replay" ? "pending" : "dead",
          });
        }),
      ),
    );
  }

  for (const action of ["drain", "resume", "dead-letter"] as const) {
    unregs.push(
      router.route(
        "POST",
        `/v1/admin/endpoints/:endpoint_id/${action}`,
        adminAuthed(deps, async (req, params, token) => {
          const endpointId = decodeURIComponent(params.endpoint_id!);
          const endpoint = deps.db.getEndpointState(endpointId);
          if (!endpoint || !token.bot_ids.includes(endpoint.agentId)) {
            return adminNotFound();
          }
          if (action === "drain") {
            if (endpoint.lifecycleState !== "active") {
              return adminConflict("endpoint must be active before draining");
            }
            deps.db.setEndpointLifecycle(
              endpointId,
              "draining",
              "operator_drain",
            );
            return jsonResponse(200, {
              endpoint_id: endpointId,
              lifecycle_state: "draining",
            });
          }
          if (action === "resume") {
            if (
              endpoint.stateReason === "config_disabled" ||
              endpoint.stateReason === "platform_disabled"
            ) {
              return adminConflict("endpoint is disabled by configuration");
            }
            deps.db.setEndpointLifecycle(endpointId, "active", null);
            return jsonResponse(200, {
              endpoint_id: endpointId,
              lifecycle_state: "active",
            });
          }
          if (!(await acknowledgedDeadLetter(req))) {
            return errorResponse(
              "invalid_body",
              'forced dead-letter requires {"acknowledge_data_loss":true}',
            );
          }
          if (endpoint.lifecycleState !== "draining") {
            return adminConflict(
              "endpoint must be draining before forced dead-letter",
            );
          }
          const backlog = deps.db.endpointBacklog(endpointId);
          if (backlog.running > 0) {
            return adminConflict("endpoint still has running turns");
          }
          deps.db.deadLetterEndpointPending(
            endpointId,
            "operator acknowledged forced dead-letter through admin API",
          );
          deps.db.setEndpointLifecycle(
            endpointId,
            "disabled",
            "operator_dead_lettered",
          );
          return jsonResponse(200, {
            endpoint_id: endpointId,
            lifecycle_state: "disabled",
            acknowledged_data_loss: true,
          });
        }),
      ),
    );
  }
}

type AdminHandler = (
  req: Request,
  params: Record<string, string>,
  token: ResolvedAgentApiToken,
) => Promise<Response>;

function adminAuthed(
  deps: AgentApiDeps,
  handler: AdminHandler,
): (req: Request, params: Record<string, string>) => Promise<Response> {
  return async (req, params) => {
    const a = authenticate(deps.tokens, req.headers.get("Authorization"));
    if ("kind" in a) return mapAuthFailure(a);
    if (!a.token.scopes.includes("ask")) {
      return mapAuthFailure({ kind: "scope_not_permitted", scope: "ask" });
    }
    return handler(req, params, a.token);
  };
}

function adminLimit(req: Request): number {
  const raw = new URL(req.url).searchParams.get("limit");
  if (!raw || !/^\d+$/.test(raw)) return 100;
  return Math.max(1, Math.min(500, Number(raw)));
}

async function acknowledgedDeadLetter(req: Request): Promise<boolean> {
  const raw = await req.text();
  if (raw.length > 1_024) return false;
  try {
    const body = JSON.parse(raw) as { acknowledge_data_loss?: unknown };
    return body.acknowledge_data_loss === true;
  } catch {
    return false;
  }
}

function adminNotFound(): Response {
  return jsonResponse(404, {
    error: "not_found",
    message: "resource not found",
  });
}

function adminConflict(message: string): Response {
  return jsonResponse(409, { error: "invalid_state", message });
}

function authed(
  deps: AgentApiDeps,
  scope: Scope,
  handler: AuthedHandler,
): (req: Request, params: Record<string, string>) => Promise<Response> {
  return async (req, params) => {
    const botId = params.bot_id!;
    // Authenticate FIRST so unauthenticated callers cannot probe bot
    // existence by comparing "unknown_bot" against "missing_auth"/"invalid_token".
    const a = authenticate(deps.tokens, req.headers.get("Authorization"));
    if ("kind" in a) return mapAuthFailure(a);
    // Authorization (token→bot+scope) comes next: a token that is not
    // permitted for this bot gets the same response regardless of whether
    // the bot exists, so enumeration stays blocked even for authenticated
    // but unauthorized callers.
    const authz = authorize(a.token, botId, scope);
    if (authz) return mapAuthFailure(authz);
    // Only reveal the bot-existence signal to a caller whose token is
    // authorized for this exact bot id.
    if (!deps.registry.bot(botId)) return errorResponse("unknown_bot");
    return handler(req, { ...params, token: a.token, botId });
  };
}
