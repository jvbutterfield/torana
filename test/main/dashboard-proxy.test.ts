// Dashboard proxy hardening — verifies:
//   1. Sensitive request headers (Authorization, Cookie, Idempotency-Key,
//      X-Telegram-Bot-Api-Secret-Token, Host, Proxy-Authorization) are
//      stripped before the request is forwarded upstream (default mode).
//   2. Redirects returned by the upstream are NOT followed (redirect:"manual"
//      means the 302 is passed back to the caller unchanged, so a rogue or
//      compromised upstream cannot redirect the proxy into an SSRF target).
//   3. Loopback-only `proxy_target` default — config validation rejects a
//      non-loopback target unless `allow_non_loopback_proxy_target: true`.
//   4. `forward_full_request: true` mode — opt-in passthrough for dashboards
//      that own their own auth: all standard methods reach the upstream,
//      Authorization+Cookie pass through, but Proxy-Authorization /
//      Idempotency-Key / X-Telegram-Bot-Api-Secret-Token / Host are still
//      stripped, and redirects are still not followed.
//
// The proxy itself is still unauthenticated (that's its operational model —
// operators are expected to keep the gateway on loopback or behind a reverse
// proxy with its own auth); the hardening here closes the "a caller drives
// it as an open SSRF / credential-exfil gadget" path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createServer, type Server as HttpServer } from "../../src/server.js";
import { loadConfigFromString } from "../../src/config/load.js";
import type { HttpMethod } from "../../src/transport/types.js";

// Manually re-implement the proxy route against a fresh server. We can't
// easily inject the real `registerFixedRoutes()` without spinning up DB /
// registry plumbing, and the behaviour under test is self-contained to the
// header-strip + redirect:"manual" logic, so a focused copy is simpler.

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyBytes: number;
  redirect: RequestRedirect | undefined;
}

let upstream: HttpServer;
let proxyServer: HttpServer;
let captured: CapturedRequest | null;
let upstreamResponse: () => Response;

const ALL_METHODS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
];

// Mounts a dashboard-style proxy handler. Mirrors the logic in
// src/main.ts:registerFixedRoutes so this test stays in sync with the
// intended header-strip + redirect policy. Pass forwardFull=true to exercise
// the opt-in passthrough mode (all methods + Authorization/Cookie preserved).
function mountProxy(forwardFull: boolean): void {
  const target = `http://127.0.0.1:${upstream.port}`.replace(/\/$/, "");
  const mountPath = "/dashboard";
  const stripList = [
    "proxy-authorization",
    "idempotency-key",
    "x-telegram-bot-api-secret-token",
    "host",
    "connection",
  ];
  if (!forwardFull) {
    stripList.push("authorization", "cookie");
  }
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const rel = url.pathname.slice(mountPath.length) || "/";
    const backendUrl = `${target}${rel}${url.search}`;
    const forwardedHeaders = new Headers(req.headers);
    for (const h of stripList) forwardedHeaders.delete(h);
    forwardedHeaders.set("connection", "close");
    const proxyReq = new Request(backendUrl, {
      method: req.method,
      headers: forwardedHeaders,
      body: req.body,
      redirect: "manual",
      signal: req.signal,
    });
    return await fetch(proxyReq);
  };
  const methods: HttpMethod[] = forwardFull ? ALL_METHODS : ["GET"];
  for (const m of methods) {
    proxyServer.router.route(m, `${mountPath}/*`, handler);
  }
}

beforeEach(() => {
  captured = null;
  upstreamResponse = () => new Response("ok", { status: 200 });

  upstream = createServer({ port: 0, hostname: "127.0.0.1" });
  // Upstream accepts every method so we can verify forward_full_request
  // routes them all through.
  const captureHandler = async (req: Request) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of req.headers) headers[k.toLowerCase()] = v;
    const body = req.body ? await req.arrayBuffer() : new ArrayBuffer(0);
    captured = {
      method: req.method,
      url: req.url,
      headers,
      bodyBytes: body.byteLength,
      redirect: undefined,
    };
    return upstreamResponse();
  };
  for (const m of ALL_METHODS) {
    upstream.router.route(m, "/*", captureHandler);
  }

  proxyServer = createServer({ port: 0, hostname: "127.0.0.1" });
});

afterEach(async () => {
  await proxyServer.stop();
  await upstream.stop();
});

