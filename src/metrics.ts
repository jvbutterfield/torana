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

/**
 * Agent-API request/outcome counters, per bot. All counters are monotonic;
 * rates are derived at scrape time by Prometheus.
 */
export interface AgentApiCounters {
  ask_requests_total: number;
  ask_requests_2xx: number;
  ask_requests_4xx: number;
  ask_requests_5xx: number;
  /** 202 responses where the ask handler handed off to the orphan listener. */
  ask_timeouts_total: number;
  inject_requests_total: number;
  inject_requests_2xx: number;
  inject_requests_4xx: number;
  inject_requests_5xx: number;
  inject_idempotent_replays_total: number;
  side_sessions_started_total: number;
  side_session_evictions_idle: number;
  side_session_evictions_hard: number;
  side_session_evictions_lru: number;
  side_session_capacity_rejected_total: number;
  /**
   * Terminal-event outcomes for asks that were handed off to the orphan
   * listener on a 202 timeout (ask_timeouts_total counts the handoff
   * itself; these four count the *eventual* outcome). Together they
   * answer "for my 202 asks, how often did the runner actually finish
   * cleanly vs. fail vs. get force-released at the 1h backstop?"
   */
  ask_orphan_resolutions_done: number;
  ask_orphan_resolutions_error: number;
  ask_orphan_resolutions_fatal: number;
  ask_orphan_resolutions_backstop: number;
}

export interface AgentApiGauges {
  side_sessions_live: number;
}

/**
 * Minimal Prometheus-style histogram. Observations go into bucket[i] when
 * `value <= buckets[i]`. `_count` is the total observation count; the `+Inf`
 * bucket line is emitted at scrape time as `_count`.
 */
export interface HistogramState {
  /** Upper bounds in ascending order, excluding +Inf. */
  buckets: number[];
  /** count[i] = # observations with value <= buckets[i]; length matches buckets. */
  counts: number[];
  sum: number;
  count: number;
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

function zeroAgentApiCounters(): AgentApiCounters {
  return {
    ask_requests_total: 0,
    ask_requests_2xx: 0,
    ask_requests_4xx: 0,
    ask_requests_5xx: 0,
    ask_timeouts_total: 0,
    inject_requests_total: 0,
    inject_requests_2xx: 0,
    inject_requests_4xx: 0,
    inject_requests_5xx: 0,
    inject_idempotent_replays_total: 0,
    side_sessions_started_total: 0,
    side_session_evictions_idle: 0,
    side_session_evictions_hard: 0,
    side_session_evictions_lru: 0,
    side_session_capacity_rejected_total: 0,
    ask_orphan_resolutions_done: 0,
    ask_orphan_resolutions_error: 0,
    ask_orphan_resolutions_fatal: 0,
    ask_orphan_resolutions_backstop: 0,
  };
}

function zeroAgentApiGauges(): AgentApiGauges {
  return { side_sessions_live: 0 };
}

// Bucket sequences are duration-in-milliseconds. Both series use the same
// sequence so the histogram cardinality stays predictable for operators.
// Exported so `docs/agent-api.md` can be pinned to the live value via a
// unit test (see `test/docs/agent-api.test.ts`).
export const DURATION_BUCKETS_MS = [
  50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000,
] as const;

function zeroHistogram(): HistogramState {
  return {
    buckets: [...DURATION_BUCKETS_MS],
    counts: DURATION_BUCKETS_MS.map(() => 0),
    sum: 0,
    count: 0,
  };
}

function observe(h: HistogramState, v: number): void {
  if (!Number.isFinite(v) || v < 0) return;
  h.sum += v;
  h.count += 1;
  for (let i = 0; i < h.buckets.length; i++) {
    if (v <= h.buckets[i]!) h.counts[i]! += 1;
  }
}

export type AcquireOutcome = "reuse" | "spawn" | "capacity" | "busy";
export type AskRoute = "ask" | "inject";
export type EvictionReason = "idle" | "hard" | "lru";

export class Metrics {
  private counters = new Map<BotId, BotCounters>();
  private timers = new Map<BotId, BotTimers>();
  private telegramCounters: TelegramApiCounters = {
    "2xx": 0,
    "4xx": 0,
    "5xx": 0,
    network_err: 0,
  };
  private agentApi = new Map<BotId, AgentApiCounters>();
  private agentApiGauges = new Map<BotId, AgentApiGauges>();
  // Per-bot per-route request duration histograms, keyed by `${botId}\u0000${route}`.
  private agentApiRequestHistograms = new Map<string, HistogramState>();
  // Per-bot per-outcome pool acquire duration histograms.
  private agentApiAcquireHistograms = new Map<string, HistogramState>();
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

