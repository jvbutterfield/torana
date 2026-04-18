import { logger } from "./log.js";
import type { Config, PersonaName } from "./config.js";
import type { TelegramClient } from "./telegram.js";

const log = logger("alerts");

/**
 * Gateway-level Telegram alerts. Sends operational alerts to Jason's chat
 * via each persona's own bot token (same pattern as the old pty_wrapper watchdog).
 *
 * Alert dedup: each alert type per persona has a cooldown to avoid spam.
 */
export class AlertManager {
  private config: Config;
  private clients: Map<PersonaName, TelegramClient>;
  private chatId: number;
  private cooldowns = new Map<string, number>(); // key → timestamp of last alert
  private cooldownMs: number;

  constructor(
    config: Config,
    clients: Map<PersonaName, TelegramClient>,
    cooldownMs = 600_000, // 10 min default cooldown per alert type
  ) {
    this.config = config;
    this.clients = clients;
    this.chatId = parseInt(config.allowedUserId, 10);
    this.cooldownMs = cooldownMs;
  }

  private shouldAlert(key: string): boolean {
    const now = Date.now();
    const last = this.cooldowns.get(key) ?? 0;
    if (now - last < this.cooldownMs) return false;
    this.cooldowns.set(key, now);
    return true;
  }

  private async send(persona: PersonaName, text: string) {
    const client = this.clients.get(persona);
    if (!client) {
      log.error("no client for alert", { persona });
      return;
    }
    try {
      await client.sendMessage(this.chatId, text);
      log.info("alert sent", { persona, text: text.slice(0, 80) });
    } catch (err) {
      log.error("alert send failed", { persona, error: String(err) });
    }
  }

  async workerDegraded(persona: PersonaName, reason: string) {
    if (!this.shouldAlert(`degraded:${persona}`)) return;
    await this.send(persona, `⚠️ Worker degraded: ${reason}`);
  }

  async workerCrashLoop(persona: PersonaName, failures: number) {
    if (!this.shouldAlert(`crashloop:${persona}`)) return;
    await this.send(persona, `⚠️ Worker crash loop — ${failures} consecutive failures. Retrying with backoff.`);
  }

  async allWorkersAuthFailure() {
    // Send via first available client
    const persona = this.clients.keys().next().value;
    if (!persona || !this.shouldAlert("auth:all")) return;
    await this.send(persona, `🚨 All workers failing with auth errors — check CLAUDE_CODE_OAUTH_TOKEN.`);
  }

  async mailboxBacklog(persona: PersonaName, depth: number) {
    if (!this.shouldAlert(`backlog:${persona}`)) return;
    await this.send(persona, `⚠️ Mailbox backlog: ${depth} queued turns.`);
  }

  async outboxFailures(persona: PersonaName, count: number) {
    if (!this.shouldAlert(`outbox:${persona}`)) return;
    await this.send(persona, `⚠️ ${count} outbox deliveries failed. Check Telegram Bot API.`);
  }

  async turnStalled(persona: PersonaName, turnId: number) {
    if (!this.shouldAlert(`stall:${persona}`)) return;
    await this.send(persona, `⚠️ Turn ${turnId} stalled — no worker output. Checking health...`);
  }
}
