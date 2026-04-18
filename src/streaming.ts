import { logger } from "./log.js";
import type { GatewayDB } from "./db.js";
import type { Config, PersonaName } from "./config.js";
import type { OutboxProcessor } from "./outbox.js";
import type { TelegramClient } from "./telegram.js";

const log = logger("streaming");

/**
 * Manages the streaming UX for one active turn: buffers text_delta events,
 * flushes edits to Telegram at a throttled cadence, handles long-message
 * splitting.
 */
export class StreamManager {
  private config: Config;
  private db: GatewayDB;
  private outbox: OutboxProcessor;
  private clients: Map<PersonaName, TelegramClient>;

  private activeTurns = new Map<PersonaName, {
    turnId: number;
    chatId: number;
    buffer: string;
    telegramMessageId: number | null;
    segmentIndex: number;
    lastFlushTime: number;
    flushTimer: ReturnType<typeof setTimeout> | null;
    hadFirstOutput: boolean;
    typingTimer: ReturnType<typeof setInterval> | null;
  }>();

  constructor(
    config: Config,
    db: GatewayDB,
    outbox: OutboxProcessor,
    clients: Map<PersonaName, TelegramClient>,
  ) {
    this.config = config;
    this.db = db;
    this.outbox = outbox;
    this.clients = clients;
  }

  /**
   * Cancel an active turn's stream state. Cleans up timers and edits the
   * placeholder to show it was interrupted (so it doesn't sit as a stale
   * "thinking..." message forever).
   */
  cancelTurn(persona: PersonaName) {
    const prev = this.activeTurns.get(persona);
    if (!prev) return;

    if (prev.typingTimer) clearInterval(prev.typingTimer);
    if (prev.flushTimer) clearTimeout(prev.flushTimer);

    // Edit the orphaned placeholder so it doesn't sit as "thinking..." forever
    if (prev.telegramMessageId) {
      const display = prev.buffer.trim() || "(interrupted)";
      this.outbox.queueEdit(prev.turnId, persona, prev.chatId, prev.telegramMessageId, display);
    }

    this.activeTurns.delete(persona);
    log.info("turn cancelled", { persona, turnId: prev.turnId });
  }

