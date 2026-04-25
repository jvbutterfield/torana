// A minimal in-memory Telegram Bot API fake, served via Bun.serve on a random
// port. Exposes enough surface for torana to run end-to-end: webhook
// registration, polling, messaging, reactions, attachments.
//
// Per §5 of the plan: the real integration test harness.

import type { TelegramUpdate } from "../../src/telegram/types.js";

type BunServer = ReturnType<typeof Bun.serve>;

export interface FakeTelegramOptions {
  /** Map of bot token → botId. Required so the fake can route incoming calls. */
  bots: Record<string, string>;
  /** Shortened long-poll delay for fast tests. Default 100 ms. */
  emptyPollDelayMs?: number;
}

export interface FakeTelegramCall {
  botId: string;
  method: string;
  body: Record<string, unknown>;
}

interface RegisteredWebhook {
  url: string;
  secret: string;
}

interface RegisteredFile {
  path: string;
  bytes: Uint8Array;
  mimeType?: string;
}

export class FakeTelegram {
  public readonly calls: FakeTelegramCall[] = [];

  private server: BunServer | null = null;
  private baseUrl = "";
  private webhooks = new Map<string, RegisteredWebhook>();
  private polling = new Map<string, TelegramUpdate[]>();
  private files = new Map<string, RegisteredFile>();
  private nextMessageId = 1000;
  private opts: FakeTelegramOptions;

  constructor(opts: FakeTelegramOptions) {
    this.opts = opts;
    for (const botId of Object.values(opts.bots)) {
      this.polling.set(botId, []);
    }
  }

  async start(): Promise<string> {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => this.handle(req),
    });
    this.baseUrl = `http://127.0.0.1:${this.server.port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    this.server?.stop(true);
    this.server = null;
  }

  /** The `telegram.api_base_url` callers should feed into their config. */
  get apiBaseUrl(): string {
    return this.baseUrl;
  }

  /** Simulate Telegram POSTing an update to the gateway's webhook URL. */
  async deliverWebhookUpdate(
    botId: string,
    update: TelegramUpdate,
  ): Promise<Response> {
    const info = this.webhooks.get(botId);
    if (!info) {
      throw new Error(`no webhook registered for bot '${botId}'`);
    }
    return await fetch(info.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": info.secret,
      },
      body: JSON.stringify(update),
    });
  }

  /** Queue an update the gateway will pick up on its next getUpdates. */
  queuePollingUpdate(botId: string, update: TelegramUpdate): void {
    const queue = this.polling.get(botId);
    if (!queue) {
      throw new Error(`bot '${botId}' not registered with fake Telegram`);
    }
    queue.push(update);
  }

  /** Make a file available to getFile + downloadFile. */
  registerFile(
    fileId: string,
    bytes: Uint8Array,
    mimeType?: string,
  ): { file_path: string } {
    const filePath = `files/${fileId}.bin`;
    this.files.set(fileId, { path: filePath, bytes, mimeType });
    return { file_path: filePath };
  }

  /** Filter recorded calls. */
  callsFor(botId: string, method?: string): FakeTelegramCall[] {
    return this.calls.filter(
      (c) => c.botId === botId && (!method || c.method === method),
    );
  }

  /** Wait until `predicate` returns true or the timeout elapses. */
  async waitFor(
    predicate: () => boolean,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<void> {
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    const poll = opts.pollMs ?? 25;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, poll));
    }
    throw new Error("waitFor: timed out");
  }

  // --- internals ---

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // /bot<TOKEN>/<method>
    const apiMatch = url.pathname.match(/^\/bot([^/]+)\/(.+)$/);
    if (apiMatch) {
      const token = apiMatch[1];
      const method = apiMatch[2];
      const botId = this.opts.bots[token];
      if (!botId) {
        return Response.json(
          { ok: false, error_code: 401, description: "unknown token" },
          { status: 401 },
        );
      }
      let body: Record<string, unknown> = {};
      if (req.method === "POST") {
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          body = {};
        }
      }
      this.calls.push({ botId, method, body });
      return await this.handleMethod(botId, method, body);
    }

    // /file/bot<TOKEN>/<file_path>
    const fileMatch = url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (fileMatch) {
      const filePath = fileMatch[2];
      const entry = [...this.files.values()].find((f) => f.path === filePath);
      if (!entry) return new Response("not found", { status: 404 });
      return new Response(entry.bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": entry.mimeType ?? "application/octet-stream",
        },
      });
    }

    return new Response("not found", { status: 404 });
  }

  private async handleMethod(
    botId: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    switch (method) {
      case "getMe":
        return Response.json({
          ok: true,
          result: {
            id: 1000,
            is_bot: true,
            first_name: botId,
            username: `${botId}_bot`,
          },
        });
      case "setWebhook": {
        const webhookUrl = String(body.url);
        const secret = String(body.secret_token ?? "");
        this.webhooks.set(botId, { url: webhookUrl, secret });
        return Response.json({ ok: true, result: true });
      }
      case "deleteWebhook":
        this.webhooks.delete(botId);
        return Response.json({ ok: true, result: true });
      case "getWebhookInfo": {
        const info = this.webhooks.get(botId);
        return Response.json({
          ok: true,
          result: {
            url: info?.url ?? "",
            has_custom_certificate: false,
            pending_update_count: 0,
          },
        });
      }
      case "getUpdates": {
        const queue = this.polling.get(botId) ?? [];
        const offset = typeof body.offset === "number" ? body.offset : 0;
        const limit = typeof body.limit === "number" ? body.limit : 100;
        const available = queue.filter((u) => u.update_id >= offset);
        if (available.length === 0) {
          await new Promise((r) =>
            setTimeout(r, this.opts.emptyPollDelayMs ?? 100),
          );
          return Response.json({ ok: true, result: [] });
        }
        return Response.json({ ok: true, result: available.slice(0, limit) });
      }
      case "sendMessage": {
        const chatId = body.chat_id as number;
        const text = body.text as string;
        this.nextMessageId += 1;
        return Response.json({
          ok: true,
          result: {
            message_id: this.nextMessageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: "private" },
            text,
          },
        });
      }
      case "editMessageText":
        return Response.json({ ok: true, result: true });
      case "setMessageReaction":
        return Response.json({ ok: true, result: true });
      case "sendChatAction":
        return Response.json({ ok: true, result: true });
      case "getFile": {
        const fileId = String(body.file_id);
        const entry = this.files.get(fileId);
        if (!entry) {
          return Response.json(
            { ok: false, error_code: 400, description: "file not found" },
            { status: 400 },
          );
        }
        return Response.json({
          ok: true,
          result: {
            file_id: fileId,
            file_path: entry.path,
            file_size: entry.bytes.length,
          },
        });
      }
      default:
        return Response.json({
          ok: false,
          error_code: 400,
          description: `unknown method: ${method}`,
        });
    }
  }
}

/** Find a free port by letting Bun pick one, then shutting down. */
export async function findFreePort(): Promise<number> {
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("x"),
  });
  const port = typeof s.port === "number" ? s.port : 3000;
  s.stop(true);
  return port;
}
