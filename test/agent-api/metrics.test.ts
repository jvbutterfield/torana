// Unit tests for src/agent-api/metrics.ts — the typed façade that handler
// + pool code call instead of touching the Metrics class directly.

import { describe, expect, test } from "bun:test";

import { Metrics } from "../../src/metrics.js";
import {
  recordAsk,
  recordSend,
  recordAcquire,
  recordEviction,
  recordOrphanResolution,
  setSideSessionsLive,
} from "../../src/agent-api/metrics.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

function makeMetrics(botIds: string[] = ["alpha"]): Metrics {
  return new Metrics(makeTestConfig(botIds.map((id) => makeTestBotConfig(id))));
}

describe("recordAsk", () => {
  test("200 → ask_requests_2xx, no timeout", () => {
    const m = makeMetrics();
    recordAsk(m, "alpha", { status: 200, durationMs: 42 });
    const snap = m.agentApiSnapshot().alpha.counters;
    expect(snap.ask_requests_total).toBe(1);
    expect(snap.ask_requests_2xx).toBe(1);
    expect(snap.ask_timeouts_total).toBe(0);
  });

  test("202 → ask_requests_2xx AND ask_timeouts_total (both)", () => {
    const m = makeMetrics();
    recordAsk(m, "alpha", { status: 202, durationMs: 100 });
    const snap = m.agentApiSnapshot().alpha.counters;
    expect(snap.ask_requests_2xx).toBe(1);
    expect(snap.ask_timeouts_total).toBe(1);
    expect(snap.ask_requests_total).toBe(1);
  });

  test("400 → 4xx bucket; 429 → 4xx bucket; 503 → 5xx bucket", () => {
    const m = makeMetrics();
    recordAsk(m, "alpha", { status: 400, durationMs: 1 });
    recordAsk(m, "alpha", { status: 429, durationMs: 1 });
    recordAsk(m, "alpha", { status: 503, durationMs: 1 });
    const snap = m.agentApiSnapshot().alpha.counters;
    expect(snap.ask_requests_4xx).toBe(2);
    expect(snap.ask_requests_5xx).toBe(1);
  });

  test("duration is observed on the ask histogram", () => {
    const m = makeMetrics();
    recordAsk(m, "alpha", { status: 200, durationMs: 123 });
    const body = m.renderPrometheus({ alpha: 2 });
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_count{bot_id="alpha",route="ask"} 1',
    );
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_sum{bot_id="alpha",route="ask"} 123',
    );
  });

  test("undefined metrics is a no-op (no throw)", () => {
    recordAsk(undefined, "alpha", { status: 200, durationMs: 1 });
  });
});

describe("recordSend", () => {
  test("202 without replay → send_requests_2xx only", () => {
    const m = makeMetrics();
    recordSend(m, "alpha", { status: 202, replay: false, durationMs: 5 });
    const snap = m.agentApiSnapshot().alpha.counters;
    expect(snap.send_requests_total).toBe(1);
    expect(snap.send_requests_2xx).toBe(1);
    expect(snap.send_idempotent_replays_total).toBe(0);
  });

  test("202 with replay → 2xx + replay counter", () => {
    const m = makeMetrics();
    recordSend(m, "alpha", { status: 202, replay: true, durationMs: 3 });
    const snap = m.agentApiSnapshot().alpha.counters;
    expect(snap.send_requests_2xx).toBe(1);
    expect(snap.send_idempotent_replays_total).toBe(1);
  });

  test("4xx / 5xx status paths don't increment replay counter", () => {
    const m = makeMetrics();
    recordSend(m, "alpha", { status: 400, durationMs: 1 });
    recordSend(m, "alpha", { status: 503, durationMs: 1 });
    const snap = m.agentApiSnapshot().alpha.counters;
    expect(snap.send_requests_4xx).toBe(1);
    expect(snap.send_requests_5xx).toBe(1);
    expect(snap.send_idempotent_replays_total).toBe(0);
  });

  test("duration observed on send histogram (not ask)", () => {
    const m = makeMetrics();
    recordSend(m, "alpha", { status: 202, replay: false, durationMs: 77 });
    const body = m.renderPrometheus({ alpha: 2 });
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_count{bot_id="alpha",route="send"} 1',
    );
    expect(body).not.toContain(
      'torana_agent_api_request_duration_ms_count{bot_id="alpha",route="ask"} 1',
    );
  });
});

