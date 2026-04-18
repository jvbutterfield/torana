import { logger } from "./log.js";
import type { GatewayDB } from "./db.js";
import type { Config, PersonaName } from "./config.js";
import { TelegramClient } from "./telegram.js";
import type { Metrics } from "./metrics.js";
import { markdownToTelegramHtml } from "./format.js";

const log = logger("outbox");

type SendCallback = (telegramMessageId: number) => void;

export class OutboxProcessor {
  private config: Config;
  private db: GatewayDB;
  private clients: Map<PersonaName, TelegramClient>;
  private metrics: Metrics;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sendCallbacks = new Map<number, SendCallback>();
  private processing = false;

  constructor(config: Config, db: GatewayDB, clients: Map<PersonaName, TelegramClient>, metrics: Metrics) {
    this.config = config;
    this.db = db;
    this.clients = clients;
    this.metrics = metrics;
  }

  start() {
    this.timer = setInterval(() => this.processPending(), 500);
    log.info("outbox processor started");
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.sendCallbacks.clear();
  }

  queueSend(turnId: number, persona: PersonaName, chatId: number, text: string): number {
    return this.db.insertOutbox(turnId, persona, chatId, "send", JSON.stringify({ text }));
  }

  /** Queue a send and get a callback when the Telegram message ID is known. */
  queueSendWithCallback(turnId: number, persona: PersonaName, chatId: number, text: string, onSent: SendCallback): number {
    const id = this.queueSend(turnId, persona, chatId, text);
    this.sendCallbacks.set(id, onSent);
    return id;
  }

  queueEdit(turnId: number, persona: PersonaName, chatId: number, messageId: number, text: string): number {
    return this.db.insertOutbox(turnId, persona, chatId, "edit", JSON.stringify({ text }), messageId);
  }

  async fireAndForgetEdit(persona: PersonaName, chatId: number, messageId: number, text: string) {
    const client = this.clients.get(persona);
    if (!client) return;
    try {
      await client.editMessageText(chatId, messageId, text);
    } catch (err) {
      log.debug("streaming edit failed (non-critical)", { persona, error: String(err) });
    }
  }

  private async processPending() {
    // Guard against re-entrant calls: if a previous tick is still awaiting a
    // Telegram API response, skip this tick rather than processing the same
    // row twice and sending duplicate messages.
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
    id: number; turn_id: number; persona: PersonaName; chat_id: number;
    kind: string; telegram_message_id: number | null; payload_json: string;
    status: string; attempt_count: number;
  }) {
    const client = this.clients.get(row.persona);
    if (!client) {
      log.error("no client for persona", { persona: row.persona });
      this.db.markOutboxFailed(row.id, "no telegram client");
      return;
    }

    const payload = JSON.parse(row.payload_json);
    const formattedText = markdownToTelegramHtml(payload.text);

    try {
      if (row.kind === "send") {
        // Try HTML first; fall back to plain text if Telegram rejects the markup
        let result = await client.sendMessage(row.chat_id, formattedText, "HTML");
        if (!result && formattedText !== payload.text) {
          log.debug("HTML send failed, falling back to plain text", { id: row.id });
          result = await client.sendMessage(row.chat_id, payload.text);
        }
        if (result) {
          this.db.markOutboxSent(row.id, result.messageId);

          // Fire callback if registered
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
        let ok = await client.editMessageText(row.chat_id, row.telegram_message_id, formattedText, "HTML");
        if (!ok && formattedText !== payload.text) {
          log.debug("HTML edit failed, falling back to plain text", { id: row.id });
          ok = await client.editMessageText(row.chat_id, row.telegram_message_id, payload.text);
        }
        if (ok) {
          this.db.markOutboxSent(row.id);
        } else {
          this.handleFailure(row, "editMessageText failed");
        }
      }
    } catch (err) {
      this.handleFailure(row, String(err));
    }
  }

  private handleFailure(row: { id: number; attempt_count: number; kind?: string; persona?: PersonaName }, error: string) {
    const backoff = this.config.outboxRetryBaseMs * Math.pow(2, row.attempt_count);
    const nextAttempt = new Date(Date.now() + backoff).toISOString();

    if (row.persona) {
      const counter = row.kind === "edit" ? "telegram_edit_failures" as const : "telegram_send_failures" as const;
      this.metrics.inc(row.persona, counter);
    }

    log.warn("outbox delivery failed", {
      id: row.id,
      attempt: row.attempt_count + 1,
      maxAttempts: this.config.outboxMaxAttempts,
      error,
    });

    this.db.markOutboxRetrying(row.id, error, nextAttempt, this.config.outboxMaxAttempts);
  }
}
