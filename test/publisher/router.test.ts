import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { ResolvedPublisherApiToken } from "../../src/config/load.js";
import type { GatewayDB } from "../../src/db/gateway-db.js";
import type { PublisherService } from "../../src/publisher/service.js";
import { registerPublisherRoutes } from "../../src/publisher/router.js";
import type {
  HttpMethod,
  HttpRouter,
  RouteHandler,
} from "../../src/transport/types.js";

const SECRET = "publisher-router-secret-000000000000000";
const KEY = "publisher-key-0000000001";

function harness() {
  const routes = new Map<string, RouteHandler>();
  const router: HttpRouter = {
    route(method: HttpMethod, path: string, handler: RouteHandler) {
      routes.set(`${method} ${path}`, handler);
      return () => routes.delete(`${method} ${path}`);
    },
    setFallback() {},
    setErrorHandler() {},
  };
  const token: ResolvedPublisherApiToken = {
    name: "notifier",
    secret: SECRET,
    hash: new Uint8Array(createHash("sha256").update(SECRET).digest()),
    publisher_ids: ["dev-team"],
    scopes: ["publish", "status"],
  };
  const service = {
    hasPublisher: (id: string) => id === "dev-team",
    publish: () => ({
      kind: "accepted" as const,
      publicationId: 11,
      outboxId: 22,
    }),
  } as unknown as PublisherService;
  const db = {
    getPublisherPublication: () => ({
      publicationId: 11,
      outboxId: 22,
      status: "sent",
      errorClass: null,
      createdAt: "2026-01-01 00:00:00",
      lastAttemptAt: null,
      sentAt: "2026-01-01 00:00:00",
    }),
  } as unknown as GatewayDB;
  registerPublisherRoutes(router, {
    tokens: [token],
    config: {
      enabled: true,
      max_body_bytes: 73_728,
      max_content_bytes: 65_536,
      idempotency_retention_ms: 1_209_600_000,
      max_pending_per_publisher: 500,
      max_retained_per_publisher: 2000,
      max_retained_bytes_per_publisher: 268_435_456,
      rate_per_minute_per_publisher: 60,
      burst_per_publisher: 10,
      tokens: [],
    },
    db,
    service,
  });
  return { routes };
}

function authHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    Authorization: `Bearer ${SECRET}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

describe("publisher routes", () => {
  test("authenticates, validates, and returns only durable identifiers", async () => {
    const { routes } = harness();
    const handler = routes.get("POST /v1/publishers/:publisher_id/messages")!;
    const response = await handler(
      new Request("http://localhost/v1/publishers/dev-team/messages", {
        method: "POST",
        headers: authHeaders({ "Idempotency-Key": KEY }),
        body: JSON.stringify({
          content: "complete",
          source: "worker-terminal",
          severity: "info",
        }),
      }),
      { publisher_id: "dev-team" },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      publication_id: 11,
      outbox_id: 22,
      status: "accepted",
      replayed: false,
    });
  });

  test("hides unauthorized publisher ids and rejects unknown/control fields", async () => {
    const { routes } = harness();
    const handler = routes.get("POST /v1/publishers/:publisher_id/messages")!;
    const hidden = await handler(
      new Request("http://localhost/v1/publishers/other/messages", {
        method: "POST",
        headers: authHeaders({ "Idempotency-Key": KEY }),
        body: "{}",
      }),
      { publisher_id: "other" },
    );
    expect(hidden.status).toBe(404);
    const injected = await handler(
      new Request("http://localhost/v1/publishers/dev-team/messages", {
        method: "POST",
        headers: authHeaders({ "Idempotency-Key": KEY }),
        body: JSON.stringify({
          content: "complete",
          source: "worker-terminal",
          severity: "info",
          channel_id: "attacker-controlled",
        }),
      }),
      { publisher_id: "dev-team" },
    );
    expect(injected.status).toBe(422);
  });

  test("status key is body-only and response excludes content and signed bytes", async () => {
    const { routes } = harness();
    const handler = routes.get(
      "POST /v1/publishers/:publisher_id/messages/status",
    )!;
    const response = await handler(
      new Request("http://localhost/v1/publishers/dev-team/messages/status", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ idempotency_key: KEY }),
      }),
      { publisher_id: "dev-team" },
    );
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("content");
    expect(text).not.toContain("signed");
  });
});
