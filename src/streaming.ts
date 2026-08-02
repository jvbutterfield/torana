import { logger } from "./log.js";
import type { BotId, Config } from "./config/schema.js";
import type { GatewayDB } from "./db/gateway-db.js";
import type { OutboxProcessor } from "./outbox.js";
import type { PlatformAdapter } from "./platform/capabilities.js";
import { telegramConversation } from "./platform/telegram/adapter.js";

const log = logger("streaming");

interface ActiveStreamTurn {
  turnId: number;
  chatId: number;
  buffer: string;
  telegramMessageId: number | null;
  segmentIndex: number;
  lastFlushTime: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  hadFirstOutput: boolean;
  typingTimer: ReturnType<typeof setInterval> | null;
  firstSendInFlight: boolean;
  lastDispatchedText: string;
  deferredFinalChunks: string[] | null;
}

/**
 * Streaming UX for active turns: buffers text_delta events, flushes edits to
 * Telegram at a throttled cadence, and isolates concurrent conversations by
 * turn id.
 */
export class StreamManager {
  private config: Config;
  private db: GatewayDB;
  private outbox: OutboxProcessor;
  private adapters: Map<BotId, PlatformAdapter>;

  /**
   * Per-bot rate-limit cooldown timestamp (epoch ms). When set above
   * `Date.now()`, flush() skips the editMessageText call entirely; the
   * buffer continues to accumulate so the next non-rate-limited flush
   * picks up the latest text. Populated when fireAndForgetEdit returns
   * a 429 with Retry-After. Cleared implicitly by passing the timestamp.
   *
   * Without this, a runner producing fast edits would keep pinging
   * Telegram every `edit_cadence_ms` during the cooldown — extending the
   * throttle and amplifying the self-DoS surface (rc.7 review F3).
   */
  private rateLimitedUntil = new Map<BotId, number>();

  private activeTurns = new Map<string, ActiveStreamTurn>();

  constructor(
    config: Config,
    db: GatewayDB,
    outbox: OutboxProcessor,
    endpoints: ReadonlyMap<BotId, PlatformAdapter>,
  ) {
    this.config = config;
    this.db = db;
    this.outbox = outbox;
    this.adapters = new Map(endpoints);
  }

  /** Cancel an in-flight stream (e.g. after fatal runner error). */
  cancelTurn(botId: BotId, turnId?: number): void {
    const found = this.findTurn(botId, turnId);
    const prev = found?.state;
    if (!prev) return;

    if (prev.typingTimer) clearInterval(prev.typingTimer);
    if (prev.flushTimer) clearTimeout(prev.flushTimer);

    if (prev.telegramMessageId) {
      const display = prev.buffer.trim() || "(interrupted)";
      this.outbox.queueEdit(
        prev.turnId,
        botId,
        prev.chatId,
        prev.telegramMessageId,
        display,
      );
    }

    this.activeTurns.delete(found!.key);
    log.info("turn cancelled", { bot_id: botId, turn_id: prev.turnId });
  }

  startTurn(botId: BotId, turnId: number, chatId: number): void {
    this.cancelTurn(botId, turnId);
    this.db.initStreamState(turnId);

    const typingTimer = setInterval(
      () => this.sendTyping(botId, turnId),
      4_000,
    );

    this.activeTurns.set(this.turnKey(botId, turnId), {
      turnId,
      chatId,
      buffer: "",
      telegramMessageId: null,
      segmentIndex: 0,
      lastFlushTime: 0,
      flushTimer: null,
      hadFirstOutput: false,
      typingTimer,
      firstSendInFlight: false,
      lastDispatchedText: "",
      deferredFinalChunks: null,
    });

    // No eager "thinking..." placeholder. The first sendMessage is queued
    // lazily on the first text_delta (or by finalizeTurn for runners that
    // produce only a final response, no streaming). Sending the user's
    // visible message exactly once — fresh, not as an edit — is what
    // triggers Telegram's push notification on their device. Editing a
    // pre-existing placeholder does not. The sendChatAction typing ping
    // (every 4s) covers the "torana received your message" feedback while
    // the runner thinks.
    this.sendTyping(botId, turnId);
  }

  appendText(botId: BotId, text: string, turnId?: number): void {
    const state = this.findTurn(botId, turnId)?.state;
    if (!state) return;

    if (!state.hadFirstOutput) {
      state.hadFirstOutput = true;
      this.db.setTurnFirstOutput(state.turnId);
    }

    state.buffer += text;

    if (state.telegramMessageId === null) {
      // No message has been sent yet for this turn. Queue the initial
      // sendMessage on the first text_delta — that fresh send is what
      // pings the user's phone. Subsequent text continues to accumulate
      // in the buffer; the send-callback will catch up via flush() once
      // Telegram returns the messageId.
      if (!state.firstSendInFlight) {
        this.queueInitialSend(botId, state.turnId);
      }
      return;
    }

    if (
      state.buffer.length >= this.config.streaming.message_length_safe_margin
    ) {
      this.flushAndSplit(botId, state.turnId);
      return;
    }

    const now = Date.now();
    if (now - state.lastFlushTime >= this.config.streaming.edit_cadence_ms) {
      void this.flush(botId, state.turnId);
    } else if (!state.flushTimer) {
      const delay =
        this.config.streaming.edit_cadence_ms - (now - state.lastFlushTime);
      state.flushTimer = setTimeout(() => {
        state.flushTimer = null;
        void this.flush(botId, state.turnId);
      }, delay);
    }
  }

