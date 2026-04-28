// HTTP server + router. server.ts is the *only* module that calls Bun.serve.
// Transports and the metrics/dashboard endpoints register routes against the
// shared HttpRouter. Path-param routes use :name syntax and lose precedence
// to exact matches.

import { logger } from "./log.js";
import type {
  HttpMethod,
  HttpRouter,
  RouteHandler,
  Unregister,
} from "./transport/types.js";

const log = logger("server");

interface ExactKey {
  method: HttpMethod;
  path: string;
}

interface ParamRoute {
  method: HttpMethod;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

interface PrefixRoute {
  method: HttpMethod;
  prefix: string;
  handler: RouteHandler;
}

export interface Server {
  port: number;
  router: HttpRouter;
  stop(): Promise<void>;
}

export interface ServerOptions {
  port: number;
  hostname?: string;
}

export function createServer(opts: ServerOptions): Server {
  const exactRoutes = new Map<string, RouteHandler>(); // keyed "METHOD path"
  const paramRoutes: ParamRoute[] = [];
  const prefixRoutes: PrefixRoute[] = [];

  let fallback: ((req: Request) => Promise<Response>) | null = null;
  let errorHandler: ((err: unknown, req: Request) => Promise<Response>) | null =
    null;

  function key(k: ExactKey): string {
    return `${k.method} ${k.path}`;
  }

  const router: HttpRouter = {
    route(method, path, handler) {
      if (path.startsWith("/") && !path.includes(":") && !path.endsWith("/*")) {
        const k = key({ method, path });
        if (exactRoutes.has(k)) {
          throw new Error(`route ${k} already registered`);
        }
        exactRoutes.set(k, handler);
        return (() => {
          exactRoutes.delete(k);
        }) as Unregister;
      }
      if (path.endsWith("/*")) {
        const prefix = path.slice(0, -2);
        const route: PrefixRoute = { method, prefix, handler };
        prefixRoutes.push(route);
        return (() => {
          const i = prefixRoutes.indexOf(route);
          if (i >= 0) prefixRoutes.splice(i, 1);
        }) as Unregister;
      }
      // Path-param route: "/webhook/:botId" → regex.
      const paramNames: string[] = [];
      const regexStr = path
        .split("/")
        .map((seg) => {
          if (seg.startsWith(":")) {
            paramNames.push(seg.slice(1));
            return "([^/]+)";
          }
          return escapeRegExp(seg);
        })
        .join("/");
      const pattern = new RegExp(`^${regexStr}$`);
      const route: ParamRoute = { method, pattern, paramNames, handler };
      paramRoutes.push(route);
      return (() => {
        const i = paramRoutes.indexOf(route);
        if (i >= 0) paramRoutes.splice(i, 1);
      }) as Unregister;
    },

    setFallback(handler) {
      fallback = handler;
    },

    setErrorHandler(handler) {
      errorHandler = handler;
    },
  };

  async function defaultFallback(_req: Request): Promise<Response> {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  async function defaultErrorHandler(
    err: unknown,
    req: Request,
  ): Promise<Response> {
    log.error("request handler threw", {
      method: req.method,
      url: req.url,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response(JSON.stringify({ error: "internal_server_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const bun = Bun.serve({
    port: opts.port,
    // Caller is responsible for supplying hostname. Defaults to loopback so
    // standalone `createServer()` uses in tests/tools do not accidentally
    // expose a port to the network.
    hostname: opts.hostname ?? "127.0.0.1",
    async fetch(req) {
      try {
        const url = new URL(req.url);
        // Core methods (GET/POST/DELETE) are accepted unconditionally and
        // fall through to the default 404 fallback when no route matches.
        // Optional methods (PUT/PATCH/OPTIONS/HEAD) are accepted only when
        // an explicit route handles them (the dashboard proxy registers
        // these when forward_full_request is on); otherwise we return 405,
        // preserving the agent-api defence-in-depth behaviour and the
        // legacy plain-text 405 on non-/v1 paths.
        const isCoreMethod =
          req.method === "GET" ||
          req.method === "POST" ||
          req.method === "DELETE";
        const isOptionalMethod =
          req.method === "PUT" ||
          req.method === "PATCH" ||
          req.method === "OPTIONS" ||
          req.method === "HEAD";
        const method: HttpMethod | null =
          isCoreMethod || isOptionalMethod ? (req.method as HttpMethod) : null;

        const methodNotAllowed = (): Response => {
          if (url.pathname.startsWith("/v1/")) {
            return new Response(
              JSON.stringify({
                error: "method_not_allowed",
                message: "method not allowed for this route",
              }),
              { status: 405, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response("Method Not Allowed", { status: 405 });
        };

        if (!method) {
          // Truly unsupported HTTP verb (e.g. CONNECT, TRACE).
          return methodNotAllowed();
        }

        // Exact match wins.
        const exact = exactRoutes.get(key({ method, path: url.pathname }));
        if (exact) {
          return await exact(req, {});
        }

        // Path-param routes (first-registered wins).
        for (const route of paramRoutes) {
          if (route.method !== method) continue;
          const m = route.pattern.exec(url.pathname);
          if (m) {
            const params: Record<string, string> = {};
            route.paramNames.forEach((n, i) => {
              params[n] = decodeURIComponent(m[i + 1] ?? "");
            });
            return await route.handler(req, params);
          }
        }

        // Prefix routes.
        for (const route of prefixRoutes) {
          if (route.method !== method) continue;
          if (
            url.pathname === route.prefix ||
            url.pathname.startsWith(route.prefix + "/")
          ) {
            return await route.handler(req, {});
          }
        }

        // No route matched. Optional methods 405 (no handler claims them);
        // core methods fall through to the 404 fallback.
        if (isOptionalMethod) {
          return methodNotAllowed();
        }
        return await (fallback ?? defaultFallback)(req);
      } catch (err) {
        return await (errorHandler ?? defaultErrorHandler)(err, req);
      }
    },
  });

  log.info("server listening", { port: bun.port });

  return {
    port: typeof bun.port === "number" ? bun.port : opts.port,
    router,
    async stop() {
      bun.stop();
    },
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
