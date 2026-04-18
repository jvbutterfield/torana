// Per-bot in-memory counters and timers. Pre-initialized from the resolved
// config's bots[] so no lazy-create branches are needed — events referencing
// an unknown bot id indicate a bug.

import type { BotId, Config } from "./config/schema.js";

export interface BotCounters {
  inbound_received: number;
  inbound_deduped: number;
  turns_queued: number;
  turns_dispatched: number;
  turns_completed: number;
  turns_failed: number;
  worker_restarts: number;
  worker_startup_failures: number;
  telegram_send_failures: number;
  telegram_edit_failures: number;
}

export interface BotTimers {
  last_ack_latency_ms: number | null;
  last_queue_wait_ms: number | null;
  last_first_output_latency_ms: number | null;
  last_turn_duration_ms: number | null;
  last_restart_recovery_ms: number | null;
}

export interface TelegramApiCounters {
  "2xx": number;
  "4xx": number;
  "5xx": number;
  network_err: number;
}

function zeroCounters(): BotCounters {
  return {
    inbound_received: 0,
    inbound_deduped: 0,
    turns_queued: 0,
    turns_dispatched: 0,
    turns_completed: 0,
    turns_failed: 0,
    worker_restarts: 0,
    worker_startup_failures: 0,
    telegram_send_failures: 0,
    telegram_edit_failures: 0,
  };
}

function zeroTimers(): BotTimers {
  return {
    last_ack_latency_ms: null,
    last_queue_wait_ms: null,
    last_first_output_latency_ms: null,
    last_turn_duration_ms: null,
    last_restart_recovery_ms: null,
  };
}

export class Metrics {
  private counters = new Map<BotId, BotCounters>();
  private timers = new Map<BotId, BotTimers>();
  private telegramCounters: TelegramApiCounters = {
    "2xx": 0,
    "4xx": 0,
    "5xx": 0,
    network_err: 0,
  };
  private startTime = Date.now();

  constructor(config: Config) {
    for (const bot of config.bots) {
      this.counters.set(bot.id, zeroCounters());
      this.timers.set(bot.id, zeroTimers());
    }
  }

  inc(botId: BotId, counter: keyof BotCounters, amount = 1): void {
    const c = this.counters.get(botId);
    if (c) c[counter] += amount;
  }

  recordTimer(botId: BotId, timer: keyof BotTimers, valueMs: number): void {
    const t = this.timers.get(botId);
    if (t) (t[timer] as number | null) = valueMs;
  }

  recordTelegramCall(bucket: keyof TelegramApiCounters): void {
    this.telegramCounters[bucket] += 1;
  }

  snapshot(): Record<BotId, { counters: BotCounters; timers: BotTimers }> {
    const result: Record<BotId, { counters: BotCounters; timers: BotTimers }> = {};
    for (const [botId, counters] of this.counters) {
      result[botId] = {
        counters: { ...counters },
        timers: { ...this.timers.get(botId)! },
      };
    }
    return result;
  }

  uptimeMs(): number {
    return Date.now() - this.startTime;
  }

  uptimeSecs(): number {
    return Math.floor(this.uptimeMs() / 1000);
  }

  /** Prometheus text-exposition format. */
  renderPrometheus(botStates: Record<BotId, number>): string {
    const lines: string[] = [];
    lines.push("# HELP gateway_uptime_secs Seconds since gateway process start.");
    lines.push("# TYPE gateway_uptime_secs gauge");
    lines.push(`gateway_uptime_secs ${this.uptimeSecs()}`);

    lines.push("# HELP turns_total Turns by terminal status.");
    lines.push("# TYPE turns_total counter");
    for (const [botId, c] of this.counters) {
      lines.push(`turns_total{bot_id="${botId}",status="completed"} ${c.turns_completed}`);
      lines.push(`turns_total{bot_id="${botId}",status="failed"} ${c.turns_failed}`);
    }

    lines.push("# HELP bot_state Current bot lifecycle state.");
    lines.push("# TYPE bot_state gauge");
    for (const [botId, s] of Object.entries(botStates)) {
      lines.push(`bot_state{bot_id="${botId}"} ${s}`);
    }

    lines.push("# HELP outbox_depth Pending outbox rows per bot.");
    lines.push("# TYPE outbox_depth gauge");
    // outbox depth is computed at scrape time by caller; metrics.ts doesn't own the DB.

    lines.push("# HELP outbox_attempts_total Outbox delivery attempts by result.");
    lines.push("# TYPE outbox_attempts_total counter");
    for (const [botId, c] of this.counters) {
      const sent = c.turns_completed + c.turns_dispatched; // rough proxy; accurate bookkeeping in db.
      lines.push(`outbox_attempts_total{bot_id="${botId}",result="sent"} ${sent}`);
      lines.push(
        `outbox_attempts_total{bot_id="${botId}",result="retry"} ${c.telegram_send_failures + c.telegram_edit_failures}`,
      );
    }

    lines.push("# HELP telegram_api_calls_total Outbound Telegram API calls by HTTP class.");
    lines.push("# TYPE telegram_api_calls_total counter");
    for (const [bucket, v] of Object.entries(this.telegramCounters)) {
      lines.push(`telegram_api_calls_total{status="${bucket}"} ${v}`);
    }

    return lines.join("\n") + "\n";
  }
}
