import { logger } from "./log.js";
import { nextBackoffMs } from "./backoff.js";
import type { BotId, Config } from "./config/schema.js";
import type { GatewayDB } from "./db/gateway-db.js";
import type { TelegramClient, EditResult } from "./telegram/client.js";
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
  /**
   * Per-bot reentrancy guard. Replaces the previous global `processing`
   * mutex so a 429 / slow Telegram response on bot A's queue cannot
   * head-of-line block bot B's queue. Within a single bot the queue is
   * still serial (preserves message ordering inside a chat).
   */
  private processingBots = new Set<BotId>();
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

  /**
   * Best-effort streaming edit. Returns the EditResult so callers can
   * observe 429 / Retry-After signals (the streaming path uses this to
   * pause its flush cadence — see StreamManager.flush). On exceptions or
   * missing client, returns a synthesised retriable failure rather than
   * throwing, preserving the historical "fire and forget" contract for
   * non-rate-limit-aware callers.
   */
  async fireAndForgetEdit(
    botId: BotId,
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<EditResult> {
    const client = this.clients.get(botId);
    if (!client) {
      return {
        ok: false,
        retriable: false,
        notModified: false,
        description: "no telegram client",
      };
    }
    try {
      return await client.editMessageText(chatId, messageId, text);
    } catch (err) {
      return {
        ok: false,
        retriable: true,
        notModified: false,
        description: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async processPending(): Promise<void> {
    const rows = this.db.getPendingOutbox();
    if (rows.length === 0) return;

    // Group by bot_id. Each bot's queue is processed serially (preserves
    // intra-chat ordering) but bots run concurrently, so a 429 on bot A
    // doesn't head-of-line block bot B. Per-bot reentrancy is guarded
    // via processingBots so a slow bot can't be picked up twice if the
    // 500ms timer fires while it's still draining.
    const byBot = new Map<BotId, typeof rows>();
    for (const row of rows) {
      const list = byBot.get(row.bot_id);
      if (list) list.push(row);
      else byBot.set(row.bot_id, [row]);
    }

    await Promise.all(
      [...byBot.entries()].map(async ([botId, botRows]) => {
        if (this.processingBots.has(botId)) return;
        this.processingBots.add(botId);
        try {
          for (const row of botRows) {
            await this.processOne(row);
          }
        } finally {
          this.processingBots.delete(botId);
        }
      }),
    );
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
          this.handleFailure(row, result.description, result.retryAfterMs);
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
          this.handleFailure(row, result.description, result.retryAfterMs);
        }
      }
    } catch (err) {
      this.handleFailure(row, err instanceof Error ? err.message : String(err));
    }
  }

  private handleFailure(
    row: { id: number; attempt_count: number; kind?: string; bot_id?: BotId },
    error: string,
    retryAfterMs?: number,
  ): void {
    if (row.bot_id) {
      const counter =
        row.kind === "edit"
          ? ("telegram_edit_failures" as const)
          : ("telegram_send_failures" as const);
      this.metrics.inc(row.bot_id, counter);
    }

    // Retry-After waits don't count against attempt_count. Otherwise a
    // cooperative attacker who keeps a chat throttled for longer than
    // (max_attempts × backoff_cap) would dead-letter legitimate replies
    // and trigger an operator alert that wasn't actually torana's fault.
    // Cap the cooldown at 5 minutes — Telegram's documented per-chat
    // limits don't exceed this, but we belt-and-braces to bound a
    // potentially-malicious server response.
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      const cappedMs = Math.min(retryAfterMs, 5 * 60_000);
      const nextAttempt = new Date(Date.now() + cappedMs)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");
      log.warn("outbox delivery throttled by Telegram; honoring Retry-After", {
        id: row.id,
        attempt: row.attempt_count,
        retry_after_ms: retryAfterMs,
        next_attempt_at: nextAttempt,
        error,
      });
      this.db.markOutboxRateLimited(row.id, error, nextAttempt);
      return;
    }

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
