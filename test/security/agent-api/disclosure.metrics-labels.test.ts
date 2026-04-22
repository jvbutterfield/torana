// §12.5.6: the Prometheus /metrics scrape must never include token
// names, token secrets, user ids, chat ids, or marker-wrapped prompt
// content. The only high-cardinality label we permit is `bot_id`;
// everything else is a low-cardinality enum.
//
// This test asserts the structural property: scan the rendered
// Prometheus text for the fixed blocklist and for any label-value
// pair that could leak.

import { describe, expect, test } from "bun:test";

import { Metrics } from "../../../src/metrics.js";
import {
  recordAsk,
  recordSend,
  recordOrphanResolution,
  setSideSessionsLive,
} from "../../../src/agent-api/metrics.js";
import { makeTestBotConfig, makeTestConfig } from "../../fixtures/bots.js";

function newMetrics(): Metrics {
  return new Metrics(makeTestConfig([makeTestBotConfig("bot1")]));
}

describe("§12.5.6 disclosure.metrics-labels", () => {
  test("scrape output never labels by token-name, user-id, or chat-id", () => {
    const m = newMetrics();

    // Exercise every recorder to populate stats.
    recordAsk(m, "bot1", { status: 200, durationMs: 123 });
    recordAsk(m, "bot1", { status: 500, durationMs: 50 });
    recordSend(m, "bot1", { status: 202, replay: false, durationMs: 40 });
    recordSend(m, "bot1", { status: 202, replay: true, durationMs: 12 });
    recordOrphanResolution(m, "bot1", "done");
    recordOrphanResolution(m, "bot1", "backstop");
    setSideSessionsLive(m, "bot1", 3);

    // Use both the core Prometheus render path and the agent-api
    // snapshot — whichever is consumed by scrape must not leak.
    const rendered = m.renderPrometheus({ bot1: 1 });
    const snapshot = JSON.stringify(m.agentApiSnapshot());

    for (const text of [rendered, snapshot]) {
      // No token-name leakage.
      expect(text).not.toMatch(/token_name\s*=\s*"/);
      // No user-id or chat-id leakage.
      expect(text).not.toMatch(/user_id\s*=\s*"/);
      expect(text).not.toMatch(/chat_id\s*=\s*"/);
      // No secret-like labels.
      expect(text).not.toMatch(/token\s*=\s*"/);
      expect(text).not.toMatch(/secret\s*=\s*"/);
      // No marker content / prompt text leaks.
      expect(text).not.toContain("[system-message");
    }
  });

  test("only low-cardinality labels appear in scrape output (sanity)", () => {
    const m = newMetrics();
    recordAsk(m, "bot1", { status: 200, durationMs: 123 });
    const text = m.renderPrometheus({ bot1: 1 });
    // Every label name we use should be in this whitelist — if a
    // new leaky label sneaks in, the test will fail loud.
    const allowedLabels = new Set([
      "bot_id",
      "status",
      "result",
      "reason",
      "outcome",
      "replay",
      "route",
      "mode",
      "le", // histogram bucket boundary
    ]);
    const labelMatches = [...text.matchAll(/([a-z_]+)\s*=\s*"/g)].map(
      (m) => m[1]!,
    );
    for (const label of labelMatches) {
      expect(allowedLabels.has(label)).toBe(true);
    }
  });

  test("scrape output renders as utf-8 text; no binary or control-chars", () => {
    const m = newMetrics();
    recordAsk(m, "bot1", { status: 200, durationMs: 1 });
    const text = m.renderPrometheus({ bot1: 1 });
    // No NULs, no ESC, no 0x7F.
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  });
});