  async startTurn(persona: PersonaName, turnId: number, chatId: number) {
    // Clean up any previous active turn for this persona (e.g., after worker
    // crash or re-queue) so we don't leave orphaned "thinking..." messages.
    this.cancelTurn(persona);

    this.db.initStreamState(turnId);

    // Typing indicator strategy:
    // - Telegram cancels "typing..." whenever the bot sends or edits a message.
    // - So we re-send typing AFTER each outbound message (placeholder, edits).
    // - A 4s interval is a safety net for gaps where no edits happen.
    const typingTimer = setInterval(() => {
      this.sendTyping(persona);
    }, 4_000);

    this.activeTurns.set(persona, {
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

    // Send typing immediately (before the placeholder is queued/delivered)
    this.sendTyping(persona);

    // Send placeholder and wire up the message ID callback
    this.outbox.queueSendWithCallback(
      turnId, persona, chatId, "\u{1F440} thinking...",
      (messageId) => {
        const state = this.activeTurns.get(persona);
        if (state && state.turnId === turnId) {
          state.telegramMessageId = messageId;
          this.db.updateStreamState(turnId, { active_telegram_message_id: messageId });
          log.debug("placeholder sent", { persona, messageId });
          // Re-send typing after placeholder delivery (it cancelled the indicator)
          this.sendTyping(persona);
        }
      },
    );
  }

  appendText(persona: PersonaName, text: string) {
    const state = this.activeTurns.get(persona);
    if (!state) return;

    if (!state.hadFirstOutput) {
      state.hadFirstOutput = true;
      this.db.setTurnFirstOutput(state.turnId);
    }
    // last_output_at is written on flush (throttled), not per-token

    state.buffer += text;

    if (state.buffer.length >= this.config.messageLengthSafeMargin) {
      this.flushAndSplit(persona);
      return;
    }

    const now = Date.now();
    if (now - state.lastFlushTime >= this.config.editCadenceMs) {
      this.flush(persona);
    } else if (!state.flushTimer) {
      const delay = this.config.editCadenceMs - (now - state.lastFlushTime);
      state.flushTimer = setTimeout(() => {
        state.flushTimer = null;
        this.flush(persona);
      }, delay);
    }
  }

  async finalizeTurn(persona: PersonaName, finalText: string) {
    const state = this.activeTurns.get(persona);
    if (!state) return;

    if (state.typingTimer) {
      clearInterval(state.typingTimer);
      state.typingTimer = null;
    }
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }

    // Use the final text from the result event (authoritative)
    if (finalText && finalText !== state.buffer) {
      state.buffer = finalText;
    }

    if (!state.buffer.trim()) {
      this.activeTurns.delete(persona);
      return;
    }

    const chunks = this.splitMessage(state.buffer);

    if (chunks.length === 1 && state.telegramMessageId) {
      this.outbox.queueEdit(state.turnId, persona, state.chatId, state.telegramMessageId, chunks[0]);
    } else {
      let startIdx = 0;
      if (state.telegramMessageId && chunks.length > 0) {
        this.outbox.queueEdit(state.turnId, persona, state.chatId, state.telegramMessageId, chunks[0]);
        startIdx = 1;
      }
      for (let i = startIdx; i < chunks.length; i++) {
        this.outbox.queueSend(state.turnId, persona, state.chatId, chunks[i]);
      }
    }

    this.activeTurns.delete(persona);
  }

  /** Send typing indicator for an active turn. No-op if turn is not active. */
  private sendTyping(persona: PersonaName) {
    const state = this.activeTurns.get(persona);
    if (!state) return;
    const client = this.clients.get(persona);
    if (client) client.sendChatAction(state.chatId).catch(() => {});
  }

  private async flush(persona: PersonaName) {
    const state = this.activeTurns.get(persona);
    if (!state || !state.telegramMessageId || !state.buffer.trim()) return;

    state.lastFlushTime = Date.now();

    // Await the edit so the typing indicator fires AFTER Telegram processes it
    // (otherwise typing arrives first and the edit immediately cancels it)
    await this.outbox.fireAndForgetEdit(persona, state.chatId, state.telegramMessageId, state.buffer);
    this.sendTyping(persona);

    // Write last_output_at and buffer on flush cadence, not per-token
    this.db.setTurnLastOutput(state.turnId);
    this.db.updateStreamState(state.turnId, {
      buffer_text: state.buffer,
      last_flushed_at: new Date().toISOString(),
    });
  }

  private flushAndSplit(persona: PersonaName) {
    const state = this.activeTurns.get(persona);
    if (!state) return;

    const currentText = state.buffer;

    if (state.telegramMessageId) {
      this.outbox.queueEdit(state.turnId, persona, state.chatId, state.telegramMessageId, currentText);
    }

    state.buffer = "";
    state.telegramMessageId = null;
    state.segmentIndex++;

    this.outbox.queueSendWithCallback(
      state.turnId, persona, state.chatId, "...",
      (messageId) => {
        const s = this.activeTurns.get(persona);
        if (s && s.turnId === state.turnId) {
          s.telegramMessageId = messageId;
          this.db.updateStreamState(s.turnId, { active_telegram_message_id: messageId });
        }
      },
    );
  }

  private splitMessage(text: string): string[] {
    const limit = this.config.messageLengthLimit;
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

  stopAll() {
    for (const [, state] of this.activeTurns) {
      if (state.typingTimer) clearInterval(state.typingTimer);
      if (state.flushTimer) clearTimeout(state.flushTimer);
    }
    this.activeTurns.clear();
  }
}
