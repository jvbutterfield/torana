// Unit tests for the agent-api side of `src/metrics.ts` — the counters,
// gauges, and duration histograms added in Phase 7 (US-015).

import { describe, expect, test } from "bun:test";

import { Metrics } from "../../src/metrics.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

function makeMetrics(botIds: string[] = ["alpha"]): Metrics {
  return new Metrics(makeTestConfig(botIds.map((id) => makeTestBotConfig(id))));
}

describe("Metrics — agent-api counters", () => {
  test("counters start uninitialized; initAgentApi materializes them", () => {
    const m = makeMetrics();
    // Before first init, snapshot is empty for agent-api.
    expect(Object.keys(m.agentApiSnapshot())).toEqual([]);
    m.initAgentApi("alpha");
    const snap = m.agentApiSnapshot();
    expect(Object.keys(snap)).toEqual(["alpha"]);
    expect(snap.alpha.counters.ask_requests_total).toBe(0);
    expect(snap.alpha.counters.send_idempotent_replays_total).toBe(0);
    expect(snap.alpha.gauges.side_sessions_live).toBe(0);
  });

  test("incAgentApi auto-inits and increments the named counter", () => {
    const m = makeMetrics();
    m.incAgentApi("alpha", "ask_requests_2xx");
    m.incAgentApi("alpha", "ask_requests_2xx", 3);
    m.incAgentApi("alpha", "ask_requests_5xx");
    const snap = m.agentApiSnapshot();
    expect(snap.alpha.counters.ask_requests_2xx).toBe(4);
    expect(snap.alpha.counters.ask_requests_5xx).toBe(1);
    expect(snap.alpha.counters.ask_requests_4xx).toBe(0);
  });

  test("counters are per-bot; cross-bot increments stay separate", () => {
    const m = makeMetrics(["alpha", "beta"]);
    m.incAgentApi("alpha", "send_idempotent_replays_total", 5);
    m.incAgentApi("beta", "send_idempotent_replays_total");
    const snap = m.agentApiSnapshot();
    expect(snap.alpha.counters.send_idempotent_replays_total).toBe(5);
    expect(snap.beta.counters.send_idempotent_replays_total).toBe(1);
  });

  test("setAgentApiGauge overwrites the prior value", () => {
    const m = makeMetrics();
    m.setAgentApiGauge("alpha", "side_sessions_live", 3);
    expect(m.agentApiSnapshot().alpha.gauges.side_sessions_live).toBe(3);
    m.setAgentApiGauge("alpha", "side_sessions_live", 1);
    expect(m.agentApiSnapshot().alpha.gauges.side_sessions_live).toBe(1);
    m.setAgentApiGauge("alpha", "side_sessions_live", 0);
    expect(m.agentApiSnapshot().alpha.gauges.side_sessions_live).toBe(0);
  });

  test("agentApiSnapshot returns deep copies — caller mutation doesn't leak", () => {
    const m = makeMetrics();
    m.incAgentApi("alpha", "ask_requests_total", 1);
    m.setAgentApiGauge("alpha", "side_sessions_live", 2);
    const snap = m.agentApiSnapshot();
    snap.alpha.counters.ask_requests_total = 999;
    snap.alpha.gauges.side_sessions_live = 999;
    const snap2 = m.agentApiSnapshot();
    expect(snap2.alpha.counters.ask_requests_total).toBe(1);
    expect(snap2.alpha.gauges.side_sessions_live).toBe(2);
  });
});

