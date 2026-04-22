// Thin typed façade over Metrics for agent-api call sites. Handlers and the
// pool call the functions here rather than the Metrics setters directly so:
//   - route-bucket mapping (2xx / 4xx / 5xx) lives in one place,
//   - gauge + histogram invariants can be enforced in one place,
//   - tests can stub this file to verify call-site coverage without owning
//     the concrete Metrics instance.
//
// Every call is a no-op when the passed `metrics` is undefined (agent_api
// disabled path — main.ts gates construction but handlers don't know that).

import type {
  AcquireOutcome,
  AskRoute,
  EvictionReason,
  Metrics,
} from "../metrics.js";

export type AskOutcome =
  | { status: 200; durationMs: number }
  | { status: 202; durationMs: number }    // timeout → orphan handoff
  | { status: 400 | 401 | 403 | 404; durationMs: number }
  | { status: 429 | 500 | 501 | 503; durationMs: number };

export type SendOutcome =
  | { status: 202; replay: boolean; durationMs: number }
  | { status: 400 | 401 | 403 | 404; durationMs: number }
  | { status: 429 | 500 | 501 | 503; durationMs: number };

/**
 * Record an ask request — HTTP status mapped to 2xx/4xx/5xx/timeout bucket
 * plus a duration observation on the per-bot per-route histogram.
 */
export function recordAsk(
  metrics: Metrics | undefined,
  botId: string,
  outcome: AskOutcome,
): void {
  if (!metrics) return;
  metrics.incAgentApi(botId, "ask_requests_total");
  const status = outcome.status;
  if (status === 200) {
    metrics.incAgentApi(botId, "ask_requests_2xx");
  } else if (status === 202) {
    metrics.incAgentApi(botId, "ask_requests_2xx");
    metrics.incAgentApi(botId, "ask_timeouts_total");
  } else if (status >= 400 && status < 500) {
    metrics.incAgentApi(botId, "ask_requests_4xx");
  } else {
    metrics.incAgentApi(botId, "ask_requests_5xx");
  }
  metrics.observeAgentApiRequestDuration(botId, "ask" as AskRoute, outcome.durationMs);
}

/**
 * Record a send request. Replay hits are counted separately so operators
 * can alert on sudden spikes independent of real traffic volume.
 */
export function recordSend(
  metrics: Metrics | undefined,
  botId: string,
  outcome: SendOutcome,
): void {
  if (!metrics) return;
  metrics.incAgentApi(botId, "send_requests_total");
  const status = outcome.status;
  if (status >= 200 && status < 300) {
    metrics.incAgentApi(botId, "send_requests_2xx");
    if ("replay" in outcome && outcome.replay) {
      metrics.incAgentApi(botId, "send_idempotent_replays_total");
    }
  } else if (status >= 400 && status < 500) {
    metrics.incAgentApi(botId, "send_requests_4xx");
  } else {
    metrics.incAgentApi(botId, "send_requests_5xx");
  }
  metrics.observeAgentApiRequestDuration(botId, "send" as AskRoute, outcome.durationMs);
}

/** Record a pool acquire — outcome + observed duration. */
export function recordAcquire(
  metrics: Metrics | undefined,
  botId: string,
  outcome: AcquireOutcome,
  durationMs: number,
): void {
  if (!metrics) return;
  metrics.observeAgentApiAcquireDuration(botId, outcome, durationMs);
  if (outcome === "spawn") {
    metrics.incAgentApi(botId, "side_sessions_started_total");
  } else if (outcome === "capacity") {
    metrics.incAgentApi(botId, "side_session_capacity_rejected_total");
  }
}

/** Record a side-session eviction by reason. */
export function recordEviction(
  metrics: Metrics | undefined,
  botId: string,
  reason: EvictionReason,
): void {
  if (!metrics) return;
  switch (reason) {
    case "idle":
      metrics.incAgentApi(botId, "side_session_evictions_idle");
      break;
    case "hard":
      metrics.incAgentApi(botId, "side_session_evictions_hard");
      break;
    case "lru":
      metrics.incAgentApi(botId, "side_session_evictions_lru");
      break;
  }
}

/** Update the side_sessions_live gauge for a bot. */
export function setSideSessionsLive(
  metrics: Metrics | undefined,
  botId: string,
  count: number,
): void {
  if (!metrics) return;
  metrics.setAgentApiGauge(botId, "side_sessions_live", count);
}

export type OrphanResolution = "done" | "error" | "fatal" | "backstop";

/**
 * Record the terminal outcome of an ask that was handed off to the orphan
 * listener on 202. `ask_timeouts_total` (incremented at handoff time by
 * recordAsk) and these counters together tell operators: "of the asks
 * that timed out and got a 202, how did the runner eventually finish?"
 */
export function recordOrphanResolution(
  metrics: Metrics | undefined,
  botId: string,
  outcome: OrphanResolution,
): void {
  if (!metrics) return;
  switch (outcome) {
    case "done":
      metrics.incAgentApi(botId, "ask_orphan_resolutions_done");
      break;
    case "error":
      metrics.incAgentApi(botId, "ask_orphan_resolutions_error");
      break;
    case "fatal":
      metrics.incAgentApi(botId, "ask_orphan_resolutions_fatal");
      break;
    case "backstop":
      metrics.incAgentApi(botId, "ask_orphan_resolutions_backstop");
      break;
  }
}