  private queueInitialSend(botId: BotId, turnId: number): void {
    const state = this.findTurn(botId, turnId)?.state;
    if (!state) return;
    state.firstSendInFlight = true;
    state.lastDispatchedText = state.buffer;
    turnId = state.turnId;
    const chatId = state.chatId;
    this.outbox.queueSendWithCallback(
      turnId,
      botId,
      chatId,
      state.buffer,
      (messageId) => {
        const found = this.findTurn(botId, turnId);
        const s = found?.state;
        if (!s || s.turnId !== turnId) {
          // Turn was cancelled or replaced before the initial send
          // completed. The Telegram message exists in the chat but we no
          // longer track its id; nothing more to do here. The previous
          // design (eager placeholder send) had the same race shape and
          // resolved it the same way.
          return;
        }
        s.telegramMessageId = messageId;
        s.firstSendInFlight = false;
        this.db.updateStreamState(s.turnId, {
          active_telegram_message_id: messageId,
        });

        if (s.deferredFinalChunks) {
          // Fast-runner race: finalizeTurn ran during the initial send.
          // Edit the just-sent message with the final chunks[0] and queue
          // fresh sends for any remainder, in place of leaving the partial
          // first chunk visible. Dedup against lastDispatchedText so a
          // runner that emits its full response in a single delta (the
          // common case for non-streaming agents) does not produce a
          // redundant edit on top of the initial send.
          const chunks = s.deferredFinalChunks;
          s.deferredFinalChunks = null;
          if (chunks[0] !== s.lastDispatchedText) {
            this.outbox.queueEdit(
              s.turnId,
              botId,
              s.chatId,
              messageId,
              chunks[0],
            );
          }
          for (let i = 1; i < chunks.length; i++) {
            this.outbox.queueSend(s.turnId, botId, s.chatId, chunks[i]);
          }
          this.activeTurns.delete(found!.key);
          return;
        }

        // Buffer may have grown during the round-trip but we don't catch
        // up here. Any subsequent text_delta or finalizeTurn will pick up
        // the latest buffer via the normal flush path; both are
        // guaranteed to fire in any real runner flow (a stream that ends
        // without a finalizeTurn is a runner bug, and an explicit
        // catch-up edit here just produces a redundant edit before the
        // final one — measurable as an extra editMessageText call per
        // turn, which trips downstream "no-new-Telegram-activity" tests.
        this.sendTyping(botId, turnId);
      },
    );
  }

  async finalizeTurn(
    botId: BotId,
    finalText: string,
    turnId?: number,
  ): Promise<void> {
    const found = this.findTurn(botId, turnId);
    const state = found?.state;
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
      // Empty response and no streamed text. Nothing was ever sent to the
      // user (no eager placeholder), so there is nothing to clean up in
      // the chat. Silent close.
      this.activeTurns.delete(found!.key);
      return;
    }

    const chunks = this.splitMessage(state.buffer);

    if (state.firstSendInFlight) {
      // Fast-runner race: the initial sendMessage is queued but Telegram
      // has not yet returned its messageId. Stash the chunks for the
      // send-callback to drain — it edits the just-sent message with
      // chunks[0] and queues fresh sends for the remainder once the
      // messageId is known. See queueInitialSend().
      state.deferredFinalChunks = chunks;
      return;
    }

    if (state.telegramMessageId === null) {
      // No initial send happened — runner produced no streaming text, only
      // a final response (or the response is final-only). Send each chunk
      // as a fresh sendMessage. The first one triggers the user's phone
      // notification, which is the whole point of this design.
      for (const chunk of chunks) {
        this.outbox.queueSend(state.turnId, botId, state.chatId, chunk);
      }
      this.activeTurns.delete(found!.key);
      return;
    }

    // Streaming case: a message already exists. Edit it with chunks[0]
    // and queue fresh sends for any continuation chunks. Skip the edit
    // when the active message already shows chunks[0] verbatim — the
    // initial sendMessage (or the most recent cadence flush) already
    // delivered this text. Avoids a redundant editMessageText that
    // Telegram would no-op as "message is not modified" and that would
    // otherwise trip "no-new-Telegram-activity" assertions in tests.
    if (chunks[0] !== state.lastDispatchedText) {
      this.outbox.queueEdit(
        state.turnId,
        botId,
        state.chatId,
        state.telegramMessageId,
        chunks[0],
      );
    }
    for (let i = 1; i < chunks.length; i++) {
      this.outbox.queueSend(state.turnId, botId, state.chatId, chunks[i]);
    }

