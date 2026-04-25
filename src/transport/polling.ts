// PollingTransport — one Poller instance per bot, each running a long-poll
// getUpdates loop with offset persisted in bot_state. Offsets prevent replay
// on restart; dedup on inbound_updates is still the last line of defense.

import { logger } from "../log.js";
import { nextBackoffMs } from "../backoff.js";
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

/**
 * Cap on the failureCount counter. The actual backoff is already clamped to
 * `backoff_cap_ms`; once we've reached the saturation point in
 * `nextBackoffMs`, the counter itself ceases to be informative and could
 * grow without bound on long-lived deployments cycling between transient
 * failures and successes. Cap matches `nextBackoffMs`'s saturation: with
 * base=100ms and cap=30_000ms, attempt 9 already saturates (100*2^9 >
 * 30_000), so 16 is comfortably above that and below MAX_SAFE_INTEGER for
 * any sane configuration.
 */
const FAILURE_COUNT_CAP = 16;

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

    const allowedUpdates = this.config.transport.allowed_updates;
    const timeoutSecs = this.config.transport.polling.timeout_secs;
    const limit = this.config.transport.polling.max_updates_per_batch;
    const baseBackoff = this.config.transport.polling.backoff_base_ms;
    const capBackoff = this.config.transport.polling.backoff_cap_ms;

    while (this.running) {
      const state = this.db.getBotState(this.botId);
      if (state?.disabled) {
        log.warn("bot disabled — poller exiting", {
          bot_id: this.botId,
          reason: state.disabled_reason,
        });
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
          // Track the highest *successfully-processed* update_id rather
          // than the highest in the batch. A transient DB error or
          // exception inside onUpdate must not cause the offset to
          // advance past the failing update — otherwise the dedup ledger
          // (`inbound_updates`) was never written, and Telegram will
          // never redeliver. Stop advancing on the first failure so
          // ordering is preserved across retries.
          let maxSuccessfulId = 0;
          let stopAdvancing = false;
          for (const update of updates) {
            if (stopAdvancing) break;
            try {
              await onUpdate(this.botId, update);
              if (update.update_id > maxSuccessfulId) {
                maxSuccessfulId = update.update_id;
              }
            } catch (err) {
              log.error("update handler threw; offset will not advance", {
                bot_id: this.botId,
                update_id: update.update_id,
                error: err instanceof Error ? err.message : String(err),
              });
              stopAdvancing = true;
            }
          }
          if (maxSuccessfulId > 0) {
            this.db.setBotLastUpdateId(this.botId, maxSuccessfulId);
          }
        }
      } catch (err) {
        if (!this.running) return;
        if (err instanceof TelegramError && err.isAuth) {
          log.error("auth failure in poll loop", { bot_id: this.botId });
          this.db.setBotDisabled(this.botId, "Telegram 401 — check bot token");
          return;
        }
        // Cap the counter so it can't grow unbounded on cyclic failures
        // (e.g. every Nth poll throws). The backoff is already cap'd, but
        // a bare counter that ticks up forever is misleading in logs and
        // metrics.
        this.failureCount = Math.min(this.failureCount + 1, FAILURE_COUNT_CAP);
        const backoff = nextBackoffMs(
          this.failureCount - 1,
          baseBackoff,
          capBackoff,
        );
        // Honor Telegram's Retry-After cooldown when present. Hammering
        // before the cooldown expires extends the throttle and makes the
        // self-DoS surface worse.
        const retryAfterMs =
          err instanceof TelegramError ? err.retryAfterMs : undefined;
        const wait = retryAfterMs ? Math.max(backoff, retryAfterMs) : backoff;
        log.warn("poll failed; backing off", {
          bot_id: this.botId,
          failure: this.failureCount,
          wait_ms: wait,
          backoff_ms: backoff,
          retry_after_ms: retryAfterMs,
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
