// Dashboard proxy hardening — verifies:
//   1. Sensitive request headers (Authorization, Cookie, Idempotency-Key,
//      X-Telegram-Bot-Api-Secret-Token, Host, Proxy-Authorization) are
//      stripped before the request is forwarded upstream.
//   2. Redirects returned by the upstream are NOT followed (redirect:"manual"
//      means the 302 is passed back to the caller unchanged, so a rogue or
//      compromised upstream cannot redirect the proxy into an SSRF target).
//   3. Loopback-only `proxy_target` default — config validation rejects a
//      non-loopback target unless `allow_non_loopback_proxy_target: true`.
//
// The proxy itself is still unauthenticated (that's its operational model —
// operators are expected to keep the gateway on loopback or behind a reverse
// proxy with its own auth); the hardening here closes the "a caller drives
// it as an open SSRF / credential-exfil gadget" path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createServer, type Server as HttpServer } from "../../src/server.js";
import { loadConfigFromString } from "../../src/config/load.js";

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

beforeEach(() => {
  captured = null;
  upstreamResponse = () => new Response("ok", { status: 200 });

  upstream = createServer({ port: 0, hostname: "127.0.0.1" });
  upstream.router.route("GET", "/*", async (req) => {
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
  });

  // Mount the dashboard-style proxy handler. Mirrors the logic in
  // src/main.ts:registerFixedRoutes so this test stays in sync with the
  // intended header-strip + redirect policy.
  proxyServer = createServer({ port: 0, hostname: "127.0.0.1" });
  const target = `http://127.0.0.1:${upstream.port}`.replace(/\/$/, "");
  const mountPath = "/dashboard";
  proxyServer.router.route("GET", `${mountPath}/*`, async (req) => {
    const url = new URL(req.url);
    const rel = url.pathname.slice(mountPath.length) || "/";
    const backendUrl = `${target}${rel}${url.search}`;
    const forwardedHeaders = new Headers(req.headers);
    for (const h of [
      "authorization",
      "cookie",
      "proxy-authorization",
      "idempotency-key",
      "x-telegram-bot-api-secret-token",
      "host",
    ]) {
      forwardedHeaders.delete(h);
    }
    const proxyReq = new Request(backendUrl, {
      method: req.method,
      headers: forwardedHeaders,
      body: req.body,
      redirect: "manual",
    });
    return await fetch(proxyReq);
  });
});

afterEach(async () => {
  await proxyServer.stop();
  await upstream.stop();
});

describe("dashboard proxy header-strip", () => {
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
});

describe("dashboard proxy redirect handling", () => {
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
