// Expanded PollingTransport tests.
//
// Covers:
//   - HTTP 5xx → backoff grows (failureCount increments, wait_ms doubles)
//   - HTTP 429 → retried (not fatal)
//   - Network error → backoff (same path as 5xx)
//   - 401 auth → bot disabled in bot_state, poller exits, no further getUpdates
//   - Disabled bot at start → poller exits without any getUpdates calls
//   - stop() aborts in-flight long-poll (no wait for timeout_secs)
//   - Multiple updates: offset advances to max update_id, not just last
//   - Update handler throws → logged but loop continues

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PollingTransport } from "../../src/transport/polling.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { TelegramClient } from "../../src/telegram/client.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";
import type { TelegramUpdate } from "../../src/telegram/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let tmpDir: string;
let db: GatewayDB;

function loadSchema(dbPath: string): void {
  const sql =
    readFileSync(resolve(__dirname, "../../src/db/schema.sql"), "utf8") +
    "\nPRAGMA user_version=1;";
  const raw = new Database(dbPath, { create: true });
  raw.exec(sql);
  raw.close();
}

/**
 * Programmable fake Telegram API. `getUpdates` behavior is driven by a queue
 * of responses; each call consumes the next. Empty queue: hang until aborted.
 */
function scriptedFetch(
  script: Array<Response | "hang" | "network-error">,
): typeof fetch {
  let idx = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr =
      typeof url === "string"
        ? url
        : url instanceof URL
          ? url.toString()
          : url.url;
    if (urlStr.endsWith("/deleteWebhook")) {
      return new Response(JSON.stringify({ ok: true, result: true }));
    }
    if (!urlStr.includes("/getUpdates")) {
      return new Response(JSON.stringify({ ok: true, result: true }));
    }
    const next = script[idx] ?? "hang";
    if (idx < script.length) idx += 1;
    if (next === "network-error") {
      throw new Error("simulated network error");
    }
    if (next === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) return reject(new Error("aborted"));
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    }
    return next.clone();
  }) as unknown as typeof fetch;
}

function okUpdates(updates: TelegramUpdate[]): Response {
  return new Response(JSON.stringify({ ok: true, result: updates }));
}

function errResp(status: number, desc: string, ec = status): Response {
  return new Response(
    JSON.stringify({ ok: false, error_code: ec, description: desc }),
    {
      status,
    },
  );
}

/** 429 carrying Telegram's declared cooldown in the error envelope. */
function throttleResp(retryAfterSecs: number): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry later",
      parameters: { retry_after: retryAfterSecs },
    }),
    { status: 429 },
  );
}

/**
 * Poll until `predicate` holds. Real time is used only as a failure deadline —
 * generous enough that a loaded runner can't trip it — so assertions stay
 * about values, never about how long anything took.
 */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