describe("recordAcquire", () => {
  test("spawn outcome increments side_sessions_started_total + histogram", () => {
    const m = makeMetrics();
    recordAcquire(m, "alpha", "spawn", 50);
    const snap = m.agentApiSnapshot().alpha.counters;
    expect(snap.side_sessions_started_total).toBe(1);
    const body = m.renderPrometheus({ alpha: 2 });
    expect(body).toContain(
      'torana_agent_api_side_session_acquire_duration_ms_count{bot_id="alpha",outcome="spawn"} 1',
    );
  });

  test("capacity outcome increments side_session_capacity_rejected_total", () => {
    const m = makeMetrics();
    recordAcquire(m, "alpha", "capacity", 1);
    expect(
      m.agentApiSnapshot().alpha.counters.side_session_capacity_rejected_total,
    ).toBe(1);
  });

  test("reuse + busy outcomes observe histogram but don't touch counters", () => {
    const m = makeMetrics();
    recordAcquire(m, "alpha", "reuse", 5);
    recordAcquire(m, "alpha", "busy", 5);
    const snap = m.agentApiSnapshot().alpha.counters;
    expect(snap.side_sessions_started_total).toBe(0);
    expect(snap.side_session_capacity_rejected_total).toBe(0);
    const body = m.renderPrometheus({ alpha: 2 });
    expect(body).toContain(
      'torana_agent_api_side_session_acquire_duration_ms_count{bot_id="alpha",outcome="reuse"} 1',
    );
    expect(body).toContain(
      'torana_agent_api_side_session_acquire_duration_ms_count{bot_id="alpha",outcome="busy"} 1',
    );
  });
});

describe("recordEviction + setSideSessionsLive", () => {
  test("eviction reason routes to the matching counter", () => {
    const m = makeMetrics();
    recordEviction(m, "alpha", "idle");
    recordEviction(m, "alpha", "hard");
    recordEviction(m, "alpha", "lru");
    recordEviction(m, "alpha", "lru");
    const snap = m.agentApiSnapshot().alpha.counters;
    expect(snap.side_session_evictions_idle).toBe(1);
    expect(snap.side_session_evictions_hard).toBe(1);
    expect(snap.side_session_evictions_lru).toBe(2);
  });

  test("setSideSessionsLive updates the per-bot gauge", () => {
    const m = makeMetrics(["alpha", "beta"]);
    setSideSessionsLive(m, "alpha", 3);
    setSideSessionsLive(m, "beta", 1);
    const snap = m.agentApiSnapshot();
    expect(snap.alpha.gauges.side_sessions_live).toBe(3);
    expect(snap.beta.gauges.side_sessions_live).toBe(1);
    setSideSessionsLive(m, "alpha", 0);
    expect(m.agentApiSnapshot().alpha.gauges.side_sessions_live).toBe(0);
  });

  test("every façade function no-ops when metrics is undefined", () => {
    recordAsk(undefined, "alpha", { status: 200, durationMs: 1 });
    recordSend(undefined, "alpha", {
      status: 202,
      replay: false,
      durationMs: 1,
    });
    recordAcquire(undefined, "alpha", "spawn", 1);
    recordEviction(undefined, "alpha", "idle");
    recordOrphanResolution(undefined, "alpha", "done");
    setSideSessionsLive(undefined, "alpha", 1);
    // No assertion needed — just mustn't throw.
  });
});

describe("recordOrphanResolution", () => {
  test("routes each outcome to the matching counter", () => {
    const m = makeMetrics();
    recordOrphanResolution(m, "alpha", "done");
    recordOrphanResolution(m, "alpha", "done");
    recordOrphanResolution(m, "alpha", "error");
    recordOrphanResolution(m, "alpha", "fatal");
    recordOrphanResolution(m, "alpha", "backstop");
    const c = m.agentApiSnapshot().alpha.counters;
    expect(c.ask_orphan_resolutions_done).toBe(2);
    expect(c.ask_orphan_resolutions_error).toBe(1);
    expect(c.ask_orphan_resolutions_fatal).toBe(1);
    expect(c.ask_orphan_resolutions_backstop).toBe(1);
  });
});
