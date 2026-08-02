// Platform-neutral operational alerts. If no normalized or legacy target is
// configured, alerts are logged at warn level only.

import { logger, redactString } from "./log.js";
import type { BotId, Config } from "./config/schema.js";
import type { NormalizedConfigModel } from "./config/v2.js";
import type { PlatformAdapter } from "./platform/capabilities.js";
import type { ConversationRef } from "./platform/types.js";
import { telegramConversation } from "./platform/telegram/adapter.js";

const log = logger("alerts");

export type AlertKind =
  | "workerDegraded"
  | "workerCrashLoop"
  | "tokenInvalid"
  | "mailboxBacklog"
  | "outboxFailures"
  | "attachmentDiskFull"
  | "loopBudgetRejected"
  | "webhookSetFailed";

export class AlertManager {
  private cooldowns = new Map<string, number>();
  private cooldownMs: number;
  private deliveryAdapter: PlatformAdapter | null;
  private target: ConversationRef | null;

  constructor(
    config: Config,
    endpoints: ReadonlyMap<string, PlatformAdapter>,
    normalized?: NormalizedConfigModel,
  ) {
    const alerts = config.alerts;
    const adapters = new Map(endpoints);
    this.cooldownMs = alerts?.cooldown_ms ?? 600_000;
    const configuredTarget = normalized?.alertsTarget;
    const endpoint = configuredTarget
      ? normalized.endpoints.find(
          (candidate) => candidate.id === configuredTarget.endpointId,
        )
      : null;
    if (configuredTarget && endpoint) {
      this.deliveryAdapter = adapters.get(endpoint.id) ?? null;
      this.target = {
        platform: endpoint.platform,
        communityId: endpoint.communityId,
        endpointId: endpoint.id,
        channelId: configuredTarget.externalConversationId,
        threadRootId: null,
        workflowRunId: null,
        type: endpoint.platform === "buzz" ? "stream" : "direct",
      };
    } else {
      this.deliveryAdapter = alerts?.via_bot
        ? (adapters.get(alerts.via_bot) ?? null)
        : null;
      this.target =
        this.deliveryAdapter && alerts?.chat_id !== undefined
          ? telegramConversation(
              this.deliveryAdapter.endpoint.id,
              alerts.chat_id,
            )
          : null;
    }
  }

  private shouldAlert(key: string): boolean {
    const now = Date.now();
    const last = this.cooldowns.get(key) ?? 0;
    if (now - last < this.cooldownMs) return false;
    this.cooldowns.set(key, now);
    return true;
  }

  private async emit(
    kind: AlertKind,
    botId: BotId | null,
    text: string,
  ): Promise<void> {
    const key = `${kind}:${botId ?? "_"}`;
    if (!this.shouldAlert(key)) return;

    // Redact secrets out of caller-supplied alert text. Most alert callers
    // interpolate runner reasons or Telegram error descriptions (e.g.
    // setWebhook failures echo URL fragments containing the bot token).
    // Mirrors the rc.7 fix `c8dd3a9` for runner stdout/stderr — alerts
    // were the gap that fix didn't cover.
    const redacted = redactString(text);

    if (!this.deliveryAdapter || !this.target) {
      log.warn(`alert: ${redacted}`, { alert_kind: kind, bot_id: botId });
      return;
    }
    try {
      const result = await this.deliveryAdapter.deliver(this.target, {
        kind: "send",
        text: redacted,
        files: [],
      });
      // sendMessage swallows Telegram errors and returns {ok:false,...}.
      // The catch block below would never fire on Telegram-side failures;
      // check the result explicitly so a failed alert isn't silently
      // logged as "alert sent".
      if (result.ok) {
        log.info("alert sent", { alert_kind: kind, bot_id: botId });
      } else {
        log.warn("alert send failed", {
          alert_kind: kind,
          bot_id: botId,
          retriable: result.retriable,
          description: result.description,
        });
      }
    } catch (err) {
      // Reachable only if sendMessage itself throws — current impl
      // catches internally, but keep this defensively in case that
      // contract changes.
      log.error("alert send threw", {
        alert_kind: kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async workerDegraded(botId: BotId, reason: string): Promise<void> {
    await this.emit(
      "workerDegraded",
      botId,
      `⚠️ bot ${botId} degraded: ${reason}`,
    );
  }

  async workerCrashLoop(botId: BotId, failures: number): Promise<void> {
    await this.emit(
      "workerCrashLoop",
      botId,
      `⚠️ bot ${botId} crash loop: ${failures} consecutive failures`,
    );
  }

  async tokenInvalid(botId: BotId): Promise<void> {
    await this.emit(
      "tokenInvalid",
      botId,
      `🚨 bot ${botId} token invalid (401). Disabled.`,
    );
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

  async loopBudgetRejected(
    botId: BotId,
    scope: "conversation" | "endpoint",
  ): Promise<void> {
    await this.emit(
      "loopBudgetRejected",
      botId,
      `⚠️ agent ${botId}: Buzz reply suppressed by ${scope} loop budget`,
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
