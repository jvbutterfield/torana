import type { HttpRouter, Unregister } from "../transport/types.js";
import type { ResolvedPublisherApiToken } from "../config/load.js";
import type { GatewayDB } from "../db/gateway-db.js";
import type { PublisherApiConfig } from "../config/v2.js";
import { authenticatePublisher } from "./auth.js";
import {
  IDEMPOTENCY_KEY,
  PublishBodySchema,
  PublisherStatusBodySchema,
} from "./schemas.js";
import { PublisherService } from "./service.js";
import type { Metrics, PublisherOutcome } from "../metrics.js";

export interface PublisherRouterDeps {
  tokens: readonly ResolvedPublisherApiToken[];
  config: PublisherApiConfig;
  db: GatewayDB;
  service: PublisherService;
  metrics?: Metrics;
}

export function registerPublisherRoutes(
  router: HttpRouter,
  deps: PublisherRouterDeps,
): Unregister[] {
  return [
    router.route(
      "POST",
      "/v1/publishers/:publisher_id/messages",
      (req, params) => handlePublish(req, params.publisher_id!, deps),
    ),
    router.route(
      "POST",
      "/v1/publishers/:publisher_id/messages/status",
      (req, params) => handleStatus(req, params.publisher_id!, deps),
    ),
  ];
}

async function handlePublish(
  req: Request,
  publisherId: string,
  deps: PublisherRouterDeps,
): Promise<Response> {
  const startedAt = Date.now();
  let outcome: PublisherOutcome = "rejected";
  const record = () =>
    deps.metrics?.recordPublisherRequest(
      publisherId,
      outcome,
      Date.now() - startedAt,
    );
  const auth = authorize(req, publisherId, "publish", deps);
  if (auth) {
    record();
    return auth;
  }
  const key = req.headers.get("Idempotency-Key");
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    record();
    return error(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must be 16–128 chars of [A-Za-z0-9_-]",
    );
  }
  const read = await readBoundedJson(req, deps.config.max_body_bytes);
  if (read.kind === "error") {
    record();
    return read.response;
  }
  const parsed = PublishBodySchema.safeParse(read.value);
  if (!parsed.success) {
    record();
    return error(
      422,
      "invalid_body",
      parsed.error.issues[0]?.message ?? "invalid body",
    );
  }
  if (
    Buffer.byteLength(parsed.data.content, "utf8") >
    deps.config.max_content_bytes
  ) {
    record();
    return error(
      413,
      "content_too_large",
      "content exceeds configured byte limit",
    );
  }
  try {
    const result = deps.service.publish(publisherId, key, parsed.data);
    if (result.kind === "accepted" || result.kind === "replay") {
      outcome = result.kind === "accepted" ? "accepted" : "replayed";
      record();
      return json(202, {
        publication_id: result.publicationId,
        outbox_id: result.outboxId,
        status: "accepted",
        replayed: result.kind === "replay",
      });
    }
    if (result.kind === "conflict") {
      outcome = "conflict";
      record();
      return error(
        409,
        "idempotency_conflict",
        "key was already used with different content",
      );
    }
    if (result.reason === "publisher_rate_limited") {
      outcome = "rate_limited";
      record();
      return error(429, result.reason, "publisher request rate exceeded", {
        retriable: true,
      });
    }
    if (result.reason === "database_storage_full") {
      record();
      return error(507, result.reason, "database logical size cap reached", {
        retriable: false,
      });
    }
    record();
    return error(503, result.reason, "publisher is temporarily unavailable", {
      retriable: true,
    });
  } catch (cause) {
    outcome = "failed";
    record();
    const message = cause instanceof Error ? cause.message.toLowerCase() : "";
    if (message.includes("busy") || message.includes("locked")) {
      return error(503, "database_busy", "database is busy", {
        retriable: true,
      });
    }
    return error(500, "internal_error", "internal error");
  }
}

async function handleStatus(
  req: Request,
  publisherId: string,
  deps: PublisherRouterDeps,
): Promise<Response> {
  const auth = authorize(req, publisherId, "status", deps);
  if (auth) return auth;
  const read = await readBoundedJson(
    req,
    Math.min(deps.config.max_body_bytes, 16_384),
  );
  if (read.kind === "error") return read.response;
  const parsed = PublisherStatusBodySchema.safeParse(read.value);
  if (!parsed.success) return error(422, "invalid_body", "invalid status body");
  const row = deps.db.getPublisherPublication(
    publisherId,
    parsed.data.idempotency_key,
  );
  if (!row) return error(404, "publication_not_found", "publication not found");
  return json(200, {
    publication_id: row.publicationId,
    outbox_id: row.outboxId,
    status: row.status,
    error_class: row.errorClass,
    created_at: row.createdAt,
    last_attempt_at: row.lastAttemptAt,
    sent_at: row.sentAt,
  });
}

function authorize(
  req: Request,
  publisherId: string,
  scope: "publish" | "status",
  deps: PublisherRouterDeps,
): Response | null {
  const auth = authenticatePublisher(
    deps.tokens,
    req.headers.get("Authorization"),
  );
  if ("error" in auth)
    return error(401, auth.error, "publisher bearer not recognized");
  if (!auth.token.scopes.includes(scope)) {
    return error(
      403,
      "scope_not_permitted",
      "required publisher scope is absent",
    );
  }
  if (
    !deps.service.hasPublisher(publisherId) ||
    !auth.token.publisher_ids.includes(publisherId)
  ) {
    return error(404, "publisher_not_found", "publisher not found");
  }
  return null;
}

async function readBoundedJson(
  req: Request,
  maxBytes: number,
): Promise<
  { kind: "ok"; value: unknown } | { kind: "error"; response: Response }
> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return {
      kind: "error",
      response: error(
        413,
        "body_too_large",
        "request body exceeds configured byte limit",
      ),
    };
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const bytes = await Promise.race([
      req.arrayBuffer().then((value) => new Uint8Array(value)),
      new Promise<never>((_, reject) => {
        // Reserve three seconds for SQLite's bounded busy wait and signing;
        // this keeps the entire synchronous handler below its four-second
        // reconciliation contract on the loopback deployment path.
        timer = setTimeout(() => reject(new Error("body_deadline")), 750);
      }),
    ]);
    if (bytes.byteLength > maxBytes) {
      return {
        kind: "error",
        response: error(
          413,
          "body_too_large",
          "request body exceeds configured byte limit",
        ),
      };
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        kind: "error",
        response: error(422, "invalid_utf8", "body must be valid UTF-8"),
      };
    }
    try {
      return { kind: "ok", value: JSON.parse(text) };
    } catch {
      return {
        kind: "error",
        response: error(422, "invalid_json", "body must be valid JSON"),
      };
    }
  } catch (cause) {
    return {
      kind: "error",
      response: error(
        408,
        cause instanceof Error && cause.message === "body_deadline"
          ? "request_timeout"
          : "invalid_body",
        "request body was not received within the deadline",
      ),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function error(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return json(status, { error: code, message, ...extra });
}
