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

describe("server/router", () => {
  test("exact routes win over path-param routes", async () => {
    server = createServer({ port: await getFreePort() });
    server.router.route(
      "GET",
      "/webhook/:botId",
      async () => new Response("param"),
    );
    server.router.route(
      "GET",
      "/webhook/special",
      async () => new Response("exact"),
    );

    const resp1 = await fetch(
      `http://127.0.0.1:${server.port}/webhook/special`,
    );
    expect(await resp1.text()).toBe("exact");
    const resp2 = await fetch(
      `http://127.0.0.1:${server.port}/webhook/anything`,
    );
    expect(await resp2.text()).toBe("param");
  });

  test("path params are decoded and passed to handler", async () => {
    server = createServer({ port: await getFreePort() });
    server.router.route("POST", "/webhook/:botId", async (_req, params) => {
      return new Response(params.botId ?? "");
    });
    const resp = await fetch(`http://127.0.0.1:${server.port}/webhook/alpha`, {
      method: "POST",
    });
    expect(await resp.text()).toBe("alpha");
  });

  test("fallback returns 404 JSON", async () => {
    server = createServer({ port: await getFreePort() });
    const resp = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(resp.status).toBe(404);
  });

  test("error handler catches thrown errors", async () => {
    server = createServer({ port: await getFreePort() });
    server.router.route("GET", "/boom", async () => {
      throw new Error("kaboom");
    });
    const resp = await fetch(`http://127.0.0.1:${server.port}/boom`);
    expect(resp.status).toBe(500);
  });

  test("double registration of exact route throws", async () => {
    server = createServer({ port: await getFreePort() });
    server.router.route("GET", "/x", async () => new Response("1"));
    expect(() =>
      server!.router.route("GET", "/x", async () => new Response("2")),
    ).toThrow();
  });
});
