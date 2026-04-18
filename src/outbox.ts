import { logger } from "./log.js";
import type { BotId, Config } from "./config/schema.js";
import type { GatewayDB } from "./db/gateway-db.js";
import type { TelegramClient } from "./telegram/client.js";
import type { Metrics } from "./metrics.js";
import { markdownToTelegramHtml } from "./format.js";

const log = logger("outbox");

type SendCallback = (telegramMessageId: number) => void;

export class OutboxProcessor {
  private config: Config;
  private db: GatewayDB;
  private clients: Map<BotId, TelegramClient>;
  private metrics: Metrics;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sendCallbacks = new Map<number, SendCallback>();
  private processing = false;

  constructor(
    config: Config,
    db: GatewayDB,
    clients: Map<BotId, TelegramClient>,
    metrics: Metrics,
  ) {
    this.config = config;
    this.db = db;
    this.clients = clients;
    this.metrics = metrics;
  }

  start(): void {
    this.timer = setInterval(() => void this.processPending(), 500);
    log.info("outbox processor started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sendCallbacks.clear();
  }

  /**
   * Best-effort flush of pending outbox rows before shutdown. Blocks until
   * either the pending queue is empty or `maxMs` elapses. Rows in 'retrying'
   * status with a future `next_attempt_at` are intentionally NOT rushed —
   * those are left for the next process start. See §3.12 of the plan.
   */
  async drain(maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const pending = this.db.getPendingOutbox();
      if (pending.length === 0) return;
      await this.processPending();
      if (Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    log.warn("drain deadline reached; leaving pending rows for next start", {
      pending: this.db.getPendingOutbox().length,
    });
  }

  queueSend(turnId: number, botId: BotId, chatId: number, text: string): number {
    return this.db.insertOutbox(turnId, botId, chatId, "send", JSON.stringify({ text }));
  }

  queueSendWithCallback(
    turnId: number,
    botId: BotId,
    chatId: number,
    text: string,
    onSent: SendCallback,
  ): number {
    const id = this.queueSend(turnId, botId, chatId, text);
    this.sendCallbacks.set(id, onSent);
    return id;
  }

  queueEdit(
    turnId: number,
    botId: BotId,
    chatId: number,
    messageId: number,
    text: string,
  ): number {
    return this.db.insertOutbox(
      turnId,
      botId,
      chatId,
      "edit",
      JSON.stringify({ text }),
      messageId,
    );
  }

  async fireAndForgetEdit(
    botId: BotId,
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void> {
    const client = this.clients.get(botId);
    if (!client) return;
    await client.editMessageText(chatId, messageId, text).catch(() => {});
  }

  private async processPending(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const rows = this.db.getPendingOutbox();
      for (const row of rows) {
        await this.processOne(row);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processOne(row: {
    id: number;
    turn_id: number;
    bot_id: BotId;
    chat_id: number;
    kind: string;
    telegram_message_id: number | null;
    payload_json: string;
    status: string;
    attempt_count: number;
  }): Promise<void> {
    const client = this.clients.get(row.bot_id);
    if (!client) {
      log.error("no client for bot", { bot_id: row.bot_id });
      this.db.markOutboxFailed(row.id, "no telegram client");
      return;
    }

    const payload = JSON.parse(row.payload_json) as { text: string };
    const formatted = markdownToTelegramHtml(payload.text);

    try {
      if (row.kind === "send") {
        let result = await client.sendMessage(row.chat_id, formatted, "HTML");
        if (!result && formatted !== payload.text) {
          result = await client.sendMessage(row.chat_id, payload.text);
        }
        if (result) {
          this.db.markOutboxSent(row.id, result.messageId);
          const cb = this.sendCallbacks.get(row.id);
          if (cb) {
            this.sendCallbacks.delete(row.id);
            cb(result.messageId);
          }
        } else {
          this.handleFailure(row, "sendMessage returned null");
        }
      } else if (row.kind === "edit") {
        if (!row.telegram_message_id) {
          this.db.markOutboxFailed(row.id, "edit without message_id");
          return;
        }
        let ok = await client.editMessageText(
          row.chat_id,
          row.telegram_message_id,
          formatted,
          "HTML",
        );
        if (!ok && formatted !== payload.text) {
          ok = await client.editMessageText(
            row.chat_id,
            row.telegram_message_id,
            payload.text,
          );
        }
        if (ok) {
          this.db.markOutboxSent(row.id);
        } else {
          this.handleFailure(row, "editMessageText failed");
        }
      }
    } catch (err) {
      this.handleFailure(row, err instanceof Error ? err.message : String(err));
    }
  }

  private handleFailure(
    row: { id: number; attempt_count: number; kind?: string; bot_id?: BotId },
    error: string,
  ): void {
    const backoff = Math.min(
      60_000,
      this.config.outbox.retry_base_ms * 2 ** row.attempt_count,
    );
    // Format must match SQLite's `datetime('now')` ("YYYY-MM-DD HH:MM:SS")
    // because the eligibility query does a lexicographic text comparison.
    // A plain ISO-8601 string ("...T...Z") sorts AFTER the space-separated
    // form, so same-day rows would never become eligible for retry.
    const nextAttempt = new Date(Date.now() + backoff)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");

    if (row.bot_id) {
      const counter =
        row.kind === "edit"
          ? ("telegram_edit_failures" as const)
          : ("telegram_send_failures" as const);
      this.metrics.inc(row.bot_id, counter);
    }

    log.warn("outbox delivery failed", {
      id: row.id,
      attempt: row.attempt_count + 1,
      max_attempts: this.config.outbox.max_attempts,
      error,
    });

    this.db.markOutboxRetrying(
      row.id,
      error,
      nextAttempt,
      this.config.outbox.max_attempts,
    );
  }
}
