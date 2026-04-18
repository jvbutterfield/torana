// WebhookTransport — registers POST /webhook/:botId on the shared HttpRouter
// and delivers inbound updates. Handles secret verification, setWebhook at
// startup, and the "stale webhook" warning when Telegram reports a URL we
// didn't register.

import { timingSafeEqual } from "node:crypto";
import { logger } from "../log.js";
import type { BotId, Config } from "../config/schema.js";
import type { TelegramClient } from "../telegram/client.js";
import type { GatewayDB } from "../db/gateway-db.js";
import type {
  HttpRouter,
  OnUpdateHandler,
  Transport,
  Unregister,
} from "./types.js";

const log = logger("transport.webhook");

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
}

export class WebhookTransport implements Transport {
  readonly kind = "webhook" as const;
  readonly botIds: readonly BotId[];

  private config: Config;
  private router: HttpRouter;
  private db: GatewayDB;
  private clients: Map<BotId, TelegramClient>;
  private unregister: Unregister | null = null;
  private secret: string;

  constructor(opts: WebhookTransportOptions) {
    this.config = opts.config;
    this.router = opts.router;
    this.db = opts.db;
    this.clients = opts.clients;
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

    for (const [botId, client] of this.clients) {
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
        await client.setWebhook(
          target,
          this.secret,
          this.config.transport.webhook?.allowed_updates ?? ["message"],
        );
      } catch (err) {
        log.error("setWebhook failed", {
          bot_id: botId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.db.setBotDisabled(
          botId,
          `setWebhook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
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

    let body: unknown;
    try {
      body = await req.json();
    } catch {
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