    this.activeTurns.delete(found!.key);
  }

  stopAll(): void {
    for (const [, state] of this.activeTurns) {
      if (state.typingTimer) clearInterval(state.typingTimer);
      if (state.flushTimer) clearTimeout(state.flushTimer);
    }
    this.activeTurns.clear();
    this.rateLimitedUntil.clear();
  }

  // --- internals ---

  private sendTyping(botId: BotId, turnId?: number): void {
    const state = this.findTurn(botId, turnId)?.state;
    if (!state) return;
    // Skip the typing ping while we're inside a Telegram cooldown — the
    // sendChatAction call counts against per-bot rate limits and
    // produces no user-visible benefit while edits are paused (rc.7
    // review F9).
    const cooldownUntil = this.rateLimitedUntil.get(botId);
    if (cooldownUntil && Date.now() < cooldownUntil) return;
    const adapter = this.adapters.get(botId);
    if (adapter) {
      void adapter
        .signal(telegramConversation(botId, state.chatId), {
          kind: "typing",
          active: true,
        })
        .catch(() => {});
    }
  }

  private async flush(botId: BotId, turnId?: number): Promise<void> {
    const state = this.findTurn(botId, turnId)?.state;
    if (!state || !state.telegramMessageId || !state.buffer.trim()) return;

    // Skip the edit if we're inside a Telegram-asked cooldown for this
    // bot. The buffer continues to accumulate; the next flush after
    // the cooldown expires will push the latest content. Pinging during
    // the cooldown extends the throttle and produces no user-visible
    // benefit.
    const cooldownUntil = this.rateLimitedUntil.get(botId);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      return;
    }

    state.lastFlushTime = Date.now();
    const flushedText = state.buffer;
    state.lastDispatchedText = flushedText;
    const result = await this.outbox.fireAndForgetEdit(
      botId,
      state.chatId,
      state.telegramMessageId,
      flushedText,
    );

    // Honor 429 / Retry-After signals from the streaming editMessage
    // path. The cooldown is per-bot rather than per-chat because
    // Telegram's per-chat 429s typically also imply a slower rate is
    // expected on the same bot's other chats — being conservative here
    // is the right move.
    if (
      result &&
      !result.ok &&
      result.retryAfterMs !== undefined &&
      result.retryAfterMs > 0
    ) {
      const cappedMs = Math.min(result.retryAfterMs, 5 * 60_000);
      this.rateLimitedUntil.set(botId, Date.now() + cappedMs);
      log.warn("streaming flush throttled by Telegram; pausing edits", {
        bot_id: botId,
        retry_after_ms: result.retryAfterMs,
        capped_until_ms: cappedMs,
      });
    } else if (cooldownUntil) {
      // Successful flush past the cooldown — clear the map entry so we
      // don't carry stale state.
      this.rateLimitedUntil.delete(botId);
    }

    this.sendTyping(botId, state.turnId);

    this.db.setTurnLastOutput(state.turnId);
    this.db.updateStreamState(state.turnId, {
      buffer_text: state.buffer,
      last_flushed_at: new Date().toISOString(),
    });
  }

  private flushAndSplit(botId: BotId, turnId?: number): void {
    const state = this.findTurn(botId, turnId)?.state;
    if (!state) return;

    if (!state.telegramMessageId) {
      // Buffer overflowed before the initial send completed. The
      // initial-send callback's catch-up flush will pick up the larger
      // buffer (and split itself if it has grown past the safe margin).
      // In practice this is unreachable: the initial send round-trip is
      // tens to hundreds of milliseconds, far short of the time it takes
      // any realistic runner to emit message_length_safe_margin chars.
      return;
    }

    const currentText = state.buffer;
    if (currentText !== state.lastDispatchedText) {
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
    state.firstSendInFlight = true;
    // The new "..." segment send is the next thing we dispatch; track it
    // so the next finalizeTurn / flush can dedupe against it.
    state.lastDispatchedText = "...";

    this.outbox.queueSendWithCallback(
      state.turnId,
      botId,
      state.chatId,
      "...",
      (messageId) => {
        const s = this.findTurn(botId, state.turnId)?.state;
        if (s && s.turnId === state.turnId) {
          s.telegramMessageId = messageId;
          s.firstSendInFlight = false;
          this.db.updateStreamState(s.turnId, {
            active_telegram_message_id: messageId,
          });
          if (s.buffer.length > 0) {
            void this.flush(botId, state.turnId);
          }
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

  private turnKey(botId: BotId, turnId: number): string {
    return `${botId}\u0000${turnId}`;
  }

  private findTurn(
    botId: BotId,
    turnId?: number,
  ):
    | {
        key: string;
        state: ActiveStreamTurn;
      }
    | undefined {
    if (turnId !== undefined) {
      const key = this.turnKey(botId, turnId);
      const state = this.activeTurns.get(key);
      return state ? { key, state } : undefined;
    }
    const prefix = `${botId}\u0000`;
    for (const [key, state] of this.activeTurns) {
      if (key.startsWith(prefix)) return { key, state };
    }
    return undefined;
  }
}
