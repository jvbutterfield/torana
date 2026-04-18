// PollingTransport — one Poller instance per bot, each running a long-poll
// getUpdates loop with offset persisted in bot_state. Offsets prevent replay
// on restart; dedup on inbound_updates is still the last line of defense.

import { logger } from "../log.js";
import type { BotId, Config } from "../config/schema.js";
import type { TelegramClient } from "../telegram/client.js";
import type { GatewayDB } from "../db/gateway-db.js";
import type { OnUpdateHandler, Transport } from "./types.js";
import { TelegramError } from "../telegram/client.js";

const log = logger("transport.polling");

export interface PollingTransportOptions {
  config: Config;
  db: GatewayDB;
  clients: Map<BotId, TelegramClient>;
}

class BotPoller {
  readonly botId: BotId;
  private client: TelegramClient;
  private db: GatewayDB;
  private config: Config;
  private abortController: AbortController | null = null;
  private running = false;
  private donePromise: Promise<void> | null = null;
  private failureCount = 0;

  constructor(
    botId: BotId,
    client: TelegramClient,
    db: GatewayDB,
    config: Config,
  ) {
    this.botId = botId;
    this.client = client;
    this.db = db;
    this.config = config;
  }

  start(onUpdate: OnUpdateHandler): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    this.donePromise = this.loop(onUpdate);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController?.abort();
    if (this.donePromise) {
      try {
        await this.donePromise;
      } catch {
        /* ignore */
      }
    }
  }

  private async loop(onUpdate: OnUpdateHandler): Promise<void> {
    this.db.initBotState(this.botId);

    try {
      await this.client.deleteWebhook(false);
    } catch {
      /* best-effort */
    }

    const allowedUpdates = this.config.transport.webhook?.allowed_updates ?? ["message"];
    const timeoutSecs = this.config.transport.polling.timeout_secs;
    const limit = this.config.transport.polling.max_updates_per_batch;
    const baseBackoff = this.config.transport.polling.backoff_base_ms;
    const capBackoff = this.config.transport.polling.backoff_cap_ms;

    while (this.running) {
      const state = this.db.getBotState(this.botId);
      if (state?.disabled) {
        log.warn("bot disabled — poller exiting", { bot_id: this.botId, reason: state.disabled_reason });
        return;
      }

      const offset = state?.last_update_id ? state.last_update_id + 1 : 0;

      try {
        const updates = await this.client.getUpdates({
          offset,
          timeoutSecs,
          limit,
          allowedUpdates,
          signal: this.abortController?.signal,
        });
        this.failureCount = 0;

        if (updates.length > 0) {
          let maxId = 0;
          for (const update of updates) {
            if (update.update_id > maxId) maxId = update.update_id;
            try {
              await onUpdate(this.botId, update);
            } catch (err) {
              log.error("update handler threw", {
                bot_id: this.botId,
                update_id: update.update_id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          this.db.setBotLastUpdateId(this.botId, maxId);
        }
      } catch (err) {
        if (!this.running) return;
        if (err instanceof TelegramError && err.isAuth) {
          log.error("auth failure in poll loop", { bot_id: this.botId });
          this.db.setBotDisabled(
            this.botId,
            "Telegram 401 — check bot token",
          );
          return;
        }
        this.failureCount += 1;
        const wait = Math.min(capBackoff, baseBackoff * 2 ** (this.failureCount - 1));
        log.warn("poll failed; backing off", {
          bot_id: this.botId,
          failure: this.failureCount,
          wait_ms: wait,
          error: err instanceof Error ? err.message : String(err),
        });
        await this.sleep(wait);
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), ms);
      this.abortController?.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

export class PollingTransport implements Transport {
  readonly kind = "polling" as const;
  readonly botIds: readonly BotId[];
  private pollers = new Map<BotId, BotPoller>();

  constructor(opts: PollingTransportOptions) {
    this.botIds = [...opts.clients.keys()];
    for (const [botId, client] of opts.clients) {
      this.pollers.set(
        botId,
        new BotPoller(botId, client, opts.db, opts.config),
      );
    }
  }

  async start(onUpdate: OnUpdateHandler): Promise<void> {
    for (const poller of this.pollers.values()) {
      poller.start(onUpdate);
    }
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.pollers.values()].map((poller) => poller.stop()),
    );
  }
}