describe("dashboard proxy header-strip (default mode)", () => {
  beforeEach(() => mountProxy(false));

  test("Authorization header is not forwarded upstream", async () => {
    await fetch(`http://127.0.0.1:${proxyServer.port}/dashboard/whatever`, {
      headers: {
        Authorization: "Bearer super-secret-bearer-token-abcdefghi12345678",
        "Idempotency-Key": "idem-key-12345678901234567890",
        Cookie: "session=cookie-value",
      },
    });
    expect(captured).not.toBeNull();
    expect(captured!.headers["authorization"]).toBeUndefined();
    expect(captured!.headers["idempotency-key"]).toBeUndefined();
    expect(captured!.headers["cookie"]).toBeUndefined();
  });

  test("other headers (Accept, User-Agent) ARE forwarded", async () => {
    await fetch(`http://127.0.0.1:${proxyServer.port}/dashboard/x`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "test/1.0",
      },
    });
    expect(captured).not.toBeNull();
    expect(captured!.headers["accept"]).toBe("application/json");
    expect(captured!.headers["user-agent"]).toBe("test/1.0");
  });

  test("Host header is stripped so fetch sets the correct upstream Host", async () => {
    // Bun's fetch rewrites Host from the URL; verify the original Host
    // header never reached the backend. (A stale Host confuses vhosts and
    // has been used in Host-header cache-poisoning attacks.)
    await fetch(`http://127.0.0.1:${proxyServer.port}/dashboard/x`, {
      headers: { Host: "attacker.example.com" },
    });
    expect(captured).not.toBeNull();
    expect(captured!.headers["host"]).not.toBe("attacker.example.com");
  });

  test("non-GET methods are NOT routed (GET-only registration)", async () => {
    // POST / PUT / DELETE / etc. fall through to the gateway's default 404
    // when forward_full_request is off — only GET is registered.
    const r = await fetch(
      `http://127.0.0.1:${proxyServer.port}/dashboard/api/login`,
      { method: "POST", body: "x" },
    );
    expect(r.status).toBe(404);
    expect(captured).toBeNull();
  });
});

describe("dashboard proxy redirect handling", () => {
  beforeEach(() => mountProxy(false));

  test("302 from upstream is passed through without being followed", async () => {
    // If the proxy were to follow the redirect, a compromised upstream
    // could point at an arbitrary URL and the gateway would fetch it.
    upstreamResponse = () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.example.com/pwn" },
      });
    const r = await fetch(`http://127.0.0.1:${proxyServer.port}/dashboard/x`, {
      redirect: "manual",
    });
    // Either 302 (if bun forwards it) or 0 (opaque-redirect). What MUST NOT
    // happen is a 200 from attacker.example.com.
    expect([0, 302]).toContain(r.status);
    // Verify no second fetch to attacker.example.com occurred (upstream
    // only received the single request).
    expect(captured).not.toBeNull();
    expect(captured!.url).toContain("127.0.0.1");
  });
});

describe("dashboard proxy forward_full_request mode", () => {
  beforeEach(() => mountProxy(true));

  test("Authorization and Cookie pass through to upstream", async () => {
    await fetch(`http://127.0.0.1:${proxyServer.port}/dashboard/api/me`, {
      headers: {
        Authorization: "Bearer the-dashboards-own-bearer",
        Cookie: "session=abc123; csrftoken=xyz",
      },
    });
    expect(captured).not.toBeNull();
    expect(captured!.headers["authorization"]).toBe(
      "Bearer the-dashboards-own-bearer",
    );
    expect(captured!.headers["cookie"]).toBe("session=abc123; csrftoken=xyz");
  });

  test("Proxy-Authorization, Idempotency-Key, X-Telegram-Bot-Api-Secret-Token are still stripped", async () => {
    await fetch(`http://127.0.0.1:${proxyServer.port}/dashboard/x`, {
      headers: {
        "Proxy-Authorization": "Basic shouldnt-leak",
        "Idempotency-Key": "idem-shouldnt-leak",
        "X-Telegram-Bot-Api-Secret-Token": "telegram-shouldnt-leak",
      },
    });
    expect(captured).not.toBeNull();
    expect(captured!.headers["proxy-authorization"]).toBeUndefined();
    expect(captured!.headers["idempotency-key"]).toBeUndefined();
    expect(
      captured!.headers["x-telegram-bot-api-secret-token"],
    ).toBeUndefined();
  });

  test("Host is still stripped to avoid vhost confusion", async () => {
    await fetch(`http://127.0.0.1:${proxyServer.port}/dashboard/x`, {
      headers: { Host: "attacker.example.com" },
    });
    expect(captured).not.toBeNull();
    expect(captured!.headers["host"]).not.toBe("attacker.example.com");
  });

  test("POST with body reaches upstream with Authorization preserved", async () => {
    const r = await fetch(
      `http://127.0.0.1:${proxyServer.port}/dashboard/api/login`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer login-bearer",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user: "admin" }),
      },
    );
    expect(r.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("POST");
    expect(captured!.headers["authorization"]).toBe("Bearer login-bearer");
    expect(captured!.bodyBytes).toBeGreaterThan(0);
  });

  test.each(["PUT", "PATCH", "DELETE", "OPTIONS"] as const)(
    "%s reaches upstream",
    async (method) => {
      const r = await fetch(
        `http://127.0.0.1:${proxyServer.port}/dashboard/api/x`,
        { method },
      );
      expect(r.status).toBe(200);
      expect(captured).not.toBeNull();
      expect(captured!.method).toBe(method);
    },
  );

  test("Set-Cookie from upstream is forwarded back to the browser", async () => {
    // Login flow: upstream sets an HttpOnly session cookie on the response;
    // we need that to round-trip so the browser stores the session.
    upstreamResponse = () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie":
            "session=upstream-session-id; HttpOnly; Path=/; SameSite=Strict",
        },
      });
    const r = await fetch(
      `http://127.0.0.1:${proxyServer.port}/dashboard/api/login`,
      { method: "POST" },
    );
    expect(r.headers.get("set-cookie")).toContain(
      "session=upstream-session-id",
    );
  });

  test("302 from upstream is still passed through without being followed", async () => {
    // SSRF defense holds regardless of forward_full_request.
    upstreamResponse = () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.example.com/pwn" },
      });
    const r = await fetch(`http://127.0.0.1:${proxyServer.port}/dashboard/x`, {
      redirect: "manual",
    });
    expect([0, 302]).toContain(r.status);
    expect(captured).not.toBeNull();
    expect(captured!.url).toContain("127.0.0.1");
  });
});

