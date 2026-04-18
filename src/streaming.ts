import { logger } from "./log.js";
import type { BotId, Config } from "./config/schema.js";
import type { GatewayDB } from "./db/gateway-db.js";
import type { OutboxProcessor } from "./outbox.js";
import type { TelegramClient } from "./telegram/client.js";

const log = logger("streaming");

/**
 * Streaming UX for one active turn: buffers text_delta events, flushes edits
 * to Telegram at a throttled cadence, splits long messages.
 */
export class StreamManager {
  private config: Config;
  private db: GatewayDB;
  private outbox: OutboxProcessor;
  private clients: Map<BotId, TelegramClient>;

  private activeTurns = new Map<
    BotId,
    {
      turnId: number;
      chatId: number;
      buffer: string;
      telegramMessageId: number | null;
      segmentIndex: number;
      lastFlushTime: number;
      flushTimer: ReturnType<typeof setTimeout> | null;
      hadFirstOutput: boolean;
      typingTimer: ReturnType<typeof setInterval> | null;
    }
  >();

  constructor(
    config: Config,
    db: GatewayDB,
    outbox: OutboxProcessor,
    clients: Map<BotId, TelegramClient>,
  ) {
    this.config = config;
    this.db = db;
    this.outbox = outbox;
    this.clients = clients;
  }

  /** Cancel an in-flight stream (e.g. after fatal runner error). */
  cancelTurn(botId: BotId): void {
    const prev = this.activeTurns.get(botId);
    if (!prev) return;

    if (prev.typingTimer) clearInterval(prev.typingTimer);
    if (prev.flushTimer) clearTimeout(prev.flushTimer);

    if (prev.telegramMessageId) {
      const display = prev.buffer.trim() || "(interrupted)";
      this.outbox.queueEdit(prev.turnId, botId, prev.chatId, prev.telegramMessageId, display);
    }

    this.activeTurns.delete(botId);
    log.info("turn cancelled", { bot_id: botId, turn_id: prev.turnId });
  }

  async startTurn(botId: BotId, turnId: number, chatId: number): Promise<void> {
    this.cancelTurn(botId);
    this.db.initStreamState(turnId);

    const typingTimer = setInterval(() => this.sendTyping(botId), 4_000);

    this.activeTurns.set(botId, {
      turnId,
      chatId,
      buffer: "",
      telegramMessageId: null,
      segmentIndex: 0,
      lastFlushTime: 0,
      flushTimer: null,
      hadFirstOutput: false,
      typingTimer,
    });

    this.sendTyping(botId);

    this.outbox.queueSendWithCallback(
      turnId,
      botId,
      chatId,
      "\u{1F440} thinking...",
      (messageId) => {
        const state = this.activeTurns.get(botId);
        if (state && state.turnId === turnId) {
          state.telegramMessageId = messageId;
          this.db.updateStreamState(turnId, {
            active_telegram_message_id: messageId,
          });
          this.sendTyping(botId);
        }
      },
    );
  }

  appendText(botId: BotId, text: string): void {
    const state = this.activeTurns.get(botId);
    if (!state) return;

    if (!state.hadFirstOutput) {
      state.hadFirstOutput = true;
      this.db.setTurnFirstOutput(state.turnId);
    }

    state.buffer += text;

    if (state.buffer.length >= this.config.streaming.message_length_safe_margin) {
      this.flushAndSplit(botId);
      return;
    }

    const now = Date.now();
    if (now - state.lastFlushTime >= this.config.streaming.edit_cadence_ms) {
      void this.flush(botId);
    } else if (!state.flushTimer) {
      const delay = this.config.streaming.edit_cadence_ms - (now - state.lastFlushTime);
      state.flushTimer = setTimeout(() => {
        state.flushTimer = null;
        void this.flush(botId);
      }, delay);
    }
  }

  async finalizeTurn(botId: BotId, finalText: string): Promise<void> {
    const state = this.activeTurns.get(botId);
    if (!state) return;

    if (state.typingTimer) {
      clearInterval(state.typingTimer);
      state.typingTimer = null;
    }
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }

    if (finalText && finalText !== state.buffer) {
      state.buffer = finalText;
    }

    if (!state.buffer.trim()) {
      this.activeTurns.delete(botId);
      return;
    }

    const chunks = this.splitMessage(state.buffer);

    if (chunks.length === 1 && state.telegramMessageId) {
      this.outbox.queueEdit(
        state.turnId,
        botId,
        state.chatId,
        state.telegramMessageId,
        chunks[0],
      );
    } else {
      let startIdx = 0;
      if (state.telegramMessageId && chunks.length > 0) {
        this.outbox.queueEdit(
          state.turnId,
          botId,
          state.chatId,
          state.telegramMessageId,
          chunks[0],
        );
        startIdx = 1;
      }
      for (let i = startIdx; i < chunks.length; i++) {
        this.outbox.queueSend(state.turnId, botId, state.chatId, chunks[i]);
      }
    }

    this.activeTurns.delete(botId);
  }

  stopAll(): void {
    for (const [, state] of this.activeTurns) {
      if (state.typingTimer) clearInterval(state.typingTimer);
      if (state.flushTimer) clearTimeout(state.flushTimer);
    }
    this.activeTurns.clear();
  }

  // --- internals ---

  private sendTyping(botId: BotId): void {
    const state = this.activeTurns.get(botId);
    if (!state) return;
    const client = this.clients.get(botId);
    if (client) client.sendChatAction(state.chatId).catch(() => {});
  }

  private async flush(botId: BotId): Promise<void> {
    const state = this.activeTurns.get(botId);
    if (!state || !state.telegramMessageId || !state.buffer.trim()) return;

    state.lastFlushTime = Date.now();
    await this.outbox.fireAndForgetEdit(
      botId,
      state.chatId,
      state.telegramMessageId,
      state.buffer,
    );
    this.sendTyping(botId);

    this.db.setTurnLastOutput(state.turnId);
    this.db.updateStreamState(state.turnId, {
      buffer_text: state.buffer,
      last_flushed_at: new Date().toISOString(),
    });
  }

  private flushAndSplit(botId: BotId): void {
    const state = this.activeTurns.get(botId);
    if (!state) return;

    const currentText = state.buffer;
    if (state.telegramMessageId) {
      this.outbox.queueEdit(
        state.turnId,
        botId,
        state.chatId,
        state.telegramMessageId,
        currentText,
      );
    }

    state.buffer = "";
    state.telegramMessageId = null;
    state.segmentIndex += 1;

    this.outbox.queueSendWithCallback(
      state.turnId,
      botId,
      state.chatId,
      "...",
      (messageId) => {
        const s = this.activeTurns.get(botId);
        if (s && s.turnId === state.turnId) {
          s.telegramMessageId = messageId;
          this.db.updateStreamState(s.turnId, {
            active_telegram_message_id: messageId,
          });
        }
      },
    );
  }

  private splitMessage(text: string): string[] {
    const limit = this.config.streaming.message_length_limit;
    if (text.length <= limit) return [text];

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf("\n", limit);
      if (splitAt < limit / 2) splitAt = limit;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return chunks;
  }
}
