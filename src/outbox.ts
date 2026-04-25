import { logger } from "./log.js";
import { nextBackoffMs } from "./backoff.js";
import type { BotId, Config } from "./config/schema.js";
import type { GatewayDB } from "./db/gateway-db.js";
import type { TelegramClient } from "./telegram/client.js";
import type { Metrics } from "./metrics.js";
import type { AlertManager } from "./alerts.js";
import { markdownToTelegramHtml } from "./format.js";

const log = logger("outbox");

type SendCallback = (telegramMessageId: number) => void;

/**
 * How long an `in_flight` outbox row stays excluded from re-pickup before
 * auto-recovering. Sized to comfortably exceed a normal Telegram POST
 * (sub-second under healthy conditions, a few seconds under retry +
 * Retry-After). A crashed row reappears for retry only after this grace
 * elapses, narrowing the window in which a fast restart could double-send.
 *
 * 60s also matches the outbox handleFailure backoff cap, so a hung-but-
 * not-crashed process can't accidentally race itself.
 */
const IN_FLIGHT_GRACE_SECS = 60;

export class OutboxProcessor {
  private config: Config;
  private db: GatewayDB;
  private clients: Map<BotId, TelegramClient>;
  private metrics: Metrics;
  private alerts: AlertManager | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sendCallbacks = new Map<number, SendCallback>();
  private processing = false;
  private inFlightGraceSecs: number;

  constructor(
    config: Config,
    db: GatewayDB,
    clients: Map<BotId, TelegramClient>,
    metrics: Metrics,
    alerts: AlertManager | null = null,
    opts: { inFlightGraceSecs?: number } = {},
  ) {
    this.config = config;
    this.db = db;
    this.clients = clients;
    this.metrics = metrics;
    this.alerts = alerts;
    this.inFlightGraceSecs = opts.inFlightGraceSecs ?? IN_FLIGHT_GRACE_SECS;
  }

  /**
   * Surface any outbox rows that a previous process left in `in_flight`
   * state — these were mid-Telegram-POST when the previous process died.
   * The grace window auto-retries them via getPendingOutbox; this just
   * makes them visible to the operator (a duplicate Telegram message is
   * possible if Telegram had already accepted the original send before
   * we crashed). Call after migrations, before start().
   */
  recoverInFlight(): void {
    const rows = this.db.getInFlightOutbox();
    if (rows.length === 0) return;
    for (const row of rows) {
      log.warn("crash-affected outbox row will auto-retry", {
        id: row.id,
        turn_id: row.turn_id,
        bot_id: row.bot_id,
        chat_id: row.chat_id,
        kind: row.kind,
        attempt_count: row.attempt_count,
        next_attempt_at: row.next_attempt_at,
        caveat:
          "Telegram may have already accepted the prior attempt; a duplicate is possible",
      });
    }
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
   * those are left for the next process start.
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

  queueSend(
    turnId: number,
    botId: BotId,
    chatId: number,
    text: string,
  ): number {
    return this.db.insertOutbox(
      turnId,
      botId,
      chatId,
      "send",
      JSON.stringify({ text }),
    );
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
    await client
      .editMessageText(chatId, messageId, text)
      .catch(() => undefined);
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

    // Mark as in_flight before the Telegram POST. If we crash between the
    // POST returning success and `markOutboxSent`, the row stays in
    // `in_flight` until the grace window expires — at which point it
    // auto-recovers via getPendingOutbox. The recoverInFlight() startup
    // pass makes the dup risk visible to operators.
    this.db.markOutboxInFlight(row.id, this.inFlightGraceSecs);

    try {
      if (row.kind === "send") {
        let result = await client.sendMessage(row.chat_id, formatted, "HTML");
        // Retry once in plain text if HTML parsing is the culprit.
        if (!result.ok && formatted !== payload.text) {
          result = await client.sendMessage(row.chat_id, payload.text);
        }
        if (result.ok) {
          this.db.markOutboxSent(row.id, result.messageId);
          const cb = this.sendCallbacks.get(row.id);
          if (cb) {
            this.sendCallbacks.delete(row.id);
            cb(result.messageId);
          }
        } else if (!result.retriable) {
          this.db.markOutboxFailed(row.id, result.description);
        } else {
          this.handleFailure(row, result.description);
        }
      } else if (row.kind === "edit") {
        if (!row.telegram_message_id) {
          this.db.markOutboxFailed(row.id, "edit without message_id");
          return;
        }
        let result = await client.editMessageText(
          row.chat_id,
          row.telegram_message_id,
          formatted,
          "HTML",
        );
        // HTML parse error → try plain text. notModified already means the
        // message content matches, so re-sending plain text wouldn't help.
        if (!result.ok && !result.notModified && formatted !== payload.text) {
          result = await client.editMessageText(
            row.chat_id,
            row.telegram_message_id,
            payload.text,
          );
        }
        if (result.ok || (!result.ok && result.notModified)) {
          // Treat "not modified" as success: the displayed message already
          // matches what we wanted to write.
          this.db.markOutboxSent(row.id);
        } else if (!result.retriable) {
          this.db.markOutboxFailed(row.id, result.description);
        } else {
          this.handleFailure(row, result.description);
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
    const backoff = nextBackoffMs(
      row.attempt_count,
      this.config.outbox.retry_base_ms,
      60_000,
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

    const nextAttemptCount = row.attempt_count + 1;
    const willDeadLetter = nextAttemptCount >= this.config.outbox.max_attempts;
    log.warn("outbox delivery failed", {
      id: row.id,
      attempt: nextAttemptCount,
      max_attempts: this.config.outbox.max_attempts,
      error,
    });

    this.db.markOutboxRetrying(
      row.id,
      error,
      nextAttempt,
      this.config.outbox.max_attempts,
    );

    if (willDeadLetter && row.bot_id && this.alerts) {
      void this.alerts.outboxFailures(row.bot_id, nextAttemptCount);
    }
  }
}