describe("Metrics — agent-api histograms", () => {
  test("observeAgentApiRequestDuration buckets monotonically", () => {
    const m = makeMetrics();
    // bucket sequence: 50,100,250,500,1000,2500,5000,10000,30000,60000
    m.observeAgentApiRequestDuration("alpha", "ask", 25);
    m.observeAgentApiRequestDuration("alpha", "ask", 200);
    m.observeAgentApiRequestDuration("alpha", "ask", 3000);
    const body = m.renderPrometheus({ alpha: 2 });
    // 25 ≤ 50 → falls into every bucket.
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_bucket{bot_id="alpha",route="ask",le="50"} 1',
    );
    // 25+200 ≤ 250 → 2.
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_bucket{bot_id="alpha",route="ask",le="250"} 2',
    );
    // 25+200+3000 ≤ 5000 → 3.
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_bucket{bot_id="alpha",route="ask",le="5000"} 3',
    );
    // +Inf bucket always equals count.
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_bucket{bot_id="alpha",route="ask",le="+Inf"} 3',
    );
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_sum{bot_id="alpha",route="ask"} 3225',
    );
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_count{bot_id="alpha",route="ask"} 3',
    );
  });

  test("ask and send histograms are distinct; cross-route pollution impossible", () => {
    const m = makeMetrics();
    m.observeAgentApiRequestDuration("alpha", "ask", 75);
    m.observeAgentApiRequestDuration("alpha", "send", 150);
    m.observeAgentApiRequestDuration("alpha", "send", 300);
    const body = m.renderPrometheus({ alpha: 2 });
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_count{bot_id="alpha",route="ask"} 1',
    );
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_count{bot_id="alpha",route="send"} 2',
    );
  });

  test("observeAgentApiAcquireDuration emits a separate histogram per outcome", () => {
    const m = makeMetrics();
    m.observeAgentApiAcquireDuration("alpha", "reuse", 2);
    m.observeAgentApiAcquireDuration("alpha", "spawn", 600);
    m.observeAgentApiAcquireDuration("alpha", "capacity", 1);
    m.observeAgentApiAcquireDuration("alpha", "busy", 1);
    const body = m.renderPrometheus({ alpha: 2 });
    expect(body).toContain(
      'torana_agent_api_side_session_acquire_duration_ms_count{bot_id="alpha",outcome="reuse"} 1',
    );
    expect(body).toContain(
      'torana_agent_api_side_session_acquire_duration_ms_count{bot_id="alpha",outcome="spawn"} 1',
    );
    expect(body).toContain(
      'torana_agent_api_side_session_acquire_duration_ms_count{bot_id="alpha",outcome="capacity"} 1',
    );
    expect(body).toContain(
      'torana_agent_api_side_session_acquire_duration_ms_count{bot_id="alpha",outcome="busy"} 1',
    );
    // spawn duration > 500 → le="500" bucket should be 0, le="1000" should be 1
    expect(body).toMatch(
      /torana_agent_api_side_session_acquire_duration_ms_bucket\{bot_id="alpha",outcome="spawn",le="500"\} 0/,
    );
    expect(body).toMatch(
      /torana_agent_api_side_session_acquire_duration_ms_bucket\{bot_id="alpha",outcome="spawn",le="1000"\} 1/,
    );
  });

  test("negative and non-finite observations are ignored (no NaN in sum)", () => {
    const m = makeMetrics();
    m.observeAgentApiRequestDuration("alpha", "ask", -5);
    m.observeAgentApiRequestDuration("alpha", "ask", Number.NaN);
    m.observeAgentApiRequestDuration("alpha", "ask", Number.POSITIVE_INFINITY);
    m.observeAgentApiRequestDuration("alpha", "ask", 100);
    const body = m.renderPrometheus({ alpha: 2 });
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_count{bot_id="alpha",route="ask"} 1',
    );
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_sum{bot_id="alpha",route="ask"} 100',
    );
  });

  test("observations above the top bucket still increment _count and _sum", () => {
    const m = makeMetrics();
    m.observeAgentApiRequestDuration("alpha", "ask", 120_000);
    const body = m.renderPrometheus({ alpha: 2 });
    // Not in any explicit bucket (all ≤ 60000 buckets have 0), but +Inf = 1.
    expect(body).toMatch(
      /torana_agent_api_request_duration_ms_bucket\{bot_id="alpha",route="ask",le="60000"\} 0/,
    );
    expect(body).toMatch(
      /torana_agent_api_request_duration_ms_bucket\{bot_id="alpha",route="ask",le="\+Inf"\} 1/,
    );
    expect(body).toContain(
      'torana_agent_api_request_duration_ms_sum{bot_id="alpha",route="ask"} 120000',
    );
  });
});