  /**
   * Lazy-initialize agent-api counters + gauges for a bot. Called on first
   * access — the constructor doesn't touch them so disabled agent-api stays
   * zero-allocation on the hot path.
   */
  initAgentApi(botId: BotId): void {
    if (!this.agentApi.has(botId)) this.agentApi.set(botId, zeroAgentApiCounters());
    if (!this.agentApiGauges.has(botId)) this.agentApiGauges.set(botId, zeroAgentApiGauges());
  }

  incAgentApi(botId: BotId, counter: keyof AgentApiCounters, amount = 1): void {
    this.initAgentApi(botId);
    const c = this.agentApi.get(botId)!;
    c[counter] += amount;
  }

  setAgentApiGauge(
    botId: BotId,
    gauge: keyof AgentApiGauges,
    value: number,
  ): void {
    this.initAgentApi(botId);
    this.agentApiGauges.get(botId)![gauge] = value;
  }

  observeAgentApiRequestDuration(
    botId: BotId,
    route: AskRoute,
    ms: number,
  ): void {
    this.initAgentApi(botId);
    const key = `${botId}\u0000${route}`;
    let h = this.agentApiRequestHistograms.get(key);
    if (!h) {
      h = zeroHistogram();
      this.agentApiRequestHistograms.set(key, h);
    }
    observe(h, ms);
  }

  observeAgentApiAcquireDuration(
    botId: BotId,
    outcome: AcquireOutcome,
    ms: number,
  ): void {
    this.initAgentApi(botId);
    const key = `${botId}\u0000${outcome}`;
    let h = this.agentApiAcquireHistograms.get(key);
    if (!h) {
      h = zeroHistogram();
      this.agentApiAcquireHistograms.set(key, h);
    }
    observe(h, ms);
  }

