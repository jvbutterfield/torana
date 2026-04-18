import type { PersonaName } from "./config.js";
import { PERSONAS } from "./config.js";

/** In-memory counters and timers for gateway observability. */

interface PersonaCounters {
  inbound_received: number;
  inbound_deduped: number;
  turns_queued: number;
  turns_completed: number;
  turns_failed: number;
  worker_restarts: number;
  worker_startup_failures: number;
  telegram_send_failures: number;
  telegram_edit_failures: number;
}

interface PersonaTimers {
  /** Most recent webhook-receive → 👀 ack latency (ms) */
  last_ack_latency_ms: number | null;
  /** Most recent queue wait time (ms) */
  last_queue_wait_ms: number | null;
  /** Most recent turn start → first visible output (ms) */
  last_first_output_latency_ms: number | null;
  /** Most recent turn duration (ms) */
  last_turn_duration_ms: number | null;
  /** Most recent worker restart recovery time (ms) */
  last_restart_recovery_ms: number | null;
}

export class Metrics {
  private counters = new Map<PersonaName, PersonaCounters>();
  private timers = new Map<PersonaName, PersonaTimers>();
  private startTime = Date.now();

  constructor() {
    for (const p of PERSONAS) {
      this.counters.set(p, {
        inbound_received: 0,
        inbound_deduped: 0,
        turns_queued: 0,
        turns_completed: 0,
        turns_failed: 0,
        worker_restarts: 0,
        worker_startup_failures: 0,
        telegram_send_failures: 0,
        telegram_edit_failures: 0,
      });
      this.timers.set(p, {
        last_ack_latency_ms: null,
        last_queue_wait_ms: null,
        last_first_output_latency_ms: null,
        last_turn_duration_ms: null,
        last_restart_recovery_ms: null,
      });
    }
  }

  inc(persona: PersonaName, counter: keyof PersonaCounters, amount = 1) {
    const c = this.counters.get(persona);
    if (c) c[counter] += amount;
  }

  recordTimer(persona: PersonaName, timer: keyof PersonaTimers, valueMs: number) {
    const t = this.timers.get(persona);
    if (t) (t[timer] as number | null) = valueMs;
  }

  /** Snapshot for the /health endpoint. */
  snapshot(): Record<PersonaName, { counters: PersonaCounters; timers: PersonaTimers }> {
    const result: Record<string, any> = {};
    for (const p of PERSONAS) {
      result[p] = {
        counters: { ...this.counters.get(p)! },
        timers: { ...this.timers.get(p)! },
      };
    }
    return result as any;
  }

  uptimeMs(): number {
    return Date.now() - this.startTime;
  }
}