describe("Metrics — agent-api renderPrometheus", () => {
  test("empty agent-api state omits all torana_agent_api_* lines", () => {
    const m = makeMetrics();
    const body = m.renderPrometheus({ alpha: 2 });
    expect(body).not.toContain("torana_agent_api_");
  });

  test("populated agent-api state renders all families with HELP + TYPE", () => {
    const m = makeMetrics(["alpha", "beta"]);
    m.incAgentApi("alpha", "ask_requests_2xx", 7);
    m.incAgentApi("alpha", "ask_requests_4xx", 1);
    m.incAgentApi("alpha", "ask_requests_5xx", 1);
    m.incAgentApi("alpha", "ask_timeouts_total", 2);
    m.incAgentApi("alpha", "send_requests_2xx", 5);
    m.incAgentApi("alpha", "send_idempotent_replays_total", 3);
    m.incAgentApi("alpha", "side_sessions_started_total", 4);
    m.incAgentApi("alpha", "side_session_evictions_idle", 1);
    m.incAgentApi("alpha", "side_session_evictions_hard", 1);
    m.incAgentApi("alpha", "side_session_evictions_lru", 1);
    m.incAgentApi("alpha", "side_session_capacity_rejected_total", 2);
    m.setAgentApiGauge("alpha", "side_sessions_live", 2);

    m.incAgentApi("beta", "ask_requests_2xx", 1);
    m.setAgentApiGauge("beta", "side_sessions_live", 1);
    m.observeAgentApiRequestDuration("alpha", "ask", 120);
    m.observeAgentApiAcquireDuration("alpha", "reuse", 1);

    const body = m.renderPrometheus({ alpha: 2, beta: 2 });
    expect(body).toContain("# HELP torana_agent_api_requests_total");
    expect(body).toContain("# TYPE torana_agent_api_requests_total counter");
    expect(body).toContain(
      'torana_agent_api_requests_total{bot_id="alpha",mode="ask",outcome="2xx"} 7',
    );
    expect(body).toContain(
      'torana_agent_api_requests_total{bot_id="alpha",mode="ask",outcome="timeout"} 2',
    );
    expect(body).toContain(
      'torana_agent_api_requests_total{bot_id="beta",mode="ask",outcome="2xx"} 1',
    );

    expect(body).toContain(
      "# HELP torana_agent_api_send_idempotent_replays_total",
    );
    expect(body).toContain(
      'torana_agent_api_send_idempotent_replays_total{bot_id="alpha"} 3',
    );

    expect(body).toContain(
      "# HELP torana_agent_api_side_sessions_started_total",
    );
    expect(body).toContain(
      'torana_agent_api_side_sessions_started_total{bot_id="alpha"} 4',
    );

    expect(body).toContain(
      "# HELP torana_agent_api_side_session_evictions_total",
    );
    expect(body).toContain(
      'torana_agent_api_side_session_evictions_total{bot_id="alpha",reason="idle"} 1',
    );
    expect(body).toContain(
      'torana_agent_api_side_session_evictions_total{bot_id="alpha",reason="hard"} 1',
    );
    expect(body).toContain(
      'torana_agent_api_side_session_evictions_total{bot_id="alpha",reason="lru"} 1',
    );

    expect(body).toContain(
      "# HELP torana_agent_api_side_session_capacity_rejected_total",
    );
    expect(body).toContain(
      'torana_agent_api_side_session_capacity_rejected_total{bot_id="alpha"} 2',
    );

    m.incAgentApi("alpha", "ask_orphan_resolutions_done", 3);
    m.incAgentApi("alpha", "ask_orphan_resolutions_error", 1);
    m.incAgentApi("alpha", "ask_orphan_resolutions_backstop", 1);
    const body2 = m.renderPrometheus({ alpha: 2, beta: 2 });
    expect(body2).toContain(
      "# HELP torana_agent_api_ask_orphan_resolutions_total",
    );
    expect(body2).toContain(
      "# TYPE torana_agent_api_ask_orphan_resolutions_total counter",
    );
    expect(body2).toContain(
      'torana_agent_api_ask_orphan_resolutions_total{bot_id="alpha",outcome="done"} 3',
    );
    expect(body2).toContain(
      'torana_agent_api_ask_orphan_resolutions_total{bot_id="alpha",outcome="error"} 1',
    );
    expect(body2).toContain(
      'torana_agent_api_ask_orphan_resolutions_total{bot_id="alpha",outcome="fatal"} 0',
    );
    expect(body2).toContain(
      'torana_agent_api_ask_orphan_resolutions_total{bot_id="alpha",outcome="backstop"} 1',
    );

    expect(body).toContain("# HELP torana_agent_api_side_sessions_live");
    expect(body).toContain("# TYPE torana_agent_api_side_sessions_live gauge");
    expect(body).toContain(
      'torana_agent_api_side_sessions_live{bot_id="alpha"} 2',
    );
    expect(body).toContain(
      'torana_agent_api_side_sessions_live{bot_id="beta"} 1',
    );

    expect(body).toContain("# HELP torana_agent_api_request_duration_ms");
    expect(body).toContain(
      "# TYPE torana_agent_api_request_duration_ms histogram",
    );
    expect(body).toContain(
      "# HELP torana_agent_api_side_session_acquire_duration_ms",
    );
    expect(body).toContain(
      "# TYPE torana_agent_api_side_session_acquire_duration_ms histogram",
    );

    // Existing (non-agent-api) families still render.
    expect(body).toContain("# HELP gateway_uptime_secs");
    expect(body).toContain("# HELP telegram_api_calls_total");
    expect(body.endsWith("\n")).toBe(true);
  });
});