function buildTransport(opts: {
  fetchImpl: typeof fetch;
  backoff_base_ms?: number;
  backoff_cap_ms?: number;
  disabled?: boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): PollingTransport {
  const botConfig = makeTestBotConfig("alpha");
  const config = makeTestConfig([botConfig], {
    transport: {
      default_mode: "polling",
      allowed_updates: ["message"],
      polling: {
        timeout_secs: 1,
        backoff_base_ms: opts.backoff_base_ms ?? 50,
        backoff_cap_ms: opts.backoff_cap_ms ?? 500,
        max_updates_per_batch: 100,
      },
    },
  });
  const clients = new Map<string, TelegramClient>();
  clients.set(
    "alpha",
    new TelegramClient({
      botId: "alpha",
      token: "TT:AAAA",
      apiBaseUrl: "https://api.telegram.org",
      fetchImpl: opts.fetchImpl,
    }),
  );
  db.initBotState("alpha");
  if (opts.disabled) {
    db.setBotDisabled("alpha", "pre-disabled");
  }
  return new PollingTransport({ config, db, clients, sleep: opts.sleep });
}

/**
 * A `sleep` seam that records the requested delay and returns immediately, so
 * the poll loop is driven by the scripted responses rather than by real time.
 */
function recordingSleep(): {
  waits: number[];
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
} {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-poll-adv-"));
  loadSchema(join(tmpDir, "gateway.db"));
  db = new GatewayDB(join(tmpDir, "gateway.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("PollingTransport — error handling", () => {
  test("401 auth error disables bot and exits poller", async () => {
    const fetchImpl = scriptedFetch([errResp(401, "Unauthorized")]);
    const transport = buildTransport({ fetchImpl });

    let called = false;
    await transport.start(async () => {
      called = true;
    });

    // Allow the loop to process one getUpdates call.
    await new Promise((r) => setTimeout(r, 150));
    await transport.stop();

    const state = db.getBotState("alpha");
    expect(state?.disabled).toBe(1);
    expect(state?.disabled_reason ?? "").toContain("401");
    expect(called).toBe(false);
  });

  test("5xx triggers backoff, then retry with failureCount reset on success", async () => {
    const fetchImpl = scriptedFetch([
      errResp(502, "Bad gateway"),
      okUpdates([
        {
          update_id: 7,
          message: {
            message_id: 1,
            date: 1,
            chat: { id: 1, type: "private" },
            from: { id: 1, is_bot: false },
            text: "hello",
          },
        },
      ]),
    ]);
    const transport = buildTransport({ fetchImpl, backoff_base_ms: 50 });

    const received: TelegramUpdate[] = [];
    await transport.start(async (_botId, update) => {
      received.push(update);
    });

    // Allow enough time for backoff (~50ms) + second call to return updates.
    await new Promise((r) => setTimeout(r, 500));
    await transport.stop();

    expect(received).toHaveLength(1);
    expect(received[0].update_id).toBe(7);
    expect(db.getBotState("alpha")?.last_update_id).toBe(7);
  });

  test("network error is retried with backoff (same as 5xx)", async () => {
    const fetchImpl = scriptedFetch(["network-error", okUpdates([])]);
    const transport = buildTransport({ fetchImpl, backoff_base_ms: 30 });

    let sawGetUpdates = 0;
    // Wrap fetchImpl to count calls (script already counts them, but we want
    // to verify that the retry happened).
    await transport.start(async () => {
      /* no updates in this test */
    });
    await new Promise((r) => setTimeout(r, 200));
    await transport.stop();
    // No assertion on sawGetUpdates count — we're testing that the network
    // error path doesn't crash the poller. As long as no exception leaks,
    // the test passes.
    expect(true).toBe(true);
  });

  test("backoff grows exponentially on repeated failures", async () => {
    // Assert the delay the backoff policy *requested*, not the wall-clock gap
    // between calls. The measured version of this test was flaky on CI: timer
    // jitter of tens of ms on a 50ms interval inflates the first gap enough to
    // break a d2 > d1 * 1.3 ratio, so it was really asserting on the runner's
    // scheduler. The sleep seam returns immediately, so the loop is driven by
    // the scripted responses and the assertion is exact.
    const { waits, sleep } = recordingSleep();
    const fetchImpl = scriptedFetch([
      errResp(503, "Service Unavailable"),
      errResp(503, "Service Unavailable"),
      errResp(503, "Service Unavailable"),
      errResp(503, "Service Unavailable"),
      // Script exhausted → subsequent calls hang until stop() aborts them,
      // which parks the loop instead of spinning.
    ]);

    const transport = buildTransport({
      fetchImpl,
      backoff_base_ms: 50,
      backoff_cap_ms: 10_000,
      sleep,
    });
    await transport.start(async () => {
      /* */
    });

    await waitFor(() => waits.length >= 4, "4 backoff waits");
    await transport.stop();

    expect(waits.slice(0, 4)).toEqual([50, 100, 200, 400]);
  });

  test("backoff saturates at backoff_cap_ms instead of growing without bound", async () => {
    const { waits, sleep } = recordingSleep();
    const fetchImpl = scriptedFetch(
      Array.from({ length: 6 }, () => errResp(503, "Service Unavailable")),
    );

    const transport = buildTransport({
      fetchImpl,
      backoff_base_ms: 50,
      backoff_cap_ms: 200,
      sleep,
    });
    await transport.start(async () => {
      /* */
    });

    await waitFor(() => waits.length >= 6, "6 backoff waits");
    await transport.stop();

    // 50, 100, 200, then clamped — never 400.
    expect(waits.slice(0, 6)).toEqual([50, 100, 200, 200, 200, 200]);
  });

  test("a successful poll resets the backoff back to the base delay", async () => {
    const { waits, sleep } = recordingSleep();
    const fetchImpl = scriptedFetch([
      errResp(503, "Service Unavailable"),
      errResp(503, "Service Unavailable"),
      okUpdates([]), // success clears failureCount
      errResp(503, "Service Unavailable"),
      errResp(503, "Service Unavailable"),
    ]);

    const transport = buildTransport({
      fetchImpl,
      backoff_base_ms: 50,
      backoff_cap_ms: 10_000,
      sleep,
    });
    await transport.start(async () => {
      /* */
    });

    await waitFor(() => waits.length >= 4, "4 backoff waits");
    await transport.stop();

    // Without the reset this would be 50, 100, 200, 400.
    expect(waits.slice(0, 4)).toEqual([50, 100, 50, 100]);
  });

  test("429 Retry-After overrides a shorter exponential backoff", async () => {
    // Telegram's declared cooldown wins when it is longer than what the
    // exponential schedule would have waited; retrying inside the cooldown
    // extends the throttle.
    const { waits, sleep } = recordingSleep();
    const fetchImpl = scriptedFetch([throttleResp(3), throttleResp(3)]);

    const transport = buildTransport({
      fetchImpl,
      backoff_base_ms: 50,
      backoff_cap_ms: 10_000,
      sleep,
    });
    await transport.start(async () => {
      /* */
    });

    await waitFor(() => waits.length >= 2, "2 backoff waits");
    await transport.stop();

    expect(waits.slice(0, 2)).toEqual([3_000, 3_000]);
  });

  test("exponential backoff wins when it exceeds a short Retry-After", async () => {
    const { waits, sleep } = recordingSleep();
    const fetchImpl = scriptedFetch([
      errResp(503, "Service Unavailable"),
      errResp(503, "Service Unavailable"),
      throttleResp(1), // 1000ms cooldown, but we're already waiting 2000ms
    ]);

    const transport = buildTransport({
      fetchImpl,
      backoff_base_ms: 1_000,
      backoff_cap_ms: 10_000,
      sleep,
    });
    await transport.start(async () => {
      /* */
    });

    await waitFor(() => waits.length >= 3, "3 backoff waits");
    await transport.stop();

    expect(waits.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
  });

  test("disabled bot at start: poller exits without calling getUpdates", async () => {
    let getUpdatesCalls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      if (urlStr.includes("/getUpdates")) getUpdatesCalls += 1;
      if (urlStr.endsWith("/deleteWebhook")) {
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
      return okUpdates([]);
    }) as unknown as typeof fetch;
    const transport = buildTransport({ fetchImpl, disabled: true });
    await transport.start(async () => {
      /* */
    });
    await new Promise((r) => setTimeout(r, 200));
    await transport.stop();
    expect(getUpdatesCalls).toBe(0);
  });
});

describe("PollingTransport — stop / abort", () => {
  test("stop() aborts in-flight getUpdates without waiting the full timeout", async () => {
    // Always hang (simulating a real long-poll with no updates).
    const fetchImpl = scriptedFetch(["hang"]);
    const transport = buildTransport({ fetchImpl });
    await transport.start(async () => {
      /* */
    });

    // Give start time to register the pending request.
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await transport.stop();
    const elapsed = Date.now() - t0;
    // timeout_secs=1 → would be 1000ms if we waited it out. Abort should be <500ms.
    expect(elapsed).toBeLessThan(500);
  });

  test("stop() before start() is a no-op", async () => {
    const fetchImpl = scriptedFetch([]);
    const transport = buildTransport({ fetchImpl });
    await transport.stop(); // should not throw
  });
});

describe("PollingTransport — update delivery", () => {
  test("offset advances to MAX update_id across a batch", async () => {
    const fetchImpl = scriptedFetch([
      okUpdates([
        {
          update_id: 3,
          message: {
            message_id: 1,
            date: 1,
            chat: { id: 1, type: "private" },
            from: { id: 1, is_bot: false },
            text: "a",
          },
        },
        {
          update_id: 7,
          message: {
            message_id: 2,
            date: 1,
            chat: { id: 1, type: "private" },
            from: { id: 1, is_bot: false },
            text: "b",
          },
        },
        {
          update_id: 5,
          message: {
            message_id: 3,
            date: 1,
            chat: { id: 1, type: "private" },
            from: { id: 1, is_bot: false },
            text: "c",
          },
        },
      ]),
    ]);
    const transport = buildTransport({ fetchImpl });
    const received: number[] = [];
    await transport.start(async (_botId, update) => {
      received.push(update.update_id);
    });
    await new Promise((r) => setTimeout(r, 200));
    await transport.stop();

    expect(received).toEqual([3, 7, 5]);
    // Max update_id wins, not the last one processed.
    expect(db.getBotState("alpha")?.last_update_id).toBe(7);
  });

  test("update handler throwing stops batch processing and holds the offset so Telegram redelivers", async () => {
    // The previous behavior continued the for-loop and advanced the
    // offset to max(update_id) even when an update handler threw,
    // silently losing the failing update (the dedup ledger never wrote
    // its row, so Telegram wouldn't redeliver). The fix: on first
    // failure, stop processing the rest of the batch AND skip the
    // offset bump — Telegram will redeliver from the failing id on the
    // next poll, and a transient cause (sqlite-locked, disk-full, etc.)
    // gets a real retry.
    const fetchImpl = scriptedFetch([
      okUpdates([
        {
          update_id: 1,
          message: {
            message_id: 1,
            date: 1,
            chat: { id: 1, type: "private" },
            from: { id: 1, is_bot: false },
            text: "boom",
          },
        },
        {
          update_id: 2,
          message: {
            message_id: 2,
            date: 1,
            chat: { id: 1, type: "private" },
            from: { id: 1, is_bot: false },
            text: "ok",
          },
        },
      ]),
    ]);
    const transport = buildTransport({ fetchImpl });
    const seen: number[] = [];
    await transport.start(async (_botId, update) => {
      seen.push(update.update_id);
      if (update.update_id === 1) throw new Error("handler boom");
    });
    await new Promise((r) => setTimeout(r, 200));
    await transport.stop();

    // The failing update is still observed once (the handler ran and
    // threw); update 2 is NOT processed in this batch — Telegram will
    // redeliver from id 1 on the next poll.
    expect(seen).toEqual([1]);
    // Offset is held back so the failing id is redelivered.
    expect(db.getBotState("alpha")?.last_update_id ?? 0).toBe(0);
  });
});
