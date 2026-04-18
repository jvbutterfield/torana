import { logger } from "./log.js";
import type { GatewayDB } from "./db.js";
import type { Config, PersonaName } from "./config.js";
import type { TelegramClient } from "./telegram.js";
import type { Metrics } from "./metrics.js";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

const log = logger("server");

/** Constant-time string comparison to prevent timing attacks on secrets. */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type InboundHandler = (
  persona: PersonaName,
  updateId: number,
  chatId: number,
  messageId: number,
  fromUserId: string,
  text: string,
  attachmentPaths: string[],
  payloadJson: string,
) => void;

interface WorkerStatusInfo {
  worker: string;
  mailbox_depth: number;
  last_turn_at: string | null;
  error?: string;
}

export type HealthProvider = () => Record<PersonaName, WorkerStatusInfo>;

export function createServer(
  config: Config,
  db: GatewayDB,
  clients: Map<PersonaName, TelegramClient>,
  onInbound: InboundHandler,
  getHealth: HealthProvider,
  metrics?: Metrics,
) {
  const server = Bun.serve({
    port: config.port,
    hostname: "0.0.0.0",

    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        return handleHealth(req);
      }

      const webhookMatch = url.pathname.match(/^\/webhook\/(cato|harper|trader)$/);
      if (webhookMatch && req.method === "POST") {
        const persona = webhookMatch[1] as PersonaName;
        return await handleWebhook(req, persona);
      }

      // Reverse proxy: /dashboard/* → localhost:8000/*
      if (url.pathname.startsWith("/dashboard")) {
        return proxyToDashboard(req, url);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  function handleHealth(req: Request): Response {
    const personas = getHealth();
    const allOk = Object.values(personas).every(
      p => p.worker === "ready" || p.worker === "busy",
    );
    const httpStatus = allOk ? 200 : 503;

    // Authenticated callers (webhook secret as Bearer token) get full detail.
    // Unauthenticated callers get only the status code — enough for Railway
    // health checks without leaking operational metadata.
    const auth = req.headers.get("authorization");
    const authenticated = auth !== null
      && auth.startsWith("Bearer ")
      && safeCompare(auth.slice(7), config.webhookSecret);

    if (!authenticated) {
      return Response.json(
        { status: allOk ? "ok" : "degraded" },
        { status: httpStatus },
      );
    }

    return Response.json(
      {
        status: allOk ? "ok" : "degraded",
        personas,
        uptime_secs: Math.floor(process.uptime()),
      },
      { status: httpStatus },
    );
  }

  /** Reverse proxy to the admin dashboard backend on localhost:8000. */
  async function proxyToDashboard(req: Request, url: URL): Promise<Response> {
    // Strip /dashboard prefix — the backend expects paths like /api/health, not /dashboard/api/health
    const backendPath = url.pathname.replace(/^\/dashboard/, "") || "/";
    const backendUrl = `http://127.0.0.1:8000${backendPath}${url.search}`;
    try {
      const proxyReq = new Request(backendUrl, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      return await fetch(proxyReq);
    } catch (err) {
      log.warn("dashboard proxy failed", { error: String(err) });
      return new Response("Dashboard unavailable", { status: 502 });
    }
  }

  async function handleWebhook(req: Request, persona: PersonaName): Promise<Response> {
    // Validate webhook secret (constant-time comparison)
    const secret = req.headers.get("x-telegram-bot-api-secret-token");
    if (!secret || !safeCompare(secret, config.webhookSecret)) {
      log.warn("invalid webhook secret", { persona });
      return new Response("Forbidden", { status: 403 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const updateId = body.update_id;
    const message = body.message;

    if (!updateId || !message) {
      return new Response("OK", { status: 200 }); // non-message update, ignore
    }

    const chatId = message.chat?.id;
    const messageId = message.message_id;
    const fromUserId = String(message.from?.id ?? "");

    if (!chatId || !messageId || !fromUserId) {
      return new Response("OK", { status: 200 });
    }

    // Check allowed senders
    if (fromUserId !== config.allowedUserId) {
      log.warn("unauthorized sender", { persona, fromUserId });
      return new Response("Forbidden", { status: 403 });
    }

    metrics?.inc(persona, "inbound_received");

    // Dedup + store
    const payloadJson = JSON.stringify(body);
    const rowId = db.insertUpdate(persona, updateId, chatId, messageId, fromUserId, payloadJson);

    if (rowId === null) {
      metrics?.inc(persona, "inbound_deduped");
      log.debug("duplicate update ignored", { persona, updateId });
      return new Response("OK", { status: 200 });
    }

    // Return 200 immediately — async processing below
    // We trigger the async work after response
    const text = message.text || message.caption || "";

    const webhookReceivedAt = Date.now();

    // Schedule async work
    (async () => {
      // 1. React with 👀
      const client = clients.get(persona);
      if (client) {
        await client.setMessageReaction(chatId, messageId, "👀");
        metrics?.recordTimer(persona, "last_ack_latency_ms", Date.now() - webhookReceivedAt);
      }

      // 2. Download attachments if any
      const attachmentPaths: string[] = [];
      const photos = message.photo;
      const document = message.document;

      if (photos && photos.length > 0) {
        // Get highest resolution photo
        const photo = photos[photos.length - 1];
        const path = await downloadAttachment(persona, updateId, photo.file_id, "photo.jpg", client!);
        if (path) attachmentPaths.push(path);
      }

      if (document) {
        const fileName = document.file_name || "file";
        const path = await downloadAttachment(persona, updateId, document.file_id, fileName, client!);
        if (path) attachmentPaths.push(path);
      }

      // 3. Update status and hand off
      db.setUpdateStatus(rowId, "queued");
      onInbound(persona, rowId, chatId, messageId, fromUserId, text, attachmentPaths, payloadJson);
    })();

    return new Response("OK", { status: 200 });
  }

  async function downloadAttachment(
    persona: PersonaName,
    updateId: number,
    fileId: string,
    fileName: string,
    client: TelegramClient,
  ): Promise<string | null> {
    try {
      const fileInfo = await client.getFile(fileId);
      if (!fileInfo) return null;

      const data = await client.downloadFile(fileInfo.filePath);
      if (!data) return null;

      const dir = join(config.dataRoot, "gateway", "attachments", persona);
      mkdirSync(dir, { recursive: true });

      const localPath = join(dir, `${updateId}_${basename(fileName)}`);
      writeFileSync(localPath, new Uint8Array(data));

      log.info("attachment downloaded", { persona, path: localPath });
      return localPath;
    } catch (err) {
      log.error("attachment download failed", { persona, fileId, error: String(err) });
      return null;
    }
  }

  log.info("server started", { port: config.port });
  return server;
}
