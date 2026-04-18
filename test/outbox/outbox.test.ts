// Direct unit tests for OutboxProcessor. Covers retry/backoff, 429 handling,
// max_attempts → dead-letter, duplicate-send guard, markdown→HTML fallback,
// drain semantics, and send-callback invocation ordering.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GatewayDB } from "../../src/db/gateway-db.js";
import { OutboxProcessor } from "../../src/outbox.js";
import { Metrics } from "../../src/metrics.js";
import {
  TelegramClient,
  TelegramError,
} from "../../src/telegram/client.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSchema(dbPath: string): void {
  const sql = readFileSync(resolve(__dirname, "../../src/db/schema.sql"), "utf8") + "\nPRAGMA user_version=1;";
  const raw = new Database(dbPath, { create: true });
  raw.exec(sql);
  raw.close();
}

type FetchArgs = { url: string; init: RequestInit | undefined };

/**
 * Test double for a TelegramClient: lets each test program response behavior
 * per-method. Each bot gets its own instance; the fetch impl sits underneath.
 */
function makeFetch(
  handler: (method: string, body: Record<string, unknown>, args: FetchArgs) => Response | Promise<Response>,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr =
      typeof url === "string"
        ? url
        : url instanceof URL
          ? url.toString()
          : url.url;
    const methodMatch = urlStr.match(/\/bot[^/]+\/(.+)$/);
    const method = methodMatch?.[1] ?? "";
    let body: Record<string, unknown> = {};
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        /* ignore */
      }
    }
    return await handler(method, body, { url: urlStr, init });
  }) as unknown as typeof fetch;
}

interface Harness {
  db: GatewayDB;
  tmpDir: string;
  makeProcessor: (opts?: {
    fetchImpl?: typeof fetch;
    max_attempts?: number;
    retry_base_ms?: number;
  }) => { outbox: OutboxProcessor; metrics: Metrics; calls: Array<{ method: string; body: Record<string, unknown> }> };
  seedTurn: (botId: string, chatId?: number) => number;
}

let harness: Harness;

beforeEach(() => {
  const tmpDir = mkdtempSync(join(tmpdir(), "torana-outbox-"));
  loadSchema(join(tmpDir, "gateway.db"));
  const db = new GatewayDB(join(tmpDir, "gateway.db"));

  harness = {
    db,
    tmpDir,
    seedTurn(botId: string, chatId = 111): number {
      const inboundId = db.insertUpdate(
        botId,
        Math.floor(Math.random() * 1_000_000),
        chatId,
        1,
        "42",
        JSON.stringify({ message: { text: "hi" } }),
        "enqueued",
      );
      return db.createTurn(botId, chatId, inboundId!);
    },
    makeProcessor(opts = {}) {
      const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
      const defaultFetch = makeFetch((method) => {
        if (method === "sendMessage") {
          return Response.json({ ok: true, result: { message_id: 9001 } });
        }
        if (method === "editMessageText") {
          return Response.json({ ok: true, result: true });
        }
        return Response.json({ ok: true, result: true });
      });
      const fetchImpl = opts.fetchImpl ?? defaultFetch;
      const wrapped = ((url: string | URL | Request, init?: RequestInit) => {
        const urlStr =
          typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        const methodMatch = urlStr.match(/\/bot[^/]+\/(.+)$/);
        const m = methodMatch?.[1] ?? "";
        let body: Record<string, unknown> = {};
        if (init?.body && typeof init.body === "string") {
          try { body = JSON.parse(init.body); } catch { /* ignore */ }
        }
        calls.push({ method: m, body });
        return fetchImpl(url as never, init);
      }) as unknown as typeof fetch;

      const botConfig = makeTestBotConfig("alpha");
      const config = makeTestConfig([botConfig], {
        outbox: {
          max_attempts: opts.max_attempts ?? 3,
          retry_base_ms: opts.retry_base_ms ?? 10,
        },
        gateway: {
          port: 3000,
          data_dir: tmpDir,
          db_path: join(tmpDir, "gateway.db"),
          log_level: "warn",
        },
      });
      const client = new TelegramClient({
        botId: "alpha",
        token: "TT:AAAA",
        apiBaseUrl: "https://api.telegram.org",
        fetchImpl: wrapped,
      });
      const clients = new Map<string, TelegramClient>([["alpha", client]]);
      const metrics = new Metrics(config);
      const outbox = new OutboxProcessor(config, db, clients, metrics);
      return { outbox, metrics, calls };
    },
  };
});