describe("dashboard proxy connection lifetime (GH#16)", () => {
  // Regression coverage for GH#16: `/dashboard/*` wedges after multi-hour
  // uptime because (a) bun's HTTP client parks every upstream socket in the
  // keepalive pool with no idle eviction, and (b) when the inbound client
  // disconnects mid-stream (SSE EventSource reconnects), the upstream fetch
  // is never aborted so the upstream socket is held open. The fix: send
  // `Connection: close` upstream and propagate `req.signal` into the
  // upstream fetch.

  test("Connection: close is set on the upstream request (default mode)", async () => {
    mountProxy(false);
    await fetch(`http://127.0.0.1:${proxyServer.port}/dashboard/x`);
    expect(captured).not.toBeNull();
    expect(captured!.headers["connection"]?.toLowerCase()).toBe("close");
  });

  test("caller-supplied Connection: keep-alive is overridden to close", async () => {
    // A caller cannot pin a keepalive on the upstream socket. Otherwise the
    // pool-accumulation regression returns for any caller who sets the
    // header (most HTTP libs default to keep-alive).
    mountProxy(false);
    await fetch(`http://127.0.0.1:${proxyServer.port}/dashboard/y`, {
      headers: { Connection: "keep-alive" },
    });
    expect(captured).not.toBeNull();
    expect(captured!.headers["connection"]?.toLowerCase()).toBe("close");
  });

  test("Connection: close is set in forward_full_request mode too", async () => {
    mountProxy(true);
    await fetch(`http://127.0.0.1:${proxyServer.port}/dashboard/api/login`, {
      method: "POST",
      body: "x",
    });
    expect(captured).not.toBeNull();
    expect(captured!.headers["connection"]?.toLowerCase()).toBe("close");
  });

  test("client disconnect aborts the upstream fetch (SSE / long-lived response)", async () => {
    // Replace the default capture upstream with one that keeps the response
    // body open and exposes whether its inbound request was aborted by the
    // proxy. This is the exact SSE shape from GH#16: headers flush
    // immediately, body never ends, then the client goes away. Without
    // `signal: req.signal` in the proxy, the upstream socket is held until
    // the upstream times out — that's the leak.
    await upstream.stop();
    let upstreamAborted = false;
    let upstreamSawRequest = false;
    let resolveAbort!: () => void;
    const upstreamAbortedPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    upstream = createServer({ port: 0, hostname: "127.0.0.1" });
    const longLivedHandler = async (req: Request): Promise<Response> => {
      upstreamSawRequest = true;
      req.signal.addEventListener("abort", () => {
        upstreamAborted = true;
        resolveAbort();
      });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": hello\n\n"));
          // intentionally never close — caller must abort.
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    for (const m of ALL_METHODS) {
      upstream.router.route(m, "/*", longLivedHandler);
    }
    mountProxy(false);

    const ac = new AbortController();
    const inflight = fetch(
      `http://127.0.0.1:${proxyServer.port}/dashboard/api/pipeline/stream`,
      { signal: ac.signal },
    );
    // Wait until the upstream has actually accepted the proxied request,
    // otherwise aborting before the proxy hands off would not exercise
    // signal propagation.
    const start = Date.now();
    while (!upstreamSawRequest && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(upstreamSawRequest).toBe(true);
    ac.abort();
    await inflight.catch(() => {});
    // If `signal: req.signal` is missing from the proxy, the upstream never
    // sees the abort and this race resolves to the rejection.
    await Promise.race([
      upstreamAbortedPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("upstream abort not seen")), 2000),
      ),
    ]);
    expect(upstreamAborted).toBe(true);
  });
});

