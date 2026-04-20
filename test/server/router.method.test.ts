import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "../../src/server.js";

let server: Server | null = null;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

async function getFreePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const port = typeof s.port === "number" ? s.port : 3000;
  s.stop();
  return port;
}

describe("server/router — method_not_allowed (defence-in-depth for /v1/*)", () => {
  test("PUT against /v1/* route returns 405 with canonical JSON body", async () => {
    server = createServer({ port: await getFreePort() });
    server.router.route("POST", "/v1/bots/:bot_id/ask", async () =>
      new Response("should not be reached"),
    );

    const resp = await fetch(
      `http://127.0.0.1:${server.port}/v1/bots/foo/ask`,
      { method: "PUT", body: "{}" },
    );
    expect(resp.status).toBe(405);
    expect(resp.headers.get("content-type")).toContain("application/json");
    const body = await resp.json();
    expect(body.error).toBe("method_not_allowed");
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
  });

  test("PATCH against /v1/* route returns 405 with canonical JSON body", async () => {
    server = createServer({ port: await getFreePort() });
    server.router.route("GET", "/v1/turns/:turn_id", async () =>
      new Response("should not be reached"),
    );

    const resp = await fetch(
      `http://127.0.0.1:${server.port}/v1/turns/t_123`,
      { method: "PATCH", body: "{}" },
    );
    expect(resp.status).toBe(405);
    expect(resp.headers.get("content-type")).toContain("application/json");
    const body = await resp.json();
    expect(body.error).toBe("method_not_allowed");
  });

  test("405 fires for /v1/* even if no route is registered at that path", async () => {
    server = createServer({ port: await getFreePort() });

    const resp = await fetch(
      `http://127.0.0.1:${server.port}/v1/some/unknown/path`,
      { method: "PUT" },
    );
    expect(resp.status).toBe(405);
    const body = await resp.json();
    expect(body.error).toBe("method_not_allowed");
  });

  test("non-/v1 paths keep the legacy plain-text 405 body (no agent-api coupling)", async () => {
    server = createServer({ port: await getFreePort() });
    server.router.route("POST", "/webhook/:botId", async () => new Response("ok"));

    const resp = await fetch(
      `http://127.0.0.1:${server.port}/webhook/alpha`,
      { method: "PUT" },
    );
    expect(resp.status).toBe(405);
    expect(resp.headers.get("content-type")).not.toContain("application/json");
    expect(await resp.text()).toBe("Method Not Allowed");
  });

  test("405 body shape matches errors.ts canonical code constant", async () => {
    // Drift-guard: if the code string in errors.ts is renamed, the server's
    // inline body must move with it. This test catches silent divergence.
    const { statusFor } = await import("../../src/agent-api/errors.js");
    expect(statusFor("method_not_allowed")).toBe(405);

    server = createServer({ port: await getFreePort() });
    const resp = await fetch(
      `http://127.0.0.1:${server.port}/v1/bots/foo/ask`,
      { method: "PUT" },
    );
    const body = await resp.json();
    expect(body.error).toBe("method_not_allowed");
  });

  test("registered GET/POST/DELETE still work normally on /v1/* (no regression)", async () => {
    server = createServer({ port: await getFreePort() });
    server.router.route("GET", "/v1/health", async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const resp = await fetch(`http://127.0.0.1:${server.port}/v1/health`);
    expect(resp.status).toBe(200);
    expect((await resp.json()).ok).toBe(true);
  });
});
