// Shared types for the agent-api HTTP surface. See tasks/impl-agent-api.md §3.3.

import type { Config } from "../config/schema.js";
import type { GatewayDB } from "../db/gateway-db.js";
import type { BotRegistry } from "../core/registry.js";
import type { Logger } from "../log.js";
import type { ResolvedAgentApiToken } from "../config/load.js";
import type { Metrics } from "../metrics.js";

export type Scope = "ask" | "send";

export interface AuthSuccess {
  token: ResolvedAgentApiToken;
}

export type AuthFailure =
  | { kind: "missing_auth" }
  | { kind: "invalid_token" }
  | { kind: "bot_not_permitted"; botId: string }
  | { kind: "scope_not_permitted"; scope: Scope };

/**
 * Dependency bundle threaded through router + handlers. Kept small so
 * handlers stay trivially testable — pass a stub with just the fields a
 * particular handler exercises.
 */
export interface AgentApiDeps {
  config: Config;
  db: GatewayDB;
  registry: BotRegistry;
  tokens: readonly ResolvedAgentApiToken[];
  log: Logger;
  clock?: () => number;
  /** Optional — counter/histogram recorder. Handlers no-op if absent. */
  metrics?: Metrics;
}

export interface AuthedParams {
  [key: string]: unknown;
  token: ResolvedAgentApiToken;
  botId: string;
}

export type AuthedHandler = (
  req: Request,
  params: AuthedParams,
) => Promise<Response>;

export type { ResolvedAgentApiToken };