describe("dashboard proxy_target loopback validation", () => {
  const BASE = `
version: 1
gateway:
  port: 3000
  data_dir: /tmp/torana-test
transport:
  default_mode: polling
access_control:
  allowed_user_ids: [111]
bots:
  - id: alpha
    token: BOTTOK:AAAAAA
    runner:
      type: claude-code
      cli_path: claude
      acknowledge_dangerous: true
`;

  test("enabled + loopback proxy_target → accepted", () => {
    const raw =
      BASE +
      `
dashboard:
  enabled: true
  proxy_target: http://127.0.0.1:4000
`;
    const { config } = loadConfigFromString(raw);
    expect(config.dashboard.enabled).toBe(true);
  });

  test("enabled + localhost proxy_target → accepted", () => {
    const raw =
      BASE +
      `
dashboard:
  enabled: true
  proxy_target: http://localhost:4000
`;
    const { config } = loadConfigFromString(raw);
    expect(config.dashboard.enabled).toBe(true);
  });

  test("enabled + IPv6 loopback proxy_target → accepted", () => {
    const raw =
      BASE +
      `
dashboard:
  enabled: true
  proxy_target: "http://[::1]:4000"
`;
    const { config } = loadConfigFromString(raw);
    expect(config.dashboard.enabled).toBe(true);
  });

  test("enabled + non-loopback proxy_target → rejected without opt-in", () => {
    const raw =
      BASE +
      `
dashboard:
  enabled: true
  proxy_target: https://internal.example.com
`;
    expect(() => loadConfigFromString(raw)).toThrow(/must be loopback/);
  });

  test("enabled + non-loopback proxy_target WITH opt-in → accepted", () => {
    const raw =
      BASE +
      `
dashboard:
  enabled: true
  proxy_target: https://internal.example.com
  allow_non_loopback_proxy_target: true
`;
    const { config } = loadConfigFromString(raw);
    expect(config.dashboard.enabled).toBe(true);
    expect(config.dashboard.allow_non_loopback_proxy_target).toBe(true);
  });
});

describe("dashboard forward_full_request config", () => {
  const BASE = `
version: 1
gateway:
  port: 3000
  data_dir: /tmp/torana-test
transport:
  default_mode: polling
access_control:
  allowed_user_ids: [111]
bots:
  - id: alpha
    token: BOTTOK:AAAAAA
    runner:
      type: claude-code
      cli_path: claude
      acknowledge_dangerous: true
`;

  test("forward_full_request defaults to false when omitted", () => {
    const raw =
      BASE +
      `
dashboard:
  enabled: true
  proxy_target: http://127.0.0.1:4000
`;
    const { config } = loadConfigFromString(raw);
    expect(config.dashboard.forward_full_request).toBe(false);
  });

  test("forward_full_request: true is parsed", () => {
    const raw =
      BASE +
      `
dashboard:
  enabled: true
  proxy_target: http://127.0.0.1:4000
  forward_full_request: true
`;
    const { config } = loadConfigFromString(raw);
    expect(config.dashboard.forward_full_request).toBe(true);
  });

  test("forward_full_request alone (loopback target) → no warning", () => {
    const raw =
      BASE +
      `
dashboard:
  enabled: true
  proxy_target: http://127.0.0.1:4000
  forward_full_request: true
`;
    const { warnings } = loadConfigFromString(raw);
    expect(warnings.some((w) => w.includes("forward_full_request"))).toBe(
      false,
    );
  });

  test("forward_full_request + allow_non_loopback_proxy_target → warning emitted", () => {
    // The dangerous combination: client bearers/cookies cross a network
    // boundary to a non-loopback host. Each flag alone is fine.
    const raw =
      BASE +
      `
dashboard:
  enabled: true
  proxy_target: https://internal.example.com
  allow_non_loopback_proxy_target: true
  forward_full_request: true
`;
    const { warnings } = loadConfigFromString(raw);
    expect(
      warnings.some(
        (w) => w.includes("forward_full_request") && w.includes("non-loopback"),
      ),
    ).toBe(true);
  });
});
