import { logger } from "../log.js";
import type { BotId } from "../config/schema.js";
import type { TelegramUpdate, TelegramWebhookInfo } from "./types.js";

const log = logger("telegram");

export interface TelegramApiError {
  ok: false;
  error_code: number;
  description: string;
  /**
   * Telegram returns this on 429 alongside the HTTP `Retry-After` header,
   * giving the cooldown in seconds. We surface whichever is present (header
   * preferred when both are set) on `TelegramError.retryAfterMs`.
   */
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export interface TelegramApiOk<T> {
  ok: true;
  result: T;
}

export type TelegramApiResult<T> = TelegramApiOk<T> | TelegramApiError;

export class TelegramError extends Error {
  /**
   * Cooldown the server asked us to honor before retrying, in milliseconds.
   * Populated from HTTP `Retry-After` (seconds) or, as a fallback, from the
   * Telegram error envelope's `parameters.retry_after`. Set only on 429
   * (and on 5xx if Telegram included a `Retry-After`); otherwise undefined.
   *
   * Callers (outbox, polling) should sleep at least this long before
   * retrying. Hammering Telegram during its declared cooldown extends the
   * throttle and amplifies the self-DoS surface.
   */
  public readonly retryAfterMs: number | undefined;

  constructor(
    public readonly method: string,
    public readonly httpStatus: number,
    public readonly errorCode: number | undefined,
    public readonly description: string,
    retryAfterMs?: number,
  ) {
    super(`${method} failed (${httpStatus}): ${description}`);
    this.name = "TelegramError";
    this.retryAfterMs = retryAfterMs;
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

/**
 * Hard cap on a single Telegram API request. Telegram normally responds in
 * sub-second time; 30s comfortably covers tail latency without letting a
 * stuck TCP connection wedge the dispatcher (which is the failure mode F4
 * from the rc.7 review). `getUpdates` overrides via its own long-poll
 * window — see GET_UPDATES_TIMEOUT_BUFFER_MS.
 */
const DEFAULT_API_TIMEOUT_MS = 30_000;

/**
 * Padding on top of the long-poll `timeout` parameter for getUpdates. Bun's
 * fetch() needs to see the body finish; we give Telegram an extra 5s
 * beyond its declared long-poll deadline before aborting.
 */
const GET_UPDATES_TIMEOUT_BUFFER_MS = 5_000;

/**
 * Parse a Telegram cooldown signal into milliseconds. Looks first at the
 * HTTP `Retry-After` header (seconds, per RFC 9110), then falls back to
 * the JSON envelope's `parameters.retry_after`. Returns undefined when
 * neither is present or both are non-numeric.
 *
 * Negative or zero values are treated as missing — Telegram occasionally
 * returns `retry_after: 0` on flaky 5xx, which would otherwise have us
 * skip the natural backoff entirely.
 */
function parseRetryAfter(
  resp: Response | null,
  envelope: { parameters?: { retry_after?: number } } | null,
): number | undefined {
  const headerSecs = Number(resp?.headers.get("retry-after"));
  if (Number.isFinite(headerSecs) && headerSecs > 0) {
    return Math.round(headerSecs * 1000);
  }
  const envelopeSecs = envelope?.parameters?.retry_after;
  if (
    typeof envelopeSecs === "number" &&
    Number.isFinite(envelopeSecs) &&
    envelopeSecs > 0
  ) {
    return Math.round(envelopeSecs * 1000);
  }
  return undefined;
}

export interface TelegramClientOptions {
  botId: BotId;
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export type SendResult =
  | { ok: true; messageId: number }
  | {
      ok: false;
      retriable: boolean;
      description: string;
      /** Server-asked cooldown in ms, surfaced from 429 responses. */
      retryAfterMs?: number;
    };

export type EditResult =
  | { ok: true }
  | {
      ok: false;
      retriable: boolean;
      notModified: boolean;
      description: string;
      /** Server-asked cooldown in ms, surfaced from 429 responses. */
      retryAfterMs?: number;
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
        // Bound a single request so a stuck TCP connection cannot wedge
        // the dispatcher. Network errors (including timeouts) surface as
        // httpStatus=0 + isRetriable=true.
        signal: AbortSignal.timeout(DEFAULT_API_TIMEOUT_MS),
      });
    } catch (err) {
      throw new TelegramError(method, 0, undefined, String(err));
    }
    let data: TelegramApiResult<T>;
    try {
      data = (await resp.json()) as TelegramApiResult<T>;
    } catch (err) {
      // Non-JSON path: still surface a Retry-After if Telegram set one
      // (e.g. on a CDN-side 429 page).
      throw new TelegramError(
        method,
        resp.status,
        undefined,
        `non-JSON response: ${String(err)}`,
        parseRetryAfter(resp, null),
      );
    }
    if (!data.ok) {
      throw new TelegramError(
        method,
        resp.status,
        data.error_code,
        data.description,
        parseRetryAfter(resp, data),
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
      const retryAfterMs =
        err instanceof TelegramError ? err.retryAfterMs : undefined;
      const description = err instanceof Error ? err.message : String(err);
      log.warn("sendMessage failed", {
        bot_id: this.botId,
        chat_id: chatId,
        error: description,
        retry_after_ms: retryAfterMs,
      });
      return { ok: false, retriable, description, retryAfterMs };
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
      const retryAfterMs =
        err instanceof TelegramError ? err.retryAfterMs : undefined;
      log.debug("editMessageText failed", {
        bot_id: this.botId,
        not_modified: notModified,
        error: description,
        retry_after_ms: retryAfterMs,
      });
      return { ok: false, retriable, notModified, description, retryAfterMs };
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

    // Combine the caller's shutdown signal with a watchdog that fires
    // after the long-poll deadline + a small buffer. AbortSignal.any
    // honors whichever fires first.
    const watchdog = AbortSignal.timeout(
      opts.timeoutSecs * 1000 + GET_UPDATES_TIMEOUT_BUFFER_MS,
    );
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, watchdog])
      : watchdog;

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
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
        parseRetryAfter(resp, data),
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
