import { logger } from "../log.js";
import type { BotId } from "../config/schema.js";
import type { TelegramUpdate, TelegramWebhookInfo } from "./types.js";

const log = logger("telegram");

export interface TelegramApiError {
  ok: false;
  error_code: number;
  description: string;
}

export interface TelegramApiOk<T> {
  ok: true;
  result: T;
}

export type TelegramApiResult<T> = TelegramApiOk<T> | TelegramApiError;

export class TelegramError extends Error {
  constructor(
    public readonly method: string,
    public readonly httpStatus: number,
    public readonly errorCode: number | undefined,
    public readonly description: string,
  ) {
    super(`${method} failed (${httpStatus}): ${description}`);
    this.name = "TelegramError";
  }

  /** True for HTTP errors we consider worth retrying (5xx, 429, network). */
  get isRetriable(): boolean {
    if (this.httpStatus === 0) return true; // network
    if (this.httpStatus === 429) return true;
    if (this.httpStatus >= 500) return true;
    return false;
  }

  get isAuth(): boolean {
    return this.httpStatus === 401;
  }
}

export interface TelegramClientOptions {
  botId: BotId;
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export type SendResult =
  | { ok: true; messageId: number }
  | { ok: false; retriable: boolean; description: string };

export type EditResult =
  | { ok: true }
  | {
      ok: false;
      retriable: boolean;
      notModified: boolean;
      description: string;
    };

/**
 * Thin HTTP client for the Telegram Bot API. `botId` is just a tag used in logs;
 * the client holds one token and is otherwise stateless.
 */
export class TelegramClient {
  readonly botId: BotId;
  private token: string;
  private apiBaseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(opts: TelegramClientOptions) {
    this.botId = opts.botId;
    this.token = opts.token;
    this.apiBaseUrl = (opts.apiBaseUrl ?? "https://api.telegram.org").replace(
      /\/$/,
      "",
    );
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async api<T>(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.apiBaseUrl}/bot${this.token}/${method}`;
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new TelegramError(method, 0, undefined, String(err));
    }
    let data: TelegramApiResult<T>;
    try {
      data = (await resp.json()) as TelegramApiResult<T>;
    } catch (err) {
      throw new TelegramError(
        method,
        resp.status,
        undefined,
        `non-JSON response: ${String(err)}`,
      );
    }
    if (!data.ok) {
      throw new TelegramError(
        method,
        resp.status,
        data.error_code,
        data.description,
      );
    }
    return data.result;
  }

  // --- Webhook lifecycle ---

  async getMe(): Promise<{ id: number; username?: string }> {
    return await this.api<{ id: number; username?: string }>("getMe");
  }

  async getWebhookInfo(): Promise<TelegramWebhookInfo> {
    return await this.api<TelegramWebhookInfo>("getWebhookInfo");
  }

  async setWebhook(
    webhookUrl: string,
    secret: string,
    allowedUpdates: string[],
  ): Promise<boolean> {
    log.info("setting webhook", { bot_id: this.botId, url: webhookUrl });
    try {
      await this.api<boolean>("setWebhook", {
        url: webhookUrl,
        secret_token: secret,
        allowed_updates: allowedUpdates,
        drop_pending_updates: false,
      });
      log.info("webhook set", { bot_id: this.botId });
      return true;
    } catch (err) {
      log.warn("setWebhook failed", {
        bot_id: this.botId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async deleteWebhook(dropPendingUpdates = false): Promise<boolean> {
    try {
      return await this.api<boolean>("deleteWebhook", {
        drop_pending_updates: dropPendingUpdates,
      });
    } catch (err) {
      log.debug("deleteWebhook failed", {
        bot_id: this.botId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // --- Messaging ---

  async sendMessage(
    chatId: number,
    text: string,
    parseMode?: string,
  ): Promise<SendResult> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;
    try {
      const result = await this.api<{ message_id: number }>(
        "sendMessage",
        body,
      );
      return { ok: true, messageId: result.message_id };
    } catch (err) {
      const retriable = err instanceof TelegramError ? err.isRetriable : true;
      const description = err instanceof Error ? err.message : String(err);
      log.warn("sendMessage failed", {
        bot_id: this.botId,
        chat_id: chatId,
        error: description,
      });
      return { ok: false, retriable, description };
    }
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    parseMode?: string,
  ): Promise<EditResult> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (parseMode) body.parse_mode = parseMode;
    try {
      await this.api<unknown>("editMessageText", body);
      return { ok: true };
    } catch (err) {
      const description = err instanceof Error ? err.message : String(err);
      // Telegram returns 400 "message is not modified" when the edit payload
      // matches the current message exactly. Common in streaming because the
      // fire-and-forget flush may have already pushed the full buffer before
      // finalizeTurn queues the terminal edit. Treat as success.
      const notModified = /message is not modified/i.test(description);
      const retriable =
        !notModified && (err instanceof TelegramError ? err.isRetriable : true);
      log.debug("editMessageText failed", {
        bot_id: this.botId,
        not_modified: notModified,
        error: description,
      });
      return { ok: false, retriable, notModified, description };
    }
  }

  async setMessageReaction(
    chatId: number,
    messageId: number,
    emoji: string,
  ): Promise<boolean> {
    try {
      await this.api<boolean>("setMessageReaction", {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
      });
      return true;
    } catch {
      return false;
    }
  }

  async sendChatAction(chatId: number, action = "typing"): Promise<boolean> {
    try {
      await this.api<boolean>("sendChatAction", { chat_id: chatId, action });
      return true;
    } catch {
      return false;
    }
  }

  // --- Polling ---

  async getUpdates(opts: {
    offset?: number;
    timeoutSecs: number;
    limit: number;
    allowedUpdates?: string[];
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]> {
    const url = `${this.apiBaseUrl}/bot${this.token}/getUpdates`;
    const body: Record<string, unknown> = {
      timeout: opts.timeoutSecs,
      limit: opts.limit,
    };
    if (opts.offset !== undefined) body.offset = opts.offset;
    if (opts.allowedUpdates) body.allowed_updates = opts.allowedUpdates;

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      throw new TelegramError("getUpdates", 0, undefined, String(err));
    }
    const data = (await resp.json()) as TelegramApiResult<TelegramUpdate[]>;
    if (!data.ok) {
      throw new TelegramError(
        "getUpdates",
        resp.status,
        data.error_code,
        data.description,
      );
    }
    return data.result;
  }

  // --- Attachments ---

  async getFile(
    fileId: string,
  ): Promise<{ file_path: string; file_size?: number } | null> {
    try {
      const result = await this.api<{ file_path: string; file_size?: number }>(
        "getFile",
        { file_id: fileId },
      );
      return result;
    } catch (err) {
      log.warn("getFile failed", {
        bot_id: this.botId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async downloadFile(filePath: string): Promise<ArrayBuffer | null> {
    const url = `${this.apiBaseUrl}/file/bot${this.token}/${filePath}`;
    try {
      const resp = await this.fetchImpl(url);
      if (!resp.ok) {
        log.warn("file download failed", {
          bot_id: this.botId,
          status: resp.status,
        });
        return null;
      }
      return await resp.arrayBuffer();
    } catch (err) {
      log.error("file download error", {
        bot_id: this.botId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