  /** Test-only snapshot of agent-api state. */
  agentApiSnapshot(): Record<
    BotId,
    { counters: AgentApiCounters; gauges: AgentApiGauges }
  > {
    const out: Record<BotId, { counters: AgentApiCounters; gauges: AgentApiGauges }> = {};
    for (const [botId, counters] of this.agentApi) {
      out[botId] = {
        counters: { ...counters },
        gauges: { ...(this.agentApiGauges.get(botId) ?? zeroAgentApiGauges()) },
      };
    }
    return out;
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

    if (this.agentApi.size > 0) {
      lines.push(
        "# HELP torana_agent_api_requests_total Agent API request count by bot, mode, outcome.",
      );
      lines.push("# TYPE torana_agent_api_requests_total counter");
      for (const [botId, c] of this.agentApi) {
        lines.push(
          `torana_agent_api_requests_total{bot_id="${botId}",mode="ask",outcome="2xx"} ${c.ask_requests_2xx}`,
        );
        lines.push(
          `torana_agent_api_requests_total{bot_id="${botId}",mode="ask",outcome="4xx"} ${c.ask_requests_4xx}`,
        );
        lines.push(
          `torana_agent_api_requests_total{bot_id="${botId}",mode="ask",outcome="5xx"} ${c.ask_requests_5xx}`,
        );
        lines.push(
          `torana_agent_api_requests_total{bot_id="${botId}",mode="ask",outcome="timeout"} ${c.ask_timeouts_total}`,
        );
        lines.push(
          `torana_agent_api_requests_total{bot_id="${botId}",mode="inject",outcome="2xx"} ${c.inject_requests_2xx}`,
        );
        lines.push(
          `torana_agent_api_requests_total{bot_id="${botId}",mode="inject",outcome="4xx"} ${c.inject_requests_4xx}`,
        );
        lines.push(
          `torana_agent_api_requests_total{bot_id="${botId}",mode="inject",outcome="5xx"} ${c.inject_requests_5xx}`,
        );
      }

      lines.push(
        "# HELP torana_agent_api_inject_idempotent_replays_total Inject requests served from the idempotency cache.",
      );
      lines.push("# TYPE torana_agent_api_inject_idempotent_replays_total counter");
      for (const [botId, c] of this.agentApi) {
        lines.push(
          `torana_agent_api_inject_idempotent_replays_total{bot_id="${botId}"} ${c.inject_idempotent_replays_total}`,
        );
      }

      lines.push(
        "# HELP torana_agent_api_side_sessions_started_total Side-session subprocess spawns.",
      );
      lines.push("# TYPE torana_agent_api_side_sessions_started_total counter");
      for (const [botId, c] of this.agentApi) {
        lines.push(
          `torana_agent_api_side_sessions_started_total{bot_id="${botId}"} ${c.side_sessions_started_total}`,
        );
      }

      lines.push(
        "# HELP torana_agent_api_side_session_evictions_total Side-session evictions by reason.",
      );
      lines.push("# TYPE torana_agent_api_side_session_evictions_total counter");
      for (const [botId, c] of this.agentApi) {
        lines.push(
          `torana_agent_api_side_session_evictions_total{bot_id="${botId}",reason="idle"} ${c.side_session_evictions_idle}`,
        );
        lines.push(
          `torana_agent_api_side_session_evictions_total{bot_id="${botId}",reason="hard"} ${c.side_session_evictions_hard}`,
        );
        lines.push(
          `torana_agent_api_side_session_evictions_total{bot_id="${botId}",reason="lru"} ${c.side_session_evictions_lru}`,
        );
      }

      lines.push(
        "# HELP torana_agent_api_side_session_capacity_rejected_total Acquire attempts rejected for capacity.",
      );
      lines.push("# TYPE torana_agent_api_side_session_capacity_rejected_total counter");
      for (const [botId, c] of this.agentApi) {
        lines.push(
          `torana_agent_api_side_session_capacity_rejected_total{bot_id="${botId}"} ${c.side_session_capacity_rejected_total}`,
        );
      }

      lines.push(
        "# HELP torana_agent_api_ask_orphan_resolutions_total Terminal outcomes for asks that were 202-handed-off to the orphan listener.",
      );
      lines.push("# TYPE torana_agent_api_ask_orphan_resolutions_total counter");
      for (const [botId, c] of this.agentApi) {
        lines.push(
          `torana_agent_api_ask_orphan_resolutions_total{bot_id="${botId}",outcome="done"} ${c.ask_orphan_resolutions_done}`,
        );
        lines.push(
          `torana_agent_api_ask_orphan_resolutions_total{bot_id="${botId}",outcome="error"} ${c.ask_orphan_resolutions_error}`,
        );
        lines.push(
          `torana_agent_api_ask_orphan_resolutions_total{bot_id="${botId}",outcome="fatal"} ${c.ask_orphan_resolutions_fatal}`,
        );
        lines.push(
          `torana_agent_api_ask_orphan_resolutions_total{bot_id="${botId}",outcome="backstop"} ${c.ask_orphan_resolutions_backstop}`,
        );
      }

      lines.push(
        "# HELP torana_agent_api_side_sessions_live Current live side-session count.",
      );
      lines.push("# TYPE torana_agent_api_side_sessions_live gauge");
      for (const [botId, g] of this.agentApiGauges) {
        lines.push(
          `torana_agent_api_side_sessions_live{bot_id="${botId}"} ${g.side_sessions_live}`,
        );
      }
    }

    if (this.agentApiRequestHistograms.size > 0) {
      lines.push(
        "# HELP torana_agent_api_request_duration_ms Agent API request duration by bot + route.",
      );
      lines.push("# TYPE torana_agent_api_request_duration_ms histogram");
      for (const [key, h] of this.agentApiRequestHistograms) {
        const [botId, route] = key.split("\u0000");
        for (let i = 0; i < h.buckets.length; i++) {
          lines.push(
            `torana_agent_api_request_duration_ms_bucket{bot_id="${botId}",route="${route}",le="${h.buckets[i]}"} ${h.counts[i]}`,
          );
        }
        lines.push(
          `torana_agent_api_request_duration_ms_bucket{bot_id="${botId}",route="${route}",le="+Inf"} ${h.count}`,
        );
        lines.push(
          `torana_agent_api_request_duration_ms_sum{bot_id="${botId}",route="${route}"} ${h.sum}`,
        );
        lines.push(
          `torana_agent_api_request_duration_ms_count{bot_id="${botId}",route="${route}"} ${h.count}`,
        );
      }
    }

    if (this.agentApiAcquireHistograms.size > 0) {
      lines.push(
        "# HELP torana_agent_api_side_session_acquire_duration_ms Pool acquire duration by bot + outcome.",
      );
      lines.push("# TYPE torana_agent_api_side_session_acquire_duration_ms histogram");
      for (const [key, h] of this.agentApiAcquireHistograms) {
        const [botId, outcome] = key.split("\u0000");
        for (let i = 0; i < h.buckets.length; i++) {
          lines.push(
            `torana_agent_api_side_session_acquire_duration_ms_bucket{bot_id="${botId}",outcome="${outcome}",le="${h.buckets[i]}"} ${h.counts[i]}`,
          );
        }
        lines.push(
          `torana_agent_api_side_session_acquire_duration_ms_bucket{bot_id="${botId}",outcome="${outcome}",le="+Inf"} ${h.count}`,
        );
        lines.push(
          `torana_agent_api_side_session_acquire_duration_ms_sum{bot_id="${botId}",outcome="${outcome}"} ${h.sum}`,
        );
        lines.push(
          `torana_agent_api_side_session_acquire_duration_ms_count{bot_id="${botId}",outcome="${outcome}"} ${h.count}`,
        );
      }
    }

    return lines.join("\n") + "\n";
  }
}
