// Operational alerts — one delivery bot + one chat_id, decoupled from the
// subject bot (§3.9). If the `alerts` block is absent, alerts are logged at
// warn level only.

import { logger } from "./log.js";
import type { BotId, Config } from "./config/schema.js";
import type { TelegramClient } from "./telegram/client.js";

const log = logger("alerts");

export type AlertKind =
  | "workerDegraded"
  | "workerCrashLoop"
  | "tokenInvalid"
  | "mailboxBacklog"
  | "outboxFailures"
  | "attachmentDiskFull"
  | "webhookSetFailed";

export class AlertManager {
  private cooldowns = new Map<string, number>();
  private cooldownMs: number;
  private chatId: number | null;
  private deliveryClient: TelegramClient | null;

  constructor(
    config: Config,
    clients: Map<BotId, TelegramClient>,
  ) {
    const alerts = config.alerts;
    this.cooldownMs = alerts?.cooldown_ms ?? 600_000;
    this.chatId = alerts?.chat_id ?? null;
    this.deliveryClient = alerts?.via_bot ? clients.get(alerts.via_bot) ?? null : null;
  }

  private shouldAlert(key: string): boolean {
    const now = Date.now();
    const last = this.cooldowns.get(key) ?? 0;
    if (now - last < this.cooldownMs) return false;
    this.cooldowns.set(key, now);
    return true;
  }

  private async emit(kind: AlertKind, botId: BotId | null, text: string): Promise<void> {
    const key = `${kind}:${botId ?? "_"}`;
    if (!this.shouldAlert(key)) return;

    if (!this.deliveryClient || !this.chatId) {
      log.warn(`alert: ${text}`, { alert_kind: kind, bot_id: botId });
      return;
    }
    try {
      await this.deliveryClient.sendMessage(this.chatId, text);
      log.info("alert sent", { alert_kind: kind, bot_id: botId });
    } catch (err) {
      log.error("alert send failed", {
        alert_kind: kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async workerDegraded(botId: BotId, reason: string): Promise<void> {
    await this.emit("workerDegraded", botId, `⚠️ bot ${botId} degraded: ${reason}`);
  }

  async workerCrashLoop(botId: BotId, failures: number): Promise<void> {
    await this.emit(
      "workerCrashLoop",
      botId,
      `⚠️ bot ${botId} crash loop: ${failures} consecutive failures`,
    );
  }

  async tokenInvalid(botId: BotId): Promise<void> {
    await this.emit("tokenInvalid", botId, `🚨 bot ${botId} token invalid (401). Disabled.`);
  }

  async mailboxBacklog(botId: BotId, depth: number): Promise<void> {
    await this.emit(
      "mailboxBacklog",
      botId,
      `⚠️ bot ${botId} mailbox backlog: ${depth} queued turns`,
    );
  }

  async outboxFailures(botId: BotId, count: number): Promise<void> {
    await this.emit(
      "outboxFailures",
      botId,
      `⚠️ bot ${botId}: ${count} outbox deliveries dead-lettered`,
    );
  }

  async attachmentDiskFull(): Promise<void> {
    await this.emit(
      "attachmentDiskFull",
      null,
      `⚠️ attachment storage full — new uploads rejected until sweeper runs`,
    );
  }

  async webhookSetFailed(botId: BotId, reason: string): Promise<void> {
    await this.emit(
      "webhookSetFailed",
      botId,
      `⚠️ bot ${botId} setWebhook failed: ${reason}`,
    );
  }
}
