// WebhookTransport — registers POST /webhook/:botId on the shared HttpRouter
// and delivers inbound updates. Handles secret verification, setWebhook at
// startup, and the "stale webhook" warning when Telegram reports a URL we
// didn't register.

import { timingSafeEqual } from "node:crypto";
import { logger } from "../log.js";
import type { BotId, Config } from "../config/schema.js";
import type { TelegramClient } from "../telegram/client.js";
import type { GatewayDB } from "../db/gateway-db.js";
import type { AlertManager } from "../alerts.js";
import type {
  HttpRouter,
  OnUpdateHandler,
  Transport,
  Unregister,
} from "./types.js";

const log = logger("transport.webhook");

/**
 * Hard cap on the size of an inbound Telegram webhook body. Telegram Update
 * payloads are small (a few KB for text, tens of KB for a Message with
 * entities); the Bot API documents no explicit maximum but 1 MiB is already
 * enormous for a single update. Without a cap, any caller who has obtained
 * the shared webhook secret (or guesses it against our 32-char minimum,
 * which is hard but not impossible in a long-lived deployment) can force the
 * gateway to buffer arbitrarily-large chunked bodies into memory.
 *
 * Keep this wider than the per-update wire budget so legitimate large
 * `message.text` with Markdown entities still fits; tighten if we ever see
 * real traffic exceeding a small fraction of it. 1 MiB is a middle ground.
 */
const WEBHOOK_MAX_BODY_BYTES = 1 * 1024 * 1024;

function safeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface WebhookTransportOptions {
  config: Config;
  router: HttpRouter;
  db: GatewayDB;
  /** Map of botId → TelegramClient for bots using webhook transport. */
  clients: Map<BotId, TelegramClient>;
  alerts?: AlertManager;
}

export class WebhookTransport implements Transport {
  readonly kind = "webhook" as const;
  readonly botIds: readonly BotId[];

  private config: Config;
  private router: HttpRouter;
  private db: GatewayDB;
  private clients: Map<BotId, TelegramClient>;
  private alerts: AlertManager | null;
  private unregister: Unregister | null = null;
  private secret: string;

  constructor(opts: WebhookTransportOptions) {
    this.config = opts.config;
    this.router = opts.router;
    this.db = opts.db;
    this.clients = opts.clients;
    this.alerts = opts.alerts ?? null;
    this.botIds = [...opts.clients.keys()];
    const secret = opts.config.transport.webhook?.secret;
    if (!secret) {
      throw new Error("webhook transport requires transport.webhook.secret");
    }
    this.secret = secret;
  }

  async start(onUpdate: OnUpdateHandler): Promise<void> {
    if (this.botIds.length === 0) return;
    const baseUrl = this.config.transport.webhook?.base_url;
    if (!baseUrl) {
      throw new Error("webhook transport requires transport.webhook.base_url");
    }

    this.unregister = this.router.route(
      "POST",
      "/webhook/:botId",
      async (req, params) => this.handle(req, params, onUpdate),
    );

    const allowedUpdates = this.config.transport.allowed_updates;
    const registerOne = async (
      botId: BotId,
      client: TelegramClient,
    ): Promise<void> => {
      const target = `${baseUrl.replace(/\/$/, "")}/webhook/${botId}`;
      try {
        const info = await client.getWebhookInfo();
        if (info.url && info.url !== target) {
          log.warn("existing webhook URL differs; overwriting", {
            bot_id: botId,
            existing: info.url,
            new: target,
          });
        }
        await client.setWebhook(target, this.secret, allowedUpdates);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.error("setWebhook failed", { bot_id: botId, error: reason });
        this.db.setBotDisabled(botId, `setWebhook failed: ${reason}`);
        if (this.alerts) void this.alerts.webhookSetFailed(botId, reason);
      }
    };

    await Promise.all(
      [...this.clients.entries()].map(([botId, client]) =>
        registerOne(botId, client),
      ),
    );
  }

  async stop(): Promise<void> {
    if (this.unregister) {
      this.unregister();
      this.unregister = null;
    }
  }

  private async handle(
    req: Request,
    params: Record<string, string>,
    onUpdate: OnUpdateHandler,
  ): Promise<Response> {
    const botId = params.botId;
    const botExists = !!botId && this.clients.has(botId);

    // Unknown bot id and invalid secret both return 200 with no body. An
    // unauthenticated requester can't tell them apart, so `/webhook/:botId`
    // can't be used to enumerate deployed bots. The warn log still fires
    // for an invalid secret against a real bot so operators see attack
    // traffic.
    const header = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    const secretOk = safeCompare(header, this.secret);
    if (!botExists || !secretOk) {
      if (botExists && !secretOk) {
        log.warn("invalid webhook secret", { bot_id: botId });
      }
      return new Response("OK", { status: 200 });
    }

    // Content-Length precheck before any allocation. Telegram normally
    // sends Content-Length; rejecting oversized declared bodies here
    // avoids touching req.body at all.
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (
      Number.isFinite(declared) &&
      declared > 0 &&
      declared > WEBHOOK_MAX_BODY_BYTES
    ) {
      log.warn("webhook body too large (content-length)", {
        bot_id: botId,
        declared,
        max: WEBHOOK_MAX_BODY_BYTES,
      });
      return new Response("Payload Too Large", { status: 413 });
    }

    let body: unknown;
    try {
      body = await readCappedJson(req, WEBHOOK_MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        log.warn("webhook body too large (streamed)", {
          bot_id: botId,
          bytes: err.bytes,
          max: WEBHOOK_MAX_BODY_BYTES,
        });
        return new Response("Payload Too Large", { status: 413 });
      }
      return new Response("Bad Request", { status: 400 });
    }

    // Deliver asynchronously; Telegram only cares about the 200.
    void (async () => {
      try {
        await onUpdate(botId, body as never);
      } catch (err) {
        log.error("update processing threw", {
          bot_id: botId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return new Response("OK", { status: 200 });
  }
}

class BodyTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`body exceeded ${bytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read req.body chunk-by-chunk, aborting as soon as accumulated bytes exceed
 * `maxBytes`, then JSON-parse. Throws `BodyTooLargeError` on overflow; throws
 * any other error (decode / parse) as a plain Error so the caller can map
 * it to 400 Bad Request.
 *
 * Webhook-specific; the Agent-API has its own version in src/agent-api/body.ts
 * with different error-result shape. Duplicating the ~20 lines keeps the
 * transport module standalone (no cross-module dep on agent-api internals).
 */
async function readCappedJson(req: Request, maxBytes: number): Promise<unknown> {
  const body = req.body;
  if (!body) return await req.json();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel("body_too_large");
        } catch {
          /* ignore — we're already aborting */
        }
        throw new BodyTooLargeError(total);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* reader may already be released */
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(merged);
  return JSON.parse(text);
}