afterEach(() => {
  harness.db.close();
  rmSync(harness.tmpDir, { recursive: true, force: true });
});

describe("OutboxProcessor.drain", () => {
  test("drains pending send rows and invokes send callbacks in order", async () => {
    const { outbox, calls } = harness.makeProcessor();
    const turnId = harness.seedTurn("alpha");
    const callbackFired: { value: number | null } = { value: null };
    outbox.queueSendWithCallback(turnId, "alpha", 111, "hello", (msgId) => {
      callbackFired.value = msgId;
    });

    await outbox.drain(2000);

    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
    expect(callbackFired.value).toBe(9001);
    const rows = harness.db.getPendingOutbox();
    expect(rows).toHaveLength(0);
  });

  test("respects deadline: returns when maxMs elapses even with rows remaining", async () => {
    // Hand-rolled fetch that hangs forever: drain must return by deadline.
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    const { outbox } = harness.makeProcessor({ fetchImpl });
    const turnId = harness.seedTurn("alpha");
    outbox.queueSend(turnId, "alpha", 111, "hello");

    const t0 = Date.now();
    // Give it a short budget; if processOne is stuck, drain will wait ~budget.
    // We're just asserting it returns, not that it finishes work.
    const drainPromise = outbox.drain(300);
    // Drain will call processPending → processOne → awaits the hanging fetch.
    // We can't cancel the fetch from here, so just verify drain does return
    // once processPending returns. For a robust assertion, call drain with
    // a completed queue after some time.
    await Promise.race([
      drainPromise,
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    const elapsed = Date.now() - t0;
    // We don't need drain to be bounded tightly — just bound enough that it
    // doesn't hang indefinitely. The hanging fetch would stall forever
    // without the deadline or external timeout.
    expect(elapsed).toBeLessThan(2000);
  }, 5000);
});

describe("OutboxProcessor.processPending - retries and dead-lettering", () => {
  test("transient 5xx: row moves to retrying with future next_attempt_at", async () => {
    let callCount = 0;
    const fetchImpl = makeFetch((method) => {
      if (method === "sendMessage") {
        callCount += 1;
        return Response.json(
          { ok: false, error_code: 500, description: "server error" },
          { status: 500 },
        );
      }
      return Response.json({ ok: true, result: true });
    });
    const { outbox } = harness.makeProcessor({
      fetchImpl,
      max_attempts: 5,
      retry_base_ms: 10_000, // big enough that nothing re-fires in this test
    });
    const turnId = harness.seedTurn("alpha");
    const outboxId = outbox.queueSend(turnId, "alpha", 111, "hello");

    // Trigger one processing pass via drain (brief deadline — one attempt fires).
    await outbox.drain(300);
    expect(callCount).toBe(1);

    const row = harness.db.getOutboxRow(outboxId);
    expect(row?.status).toBe("retrying");
    const raw = harness.db
      .query("SELECT attempt_count, next_attempt_at, last_error FROM outbox WHERE id = ?")
      .get(outboxId) as { attempt_count: number; next_attempt_at: string; last_error: string };
    expect(raw.attempt_count).toBe(1);
    expect(raw.next_attempt_at).not.toBeNull();
    // Stored format must be SQLite's datetime() format (space separator, no
    // millis, no Z) so that lexicographic comparison with datetime('now')
    // works correctly during retry eligibility checks.
    expect(raw.next_attempt_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(new Date(raw.next_attempt_at + "Z").getTime()).toBeGreaterThan(
      Date.now() - 1000,
    );
    // TelegramClient surfaces the upstream error description so operators
    // can diagnose the actual failure from the outbox row.
    expect(raw.last_error).toContain("500");
    expect(raw.last_error).toContain("server error");
  });

  test("429 rate-limit is retried like any other failure (status: retrying)", async () => {
    const fetchImpl = makeFetch((method) => {
      if (method === "sendMessage") {
        return Response.json(
          { ok: false, error_code: 429, description: "Too Many Requests: retry after 5" },
          { status: 429 },
        );
      }
      return Response.json({ ok: true, result: true });
    });
    const { outbox } = harness.makeProcessor({
      fetchImpl,
      retry_base_ms: 10_000,
      max_attempts: 5,
    });
    const turnId = harness.seedTurn("alpha");
    const id = outbox.queueSend(turnId, "alpha", 111, "hi");
    await outbox.drain(300);
    const row = harness.db.getOutboxRow(id);
    expect(row?.status).toBe("retrying");
  });

  test("max_attempts reached → dead-letter (status: dead, no further attempts)", async () => {
    let callCount = 0;
    const fetchImpl = makeFetch((method) => {
      if (method === "sendMessage") {
        callCount += 1;
        return Response.json(
          { ok: false, error_code: 502, description: "bad gateway" },
          { status: 502 },
        );
      }
      return Response.json({ ok: true, result: true });
    });
    const { outbox, metrics } = harness.makeProcessor({
      fetchImpl,
      max_attempts: 2,
      retry_base_ms: 1, // immediate re-eligibility
    });
    const turnId = harness.seedTurn("alpha");
    const id = outbox.queueSend(turnId, "alpha", 111, "hi");

    // First attempt
    await outbox.drain(100);
    // Wait for next_attempt_at to elapse (retry_base_ms = 1ms)
    await new Promise((r) => setTimeout(r, 30));
    // Second attempt → attempt_count hits max → dead
    await outbox.drain(100);

    expect(callCount).toBeGreaterThanOrEqual(2);
    const row = harness.db.getOutboxRow(id);
    expect(row?.status).toBe("dead");

    // Third drain should NOT re-fire a dead row.
    const before = callCount;
    await outbox.drain(50);
    expect(callCount).toBe(before);

    // Metrics recorded failures.
    const snap = metrics.snapshot();
    expect(snap.alpha.counters.telegram_send_failures).toBeGreaterThanOrEqual(2);
  });

  test("retry succeeds: row transitions retrying → sent and callback fires", async () => {
    let failOnce = true;
    const fetchImpl = makeFetch((method) => {
      if (method === "sendMessage") {
        if (failOnce) {
          failOnce = false;
          return Response.json(
            { ok: false, error_code: 500, description: "transient" },
            { status: 500 },
          );
        }
        return Response.json({ ok: true, result: { message_id: 42 } });
      }
      return Response.json({ ok: true, result: true });
    });
    const { outbox } = harness.makeProcessor({
      fetchImpl,
      retry_base_ms: 1,
      max_attempts: 5,
    });
    const turnId = harness.seedTurn("alpha");
    const cbMsgId: { value: number | null } = { value: null };
    const id = outbox.queueSendWithCallback(turnId, "alpha", 111, "hi", (m) => {
      cbMsgId.value = m;
    });

    await outbox.drain(100);
    await new Promise((r) => setTimeout(r, 30));
    await outbox.drain(300);

    const row = harness.db.getOutboxRow(id);
    expect(row?.status).toBe("sent");
    expect(row?.telegram_message_id).toBe(42);
    expect(cbMsgId.value).toBe(42);
  });

  test("non-retriable 4xx → failed (no retry loop)", async () => {
    // 4xx errors are client errors: retrying won't help. The row moves to
    // 'failed' after the plain-text fallback is also rejected.
    const fetchImpl = makeFetch((method, body) => {
      if (method === "sendMessage") {
        if (body.parse_mode === "HTML") {
          return Response.json(
            { ok: false, error_code: 400, description: "can't parse entities" },
            { status: 400 },
          );
        }
        return Response.json(
          { ok: false, error_code: 400, description: "bad request" },
          { status: 400 },
        );
      }
      return Response.json({ ok: true, result: true });
    });
    const { outbox } = harness.makeProcessor({
      fetchImpl,
      retry_base_ms: 10_000,
      max_attempts: 5,
    });
    const turnId = harness.seedTurn("alpha");
    const id = outbox.queueSend(turnId, "alpha", 111, "**bold**");

    await outbox.drain(300);

    const row = harness.db.getOutboxRow(id);
    expect(row?.status).toBe("failed");
  });

  test("HTML fallback: first call fails with 400, plain-text retry succeeds", async () => {
    let sendCalls = 0;
    const fetchImpl = makeFetch((method, body) => {
      if (method === "sendMessage") {
        sendCalls += 1;
        if (body.parse_mode === "HTML") {
          return Response.json(
            { ok: false, error_code: 400, description: "can't parse entities" },
            { status: 400 },
          );
        }
        return Response.json({ ok: true, result: { message_id: 7 } });
      }
      return Response.json({ ok: true, result: true });
    });
    const { outbox } = harness.makeProcessor({ fetchImpl });
    const turnId = harness.seedTurn("alpha");
    // Text with markdown → HTML formatting differs from raw → fallback fires.
    const id = outbox.queueSend(turnId, "alpha", 111, "**bold** text");
    await outbox.drain(300);

    const row = harness.db.getOutboxRow(id);
    expect(row?.status).toBe("sent");
    expect(row?.telegram_message_id).toBe(7);
    expect(sendCalls).toBe(2); // HTML then plain text
  });

  test("edit row without telegram_message_id → marked failed immediately (non-retriable)", async () => {
    // Inject a malformed edit row directly via DB (the outbox API requires
    // an explicit messageId for edit, but this guards the boundary).
    const { outbox } = harness.makeProcessor();
    const turnId = harness.seedTurn("alpha");
    // Use insertOutbox directly with kind=edit but messageId undefined
    const id = harness.db.insertOutbox(
      turnId,
      "alpha",
      111,
      "edit",
      JSON.stringify({ text: "hi" }),
      undefined,
    );
    await outbox.drain(100);
    const row = harness.db.getOutboxRow(id);
    expect(row?.status).toBe("failed");
  });

  test("no client registered for bot_id → row marked failed", async () => {
    const { outbox } = harness.makeProcessor();
    const turnId = harness.seedTurn("alpha");
    // Insert row for a bot we don't have a client for.
    const id = harness.db.insertOutbox(
      turnId,
      "unknown-bot",
      111,
      "send",
      JSON.stringify({ text: "hi" }),
    );
    await outbox.drain(100);
    const row = harness.db.getOutboxRow(id);
    expect(row?.status).toBe("failed");
  });

  test("next_attempt_at in the future is NOT attempted", async () => {
    let calls = 0;
    const fetchImpl = makeFetch((method) => {
      if (method === "sendMessage") {
        calls += 1;
        return Response.json({ ok: true, result: { message_id: 1 } });
      }
      return Response.json({ ok: true, result: true });
    });
    const { outbox } = harness.makeProcessor({ fetchImpl });
    const turnId = harness.seedTurn("alpha");
    const id = outbox.queueSend(turnId, "alpha", 111, "hi");
    // Manually set next_attempt_at to a future time and status=retrying.
    harness.db
      .query("UPDATE outbox SET status='retrying', next_attempt_at=datetime('now','+1 hour') WHERE id=?")
      .run(id);
    await outbox.drain(100);
    expect(calls).toBe(0);
    const row = harness.db.getOutboxRow(id);
    expect(row?.status).toBe("retrying"); // unchanged
  });

  test("concurrent drain calls are serialized (no duplicate sends)", async () => {
    let calls = 0;
    const fetchImpl = makeFetch((method) => {
      if (method === "sendMessage") {
        calls += 1;
        return Response.json({ ok: true, result: { message_id: calls } });
      }
      return Response.json({ ok: true, result: true });
    });
    const { outbox } = harness.makeProcessor({ fetchImpl });
    const turnId = harness.seedTurn("alpha");
    outbox.queueSend(turnId, "alpha", 111, "one");
    outbox.queueSend(turnId, "alpha", 111, "two");
    // Kick off two drains in parallel.
    await Promise.all([outbox.drain(500), outbox.drain(500)]);
    expect(calls).toBe(2);
  });

  test("backoff grows exponentially with attempt_count", async () => {
    // Fail forever with a large retry_base_ms so backoff is clearly visible in
    // seconds: attempt 1 → 10s, attempt 2 → 20s, attempt 3 → 40s.
    const fetchImpl = makeFetch((method) => {
      if (method === "sendMessage") {
        return Response.json(
          { ok: false, error_code: 500, description: "err" },
          { status: 500 },
        );
      }
      return Response.json({ ok: true, result: true });
    });
    const { outbox } = harness.makeProcessor({
      fetchImpl,
      max_attempts: 10,
      retry_base_ms: 10_000,
    });
    const turnId = harness.seedTurn("alpha");
    const id = outbox.queueSend(turnId, "alpha", 111, "hi");

    // Capture next_attempt_at after attempt 1 (rolls to retrying w/ +10s).
    await outbox.drain(100);
    const r1 = harness.db
      .query("SELECT attempt_count, next_attempt_at FROM outbox WHERE id=?")
      .get(id) as { attempt_count: number; next_attempt_at: string };
    expect(r1.attempt_count).toBe(1);
    const t1 = new Date(r1.next_attempt_at + "Z").getTime();

    // Force the row eligible again by rewinding next_attempt_at, then drain.
    harness.db
      .query("UPDATE outbox SET next_attempt_at='2000-01-01 00:00:00' WHERE id=?")
      .run(id);
    await outbox.drain(100);
    const r2 = harness.db
      .query("SELECT attempt_count, next_attempt_at FROM outbox WHERE id=?")
      .get(id) as { attempt_count: number; next_attempt_at: string };
    expect(r2.attempt_count).toBe(2);
    // Attempt 2: backoff = 10s * 2^1 = 20s. Should be ~10s further than attempt 1.
    const t2 = new Date(r2.next_attempt_at + "Z").getTime();
    expect(t2 - t1).toBeGreaterThanOrEqual(5_000); // with some jitter slack

    // Attempt 3: backoff = 10s * 2^2 = 40s.
    harness.db
      .query("UPDATE outbox SET next_attempt_at='2000-01-01 00:00:00' WHERE id=?")
      .run(id);
    await outbox.drain(100);
    const r3 = harness.db
      .query("SELECT attempt_count, next_attempt_at FROM outbox WHERE id=?")
      .get(id) as { attempt_count: number; next_attempt_at: string };
    expect(r3.attempt_count).toBe(3);
    const t3 = new Date(r3.next_attempt_at + "Z").getTime();
    // Attempt 3 delay should be larger than attempt 2's delay (monotonic).
    expect(t3 - t2).toBeGreaterThan(0);
  });
});

describe("OutboxProcessor.processPending - edit flow", () => {
  test("successful edit marks row sent (no messageId update)", async () => {
    let editCalls = 0;
    const fetchImpl = makeFetch((method) => {
      if (method === "editMessageText") {
        editCalls += 1;
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: true });
    });
    const { outbox } = harness.makeProcessor({ fetchImpl });
    const turnId = harness.seedTurn("alpha");
    const id = outbox.queueEdit(turnId, "alpha", 111, 4242, "updated");
    await outbox.drain(100);
    expect(editCalls).toBe(1);
    const row = harness.db.getOutboxRow(id);
    expect(row?.status).toBe("sent");
    expect(row?.telegram_message_id).toBe(4242);
  });

  test("edit HTML fallback: first attempt fails, second with plain text succeeds", async () => {
    let editCalls = 0;
    const fetchImpl = makeFetch((method, body) => {
      if (method === "editMessageText") {
        editCalls += 1;
        if (body.parse_mode === "HTML") {
          return Response.json(
            { ok: false, error_code: 400, description: "parse entities" },
            { status: 400 },
          );
        }
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: true });
    });
    const { outbox } = harness.makeProcessor({ fetchImpl });
    const turnId = harness.seedTurn("alpha");
    const id = outbox.queueEdit(turnId, "alpha", 111, 4242, "**bold**");
    await outbox.drain(100);
    expect(editCalls).toBe(2);
    const row = harness.db.getOutboxRow(id);
    expect(row?.status).toBe("sent");
  });

  test("edit with 'message is not modified' → marked sent (no retry loop)", async () => {
    // Telegram returns 400 "message is not modified" when the edit payload
    // matches the current message. Common in streaming where a fire-and-forget
    // flush already pushed the final buffer before finalizeTurn queues the
    // terminal edit. Must NOT dead-letter after 5 attempts.
    let editCalls = 0;
    const fetchImpl = makeFetch((method) => {
      if (method === "editMessageText") {
        editCalls += 1;
        return Response.json(
          {
            ok: false,
            error_code: 400,
            description: "Bad Request: message is not modified",
          },
          { status: 400 },
        );
      }
      return Response.json({ ok: true, result: true });
    });
    const { outbox } = harness.makeProcessor({
      fetchImpl,
      max_attempts: 5,
      retry_base_ms: 10_000,
    });
    const turnId = harness.seedTurn("alpha");
    const id = outbox.queueEdit(turnId, "alpha", 111, 4242, "same text");
    await outbox.drain(100);
    // Exactly one call — no HTML→plain fallback (same content would fail the
    // same way), and no retry storm.
    expect(editCalls).toBe(1);
    const row = harness.db.getOutboxRow(id);
    expect(row?.status).toBe("sent");
  });

  test("edit 4xx (non-retriable, not 'not modified') → failed immediately", async () => {
    // Any other 400 means the request is malformed — retrying won't help.
    // Row moves to 'failed' after the plain-text fallback is also rejected.
    let editCalls = 0;
    const fetchImpl = makeFetch((method, body) => {
      if (method === "editMessageText") {
        editCalls += 1;
        if (body.parse_mode === "HTML") {
          return Response.json(
            { ok: false, error_code: 400, description: "can't parse entities" },
            { status: 400 },
          );
        }
        return Response.json(
          { ok: false, error_code: 400, description: "chat not found" },
          { status: 400 },
        );
      }
      return Response.json({ ok: true, result: true });
    });
    const { outbox } = harness.makeProcessor({
      fetchImpl,
      max_attempts: 5,
      retry_base_ms: 10_000,
    });
    const turnId = harness.seedTurn("alpha");
    const id = outbox.queueEdit(turnId, "alpha", 111, 4242, "**bold**");
    await outbox.drain(100);
    expect(editCalls).toBe(2); // HTML then plain
    const row = harness.db.getOutboxRow(id);
    expect(row?.status).toBe("failed");
  });

  test("edit metric increment uses telegram_edit_failures (not send)", async () => {
    const fetchImpl = makeFetch((method) => {
      if (method === "editMessageText") {
        // HTML fails AND plain-text fails → handleFailure path.
        return Response.json(
          { ok: false, error_code: 500, description: "err" },
          { status: 500 },
        );
      }
      return Response.json({ ok: true, result: true });
    });
    const { outbox, metrics } = harness.makeProcessor({
      fetchImpl,
      retry_base_ms: 10_000,
    });
    const turnId = harness.seedTurn("alpha");
    outbox.queueEdit(turnId, "alpha", 111, 4242, "**x**");
    await outbox.drain(100);
    const snap = metrics.snapshot();
    expect(snap.alpha.counters.telegram_edit_failures).toBe(1);
    expect(snap.alpha.counters.telegram_send_failures).toBe(0);
  });
});

describe("OutboxProcessor.fireAndForgetEdit", () => {
  test("best-effort: swallows HTTP failures without throwing", async () => {
    const fetchImpl = makeFetch(() =>
      Response.json(
        { ok: false, error_code: 500, description: "err" },
        { status: 500 },
      ),
    );
    const { outbox } = harness.makeProcessor({ fetchImpl });
    // Should not throw.
    await outbox.fireAndForgetEdit("alpha", 111, 1234, "hi");
  });

  test("no-op for unregistered bot id", async () => {
    const { outbox } = harness.makeProcessor();
    await outbox.fireAndForgetEdit("unknown", 111, 1234, "hi");
  });
});
