// Shared harness for §12.5 security tests. Files in this directory
// grind through the matrix in tasks/impl-agent-api.md §12.5 and all
// need the same three things:
//
//   1. A live HTTP server with the real agent-api routes wired up.
//   2. A token set they control (multiple tokens with different scopes
//      and bot allowlists so authz tests can cross-check).
//   3. A real GatewayDB so handler internals that read turn rows work.
//
// The pool is stubbed by default since most security tests don't actually
// spawn runners — they exercise the auth/authz/validation layers that
// sit *above* the pool. Files that need real pool behaviour (e.g. the
// side-session-flood test) can pass a custom `pool` option.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer, type Server } from "../../../src/server.js";
import {
  registerAgentApiHealthRoute,
  registerAgentApiRoutes,
} from "../../../src/agent-api/router.js";
import { applyMigrations } from "../../../src/db/migrate.js";
import { GatewayDB } from "../../../src/db/gateway-db.js";
import { logger } from "../../../src/log.js";
import type { ResolvedAgentApiToken } from "../../../src/config/load.js";
import type { Config } from "../../../src/config/schema.js";
import type { Scope } from "../../../src/agent-api/types.js";
import { makeTestConfig, makeTestBotConfig } from "../../fixtures/bots.js";

export interface Harness {
  base: string;
  db: GatewayDB;
  config: Config;
  tokens: ResolvedAgentApiToken[];
  /** Call the request as { headers: { Authorization: bearerFor(token) } }. */
  bearerFor: (token: ResolvedAgentApiToken) => string;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  botIds?: string[];
  tokens?: ResolvedAgentApiToken[];
  configOverride?: (c: Config) => void;
  pool?: unknown;
  orphans?: unknown;
  supportsSideSessions?: boolean;
}

export function hash(s: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(s, "utf8").digest());
}

/**
 * Build a resolved token shape for tests. Keep secrets >= 6 chars so the
 * log-redactor treats them as real secrets.
 */
export function mkToken(
  name: string,
  secret: string,
  overrides: Partial<ResolvedAgentApiToken> = {},
): ResolvedAgentApiToken {
  return {
    name,
    secret,
    hash: hash(secret),
    bot_ids: ["bot1"],
    scopes: ["ask"] as Scope[],
    ...overrides,
  };
}

function stubPool(): {
  listForBot: () => unknown[];
  stop: () => Promise<void>;
  acquire: (...args: unknown[]) => Promise<unknown>;
  release: (...args: unknown[]) => Promise<void>;
  stopSideSession: (...args: unknown[]) => Promise<void>;
} {
  // Matches the AcquireResult shape in src/agent-api/pool.ts — tests
  // that reach acquire() get a deterministic runner_error (500), which
  // is the "we never actually spawn a runner" posture the security
  // tests want. Individual files can override `pool` with a custom
  // shape when they need different behaviour.
  return {
    listForBot: () => [],
    stop: async () => {},
    acquire: async () => ({
      kind: "runner_error",
      message: "stub pool never spawns runners",
    }),
    release: async () => {},
    stopSideSession: async () => {},
  };
}

function stubOrphans(): {
  attach: () => void;
  shutdown: () => void;
  detach: () => void;
} {
  return {
    attach: () => {},
    detach: () => {},
    shutdown: () => {},
  };
}

function fakeRegistry(
  botIds: string[],
  config: Config,
  supportsSideSessions: boolean,
): {
  bot(id: string): unknown;
  botIds: string[];
  dispatchFor(botId: string): void;
} {
  return {
    bot(id: string) {
      if (!botIds.includes(id)) return undefined;
      const botConfig = config.bots.find((b) => b.id === id);
      if (!botConfig) return undefined;
      return {
        botConfig,
        runner: { supportsSideSessions: () => supportsSideSessions },
      };
    },
    botIds,
    dispatchFor: () => {
      // No-op — the send handler fires this after insert. Real
      // registry wakes the dispatch loop; the security tests only
      // care about whether the handler reached (or did not reach)
      // this line.
    },
  };
}

export function startHarness(opts: HarnessOptions = {}): Harness {
  const botIds = opts.botIds ?? ["bot1"];
  const tokens = opts.tokens ?? [
    mkToken("cos", "sekret-cos-value-123456", { bot_ids: botIds, scopes: ["ask", "send"] }),
  ];

  const tmpDir = mkdtempSync(join(tmpdir(), "torana-sec-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  const db = new GatewayDB(dbPath);

  const bots = botIds.map((id) => makeTestBotConfig(id));
  const config = makeTestConfig(bots);
  config.agent_api.enabled = true;
  config.gateway.data_dir = tmpDir;
  opts.configOverride?.(config);

  const server: Server = createServer({ port: 0, hostname: "127.0.0.1" });
  registerAgentApiHealthRoute(server.router, {
    config,
    uptimeSecs: () => 1,
  });
  registerAgentApiRoutes(server.router, {
    config,
    db,
    registry: fakeRegistry(botIds, config, opts.supportsSideSessions ?? true) as never,
    tokens,
    log: logger("agent-api-sec-test"),
    pool: (opts.pool ?? stubPool()) as never,
    orphans: (opts.orphans ?? stubOrphans()) as never,
  });

  return {
    base: `http://127.0.0.1:${server.port}`,
    db,
    config,
    tokens,
    bearerFor: (t) => `Bearer ${t.secret}`,
    close: async () => {
      await server.stop();
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
