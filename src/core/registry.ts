// BotRegistry — owns the collection of Bot instances, routes inbound updates
// through processUpdate, and runs the dispatch loop that feeds turns into
// runners.

import { logger } from "../log.js";
import type { AlertManager } from "../alerts.js";
import type { BotId, Config } from "../config/schema.js";
import type { GatewayDB } from "../db/gateway-db.js";
import type { Metrics } from "../metrics.js";
import { Bot } from "./bot.js";
import {
  processInboundEvent,
  type ProcessInboundOutcome,
} from "./process-inbound-event.js";
import type { BotStatusSnapshot, CommandContext } from "./commands.js";
import type { StreamManager } from "../streaming.js";
import type { OutboxProcessor } from "../outbox.js";
import type { PlatformAdapter } from "../platform/capabilities.js";
import type { ConversationRef } from "../platform/types.js";

const log = logger("registry");

export interface BotRegistryOptions {
  config: Config;
  db: GatewayDB;
  bots: Bot[];
  adapters: Map<BotId, PlatformAdapter>;
  streaming: StreamManager;
  outbox: OutboxProcessor;
  metrics: Metrics;
  alerts: AlertManager;
}

export class BotRegistry {
  private config: Config;
  private db: GatewayDB;
  private bots: Map<BotId, Bot>;
  private adapters: Map<BotId, PlatformAdapter>;
  private metrics: Metrics;
  private alerts: AlertManager;
  private dispatchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: BotRegistryOptions) {
    this.config = opts.config;
    this.db = opts.db;
    this.bots = new Map(opts.bots.map((b) => [b.id, b]));
    this.adapters = opts.adapters;
    this.metrics = opts.metrics;
    this.alerts = opts.alerts;
  }

  bot(id: BotId): Bot | undefined {
    return this.bots.get(id);
  }

  get botIds(): BotId[] {
    return [...this.bots.keys()];
  }

  async startAll(): Promise<void> {
    await Promise.all([...this.bots.values()].map((b) => b.start()));
    this.dispatchTimer = setInterval(() => this.dispatchAll(), 2000);
  }

  async stopAll(graceMs?: number): Promise<void> {
    if (this.dispatchTimer) {
      clearInterval(this.dispatchTimer);
      this.dispatchTimer = null;
    }
    await Promise.all([...this.bots.values()].map((b) => b.stop(graceMs)));
  }

  /**
   * Transport entry point: deliver a platform-native payload for an endpoint.
   */
  async handleUpdate(
    botId: BotId,
    update: unknown,
  ): Promise<ProcessInboundOutcome> {
    const bot = this.bots.get(botId);
    if (!bot) {
      log.warn("update for unknown bot", { bot_id: botId });
      return { status: "dropped_malformed" };
    }
    const adapter = this.adapters.get(botId);
    if (!adapter) {
      log.warn("update for endpoint without adapter", { bot_id: botId });
      return { status: "dropped_malformed" };
    }
    const event = adapter.normalizeInbound(update);
    if (!event || !event.conversation) {
      return { status: "dropped_malformed" };
    }
    this.metrics.inc(botId, "inbound_received");
    const outcome = await processInboundEvent(
      {
        config: this.config,
        db: this.db,
        botConfig: bot.botConfig,
        adapter,
        alerts: this.alerts,
        onEnqueued: () => this.dispatchFor(botId),
        commandContextFactory: (args) =>
          this.buildCommandContext(bot, adapter, event.conversation!, args),
      },
      event,
    );
    if (outcome.status === "replay_skipped") {
      this.metrics.inc(botId, "inbound_deduped");
    }
    return outcome;
  }

  /** Dispatch the next queued turn for `botId` if the runner is idle. */
  dispatchFor(botId: BotId): void {
    const bot = this.bots.get(botId);
    if (!bot || !bot.isReady) return;

    const queued = this.db.getQueuedTurns(botId);
    if (queued.length === 0) return;

    const turn = queued[0];
    const text = this.db.getTurnText(turn.id);
    if (text === null) {
      this.db.completeTurn(turn.id, "no message text");
      return;
    }

    const attachments = this.db.getTurnAttachments(turn.id);
    bot.dispatchTurn(turn.id, turn.chat_id, text, attachments);
  }

  dispatchAll(): void {
    for (const botId of this.bots.keys()) {
      this.dispatchFor(botId);
    }
  }

  private buildCommandContext(
    bot: Bot,
    adapter: PlatformAdapter,
    conversation: ConversationRef,
    args: {
      chatId: number;
      messageId: number;
      fromUserId: number;
      rawText: string;
    },
  ): CommandContext {
    return {
      botConfig: bot.botConfig,
      chatId: args.chatId,
      messageId: args.messageId,
      fromUserId: args.fromUserId,
      rawText: args.rawText,
      adapter,
      conversation,
      runner: bot.runner,
      getStatus: () => this.snapshotFor(bot),
    };
  }

  snapshotFor(bot: Bot): BotStatusSnapshot {
    const state = this.db.getBotState(bot.id);
    return {
      botId: bot.id,
      runner_ready: bot.runner.isReady(),
      mailbox_depth: this.db.getMailboxDepth(bot.id),
      last_turn_at: this.db.getLastTurnAt(bot.id),
      disabled: !!state?.disabled,
      disabled_reason: state?.disabled_reason ?? null,
    };
  }
}
