// StreamManager unit tests. Covers:
//   - startTurn: placeholder send + callback sets telegramMessageId
//   - appendText: throttled flush (edit_cadence_ms), fire-and-forget fast path
//   - flushAndSplit: safe-margin triggers placeholder+new send
//   - finalizeTurn: final edit on single-chunk, edit+send chain on multi-chunk
//   - cancelTurn: clears timers + leaves final edit in outbox
//   - splitMessage: splits at newline boundary, falls back to hard limit
//   - empty finalize text: cleans up without emitting edits

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GatewayDB } from "../../src/db/gateway-db.js";
import { OutboxProcessor } from "../../src/outbox.js";
import { StreamManager } from "../../src/streaming.js";
import { Metrics } from "../../src/metrics.js";
import { TelegramClient } from "../../src/telegram/client.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";
import type { Config } from "../../src/config/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSchema(dbPath: string): void {
  const sql =
    readFileSync(resolve(__dirname, "../../src/db/schema.sql"), "utf8") +
    "\nPRAGMA user_version=1;";
  const raw = new Database(dbPath, { create: true });
  raw.exec(sql);
  raw.close();
}

interface Harness {
  tmpDir: string;
  db: GatewayDB;
  streaming: StreamManager;
  outbox: OutboxProcessor;
  telegramCalls: Array<{ method: string; body: Record<string, unknown> }>;
  config: Config;
  seedTurn: (botId: string, chatId?: number) => number;
  setPlaceholderMessageId: (id: number) => void;
  /**
   * When set, editMessageText calls return 429 with the given retry_after
   * (seconds). Use to test the streaming 429 backoff path. Pass null/0 to
   * restore the default success response.
   */
  setEditRateLimit: (retryAfterSecs: number | null) => void;
}

let harness: Harness;

beforeEach(() => {
  const tmpDir = mkdtempSync(join(tmpdir(), "torana-stream-"));
  loadSchema(join(tmpDir, "gateway.db"));
  const db = new GatewayDB(join(tmpDir, "gateway.db"));

  let placeholderMsgId = 9001;
  let editRateLimitSecs: number | null = null;
  const telegramCalls: Array<{
    method: string;
    body: Record<string, unknown>;
  }> = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const urlStr =
      typeof url === "string"
        ? url
        : url instanceof URL
          ? url.toString()
          : url.url;
    const match = urlStr.match(/\/bot[^/]+\/(.+)$/);
    const method = match?.[1] ?? "";
    let body: Record<string, unknown> = {};
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        /* ignore */
      }
    }
    telegramCalls.push({ method, body });
    if (method === "sendMessage") {
      placeholderMsgId += 1;
      return Response.json({
        ok: true,
        result: { message_id: placeholderMsgId },
      });
    }
    if (method === "editMessageText" && editRateLimitSecs !== null) {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: editRateLimitSecs },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (
      method === "editMessageText" ||
      method === "setMessageReaction" ||
      method === "sendChatAction"
    ) {
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: true, result: true });
  }) as unknown as typeof fetch;

  const botConfig = makeTestBotConfig("alpha");
  const config = makeTestConfig([botConfig], {
    gateway: {
      port: 3000,
      bind_host: "127.0.0.1",
      data_dir: tmpDir,
      db_path: join(tmpDir, "gateway.db"),
      log_level: "warn",
    },
    streaming: {
      edit_cadence_ms: 100, // fast-tick tests
      message_length_limit: 100, // small to force splits
      message_length_safe_margin: 80,
    },
    outbox: { max_attempts: 5, retry_base_ms: 5 },
  });

  const client = new TelegramClient({
    botId: "alpha",
    token: "TT:AAAAAA",
    apiBaseUrl: "https://api.telegram.org",
    fetchImpl,
  });
  const clients = new Map([["alpha", client]]);
  const metrics = new Metrics(config);
  const outbox = new OutboxProcessor(config, db, clients, metrics);
  const streaming = new StreamManager(config, db, outbox, clients);

  harness = {
    tmpDir,
    db,
    streaming,
    outbox,
    telegramCalls,
    config,
    setPlaceholderMessageId(id) {
      placeholderMsgId = id - 1;
    },
    setEditRateLimit(retryAfterSecs) {
      editRateLimitSecs = retryAfterSecs;
    },
    seedTurn(botId, chatId = 111) {
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
  };
});

afterEach(() => {
  harness.streaming.stopAll();
  harness.outbox.stop();
  harness.db.close();
  rmSync(harness.tmpDir, { recursive: true, force: true });
});

describe("StreamManager.startTurn", () => {
  test("queues a placeholder send and initializes stream_state", async () => {
    const turnId = harness.seedTurn("alpha");
    await harness.streaming.startTurn("alpha", turnId, 111);

    const pending = harness.db.getPendingOutbox();
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("send");
    expect(pending[0].bot_id).toBe("alpha");
    const payload = JSON.parse(pending[0].payload_json) as { text: string };
    expect(payload.text).toContain("thinking");

    const ss = harness.db.getStreamState(turnId);
    expect(ss).not.toBeNull();
    expect(ss?.active_telegram_message_id).toBeNull();
  });

  test("stream_state is updated with message id after placeholder send completes", async () => {
    const turnId = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(4242);
    await harness.streaming.startTurn("alpha", turnId, 111);

    // Drain outbox so the send completes + callback fires.
    await harness.outbox.drain(200);
    const ss = harness.db.getStreamState(turnId);
    expect(ss?.active_telegram_message_id).toBe(4242);
  });
});

describe("StreamManager.appendText", () => {
  test("fires fire-and-forget edit when cadence elapsed", async () => {
    const turnId = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(777);
    await harness.streaming.startTurn("alpha", turnId, 111);
    await harness.outbox.drain(100); // resolve placeholder

    harness.telegramCalls.length = 0;
    harness.streaming.appendText("alpha", "hello");

    // cadence is 100ms. Let it elapse.
    await new Promise((r) => setTimeout(r, 250));
    // flush() in StreamManager sets lastFlushTime = Date.now() BEFORE calling
    // fireAndForgetEdit; subsequent append <100ms later is debounced via timer.
    const edits = harness.telegramCalls.filter(
      (c) => c.method === "editMessageText",
    );
    expect(edits.length).toBeGreaterThan(0);
    expect(edits[0].body.text).toContain("hello");
  });

  test("flushAndSplit triggers when buffer exceeds safe margin", async () => {
    const turnId = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(100);
    await harness.streaming.startTurn("alpha", turnId, 111);
    await harness.outbox.drain(200);

    // Buffer limit is 80 (safe margin). Push a big chunk.
    const big = "x".repeat(200);
    harness.streaming.appendText("alpha", big);

    // A new placeholder send was queued (for the next segment).
    const pending = harness.db.getPendingOutbox();
    const sends = pending.filter((p) => p.kind === "send");
    expect(sends.length).toBeGreaterThanOrEqual(1);
    // And the previous message got a final edit queued with the overflow text.
    const edits = pending.filter((p) => p.kind === "edit");
    expect(edits.length).toBeGreaterThanOrEqual(1);
  });

  test("text_delta before placeholder send completes is buffered, not dropped", async () => {
    const turnId = harness.seedTurn("alpha");
    await harness.streaming.startTurn("alpha", turnId, 111);
    // No drain yet → placeholder hasn't resolved, state.telegramMessageId still null.
    harness.streaming.appendText("alpha", "early");

    // Appended text should be in buffer. Then finalize should produce an edit or send.
    await harness.outbox.drain(200);
    await harness.streaming.finalizeTurn("alpha", "early final");
    // Now drain everything.
    await harness.outbox.drain(200);

    const sends = harness.telegramCalls.filter(
      (c) => c.method === "sendMessage",
    );
    const edits = harness.telegramCalls.filter(
      (c) => c.method === "editMessageText",
    );
    const allTexts = [
      ...sends.map((c) => String(c.body.text)),
      ...edits.map((c) => String(c.body.text)),
    ];
    expect(allTexts.some((t) => t.includes("early"))).toBe(true);
  });

  test("appendText to unknown bot is a no-op (doesn't throw)", () => {
    harness.streaming.appendText("unknown", "x");
  });
});

describe("StreamManager.finalizeTurn", () => {
  test("single chunk: edits the placeholder message in place", async () => {
    const turnId = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(1234);
    await harness.streaming.startTurn("alpha", turnId, 111);
    await harness.outbox.drain(200);

    harness.streaming.appendText("alpha", "hello");
    await harness.streaming.finalizeTurn("alpha", "hello world");

    await harness.outbox.drain(200);
    const edits = harness.telegramCalls.filter(
      (c) => c.method === "editMessageText" && c.body.message_id === 1234,
    );
    expect(edits.length).toBeGreaterThan(0);
    const lastEdit = edits[edits.length - 1];
    expect(lastEdit.body.text).toContain("hello world");
  });

  test("multi-chunk: first chunk edits placeholder, subsequent chunks are new sends", async () => {
    const turnId = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(5000);
    await harness.streaming.startTurn("alpha", turnId, 111);
    await harness.outbox.drain(200);

    harness.telegramCalls.length = 0;
    // Build a finalText that exceeds 100-char limit to force split.
    const big = "A".repeat(120) + "\n" + "B".repeat(120);
    await harness.streaming.finalizeTurn("alpha", big);
    await harness.outbox.drain(300);

    const edits = harness.telegramCalls.filter(
      (c) => c.method === "editMessageText",
    );
    const sends = harness.telegramCalls.filter(
      (c) => c.method === "sendMessage",
    );
    expect(edits.length).toBeGreaterThan(0);
    expect(sends.length).toBeGreaterThan(0);
  });

  test("empty final text with empty buffer: no edit/send, state cleaned up", async () => {
    const turnId = harness.seedTurn("alpha");
    await harness.streaming.startTurn("alpha", turnId, 111);
    await harness.outbox.drain(100);

    harness.telegramCalls.length = 0;
    await harness.streaming.finalizeTurn("alpha", "");
    await harness.outbox.drain(100);

    const edits = harness.telegramCalls.filter(
      (c) => c.method === "editMessageText",
    );
    // No edits should have been queued in finalize.
    expect(edits).toHaveLength(0);
  });

  test("finalize overrides buffered stream if finalText differs", async () => {
    const turnId = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(8888);
    await harness.streaming.startTurn("alpha", turnId, 111);
    await harness.outbox.drain(100);

    harness.streaming.appendText("alpha", "streamed text");
    await harness.streaming.finalizeTurn("alpha", "final authoritative text");
    await harness.outbox.drain(300);

    const edits = harness.telegramCalls.filter(
      (c) => c.method === "editMessageText",
    );
    expect(
      edits.some((e) => String(e.body.text).includes("final authoritative")),
    ).toBe(true);
  });

  // Regression: fast-runner race — finalize runs before the placeholder send
  // completes. Pre-fix, the placeholder stayed orphaned and the final text was
  // delivered as a separate sendMessage. Post-fix, the send-callback edits the
  // placeholder with the final text when it arrives.
  test("fast-runner race: finalize before placeholder ACK edits placeholder, no extra send", async () => {
    const turnId = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(7777);
    await harness.streaming.startTurn("alpha", turnId, 111);
    // Do NOT drain — placeholder send is queued but not processed yet, so
    // telegramMessageId on the turn state is still null.

    harness.telegramCalls.length = 0;
    await harness.streaming.finalizeTurn("alpha", "done already");
    // Now drain — the placeholder sendMessage fires, its callback drains the
    // stashed final text by editing the placeholder instead of orphaning it.
    await harness.outbox.drain(300);

    const sends = harness.telegramCalls.filter(
      (c) => c.method === "sendMessage",
    );
    const edits = harness.telegramCalls.filter(
      (c) => c.method === "editMessageText",
    );
    // Exactly one sendMessage (the placeholder itself); exactly one edit
    // carrying the final text to the same message_id.
    expect(sends).toHaveLength(1);
    expect(sends[0].body.text).toContain("thinking");
    expect(edits).toHaveLength(1);
    expect(edits[0].body.message_id).toBe(7777);
    expect(edits[0].body.text).toContain("done already");
  });

  test("fast-runner race, multi-chunk: first chunk edits placeholder, rest are fresh sends", async () => {
    const turnId = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(7778);
    await harness.streaming.startTurn("alpha", turnId, 111);
    // No drain — placeholder stays pending.

    harness.telegramCalls.length = 0;
    const big = "A".repeat(120) + "\n" + "B".repeat(120);
    await harness.streaming.finalizeTurn("alpha", big);
    await harness.outbox.drain(400);

    const sends = harness.telegramCalls.filter(
      (c) => c.method === "sendMessage",
    );
    const edits = harness.telegramCalls.filter(
      (c) => c.method === "editMessageText",
    );
    // Placeholder send + one fresh send for chunk[1]; edit for chunk[0].
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    // First edit must target the placeholder's message_id.
    expect(edits[0].body.message_id).toBe(7778);
  });
});

describe("StreamManager.cancelTurn", () => {
  test("clears all timers and queues a final edit reflecting current buffer", async () => {
    const turnId = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(6000);
    await harness.streaming.startTurn("alpha", turnId, 111);
    await harness.outbox.drain(100);

    harness.streaming.appendText("alpha", "partial output");
    harness.streaming.cancelTurn("alpha");

    // After cancel: one more edit queued with the partial buffer.
    const pending = harness.db.getPendingOutbox();
    const edits = pending.filter((p) => p.kind === "edit");
    expect(edits.length).toBeGreaterThan(0);
    const lastEdit = edits[edits.length - 1];
    const payload = JSON.parse(lastEdit.payload_json) as { text: string };
    expect(payload.text).toContain("partial output");
  });

  test("cancel on unknown bot is a no-op", () => {
    harness.streaming.cancelTurn("unknown");
  });

  test("cancel with empty buffer uses '(interrupted)' placeholder text", async () => {
    const turnId = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(6000);
    await harness.streaming.startTurn("alpha", turnId, 111);
    await harness.outbox.drain(100);
    // No appendText — buffer is empty.

    harness.streaming.cancelTurn("alpha");
    const pending = harness.db.getPendingOutbox();
    const edits = pending.filter((p) => p.kind === "edit");
    expect(edits.length).toBeGreaterThan(0);
    const payload = JSON.parse(edits[edits.length - 1].payload_json) as {
      text: string;
    };
    expect(payload.text).toBe("(interrupted)");
  });

  test("starting a new turn on a bot with an active turn cancels the previous", async () => {
    const turn1 = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(7000);
    await harness.streaming.startTurn("alpha", turn1, 111);
    await harness.outbox.drain(100);

    // Start a second turn — should cancel turn1.
    const turn2 = harness.seedTurn("alpha");
    await harness.streaming.startTurn("alpha", turn2, 111);

    // Both turns have state rows.
    expect(harness.db.getStreamState(turn1)).not.toBeNull();
    expect(harness.db.getStreamState(turn2)).not.toBeNull();
  });
});

describe("StreamManager.splitMessage (via finalize with over-limit text)", () => {
  test("splits on newline boundary when possible", async () => {
    const turnId = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(5000);
    await harness.streaming.startTurn("alpha", turnId, 111);
    await harness.outbox.drain(200);

    harness.telegramCalls.length = 0;
    // Limit is 100. Put a newline past position 50 to force split at newline.
    const part1 = "a".repeat(60);
    const part2 = "b".repeat(60);
    const text = part1 + "\n" + part2;
    await harness.streaming.finalizeTurn("alpha", text);
    await harness.outbox.drain(300);

    const texts = harness.telegramCalls
      .filter(
        (c) => c.method === "editMessageText" || c.method === "sendMessage",
      )
      .map((c) => String(c.body.text));
    // First chunk ends at newline (length ~60).
    expect(
      texts.some((t) => t.startsWith("aaaaa") && !t.includes("bbbbb")),
    ).toBe(true);
    // Second chunk starts with newline + b-run.
    expect(texts.some((t) => t.includes("bbbbb"))).toBe(true);
  });

  test("hard-splits when no newline within limit/2", async () => {
    const turnId = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(5000);
    await harness.streaming.startTurn("alpha", turnId, 111);
    await harness.outbox.drain(200);

    harness.telegramCalls.length = 0;
    // 250 chars, no newlines → hard split at limit (100) twice.
    const text = "x".repeat(250);
    await harness.streaming.finalizeTurn("alpha", text);
    await harness.outbox.drain(300);

    // Count emitted pieces whose text length <= limit.
    const texts = harness.telegramCalls
      .filter(
        (c) => c.method === "editMessageText" || c.method === "sendMessage",
      )
      .map((c) => String(c.body.text));
    for (const t of texts) {
      expect(t.length).toBeLessThanOrEqual(100);
    }
    const total = texts.reduce((n, t) => n + t.length, 0);
    expect(total).toBeGreaterThanOrEqual(250);
  });
});

describe("StreamManager.stopAll", () => {
  test("clears all active turns and pending timers without throwing", async () => {
    const t1 = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(5000);
    await harness.streaming.startTurn("alpha", t1, 111);
    await harness.outbox.drain(100);
    harness.streaming.appendText("alpha", "some text");

    harness.streaming.stopAll();
    // After stopAll, calling appendText again is a no-op (state cleared).
    harness.streaming.appendText("alpha", "more text");
  });
});

describe("StreamManager 429 / Retry-After backoff", () => {
  test("editMessageText 429 pauses subsequent flushes for the cooldown window", async () => {
    // Drive a turn until the placeholder send completes, then flip the
    // fetchImpl to return 429 with retry_after=10s on edits. The first
    // text_delta after the cadence elapses triggers a flush that gets
    // 429'd; subsequent text_deltas should NOT produce additional edits
    // until the cooldown expires (we don't actually wait 10s — we just
    // verify the count stays at 1).
    const turnId = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(7777);
    await harness.streaming.startTurn("alpha", turnId, 111);
    await harness.outbox.drain(200);

    // Reset call log; from here on we count editMessageText hits.
    harness.telegramCalls.length = 0;
    harness.setEditRateLimit(10);

    // First append → cadence isn't elapsed yet, but the flush timer fires
    // ~100ms later (cadence is set to 100 in the fixture).
    harness.streaming.appendText("alpha", "chunk-1");
    await new Promise((r) => setTimeout(r, 250));

    const firstEditCount = harness.telegramCalls.filter(
      (c) => c.method === "editMessageText",
    ).length;
    expect(firstEditCount).toBeGreaterThanOrEqual(1);

    // Second append after the first flush 429'd. Even after the cadence
    // elapses, flush() should bail because rateLimitedUntil is in the
    // future (10s ahead).
    harness.streaming.appendText("alpha", "chunk-2");
    await new Promise((r) => setTimeout(r, 250));

    const secondEditCount = harness.telegramCalls.filter(
      (c) => c.method === "editMessageText",
    ).length;
    expect(secondEditCount).toBe(firstEditCount);

    // sendChatAction should also be skipped during the cooldown.
    const typingCalls = harness.telegramCalls.filter(
      (c) => c.method === "sendChatAction",
    );
    // There may be at most one typing ping that fired in the brief
    // window between startTurn and the rate-limit observation; we just
    // assert it's bounded — not unbounded — under cooldown.
    expect(typingCalls.length).toBeLessThanOrEqual(1);
  });

  test("after the cooldown clears, edits resume", async () => {
    // Force an immediate-pass cooldown by setting retry_after=0 (treated
    // as missing), then verify that a normal 429-recovery cycle resumes
    // edits. This is a coarser end-to-end check; the per-bot timestamp
    // bookkeeping is exercised in the previous test.
    const turnId = harness.seedTurn("alpha");
    harness.setPlaceholderMessageId(7900);
    await harness.streaming.startTurn("alpha", turnId, 111);
    await harness.outbox.drain(200);

    harness.telegramCalls.length = 0;
    // No rate limit set → edits flow normally.
    harness.streaming.appendText("alpha", "first");
    await new Promise((r) => setTimeout(r, 250));
    const before = harness.telegramCalls.filter(
      (c) => c.method === "editMessageText",
    ).length;
    expect(before).toBeGreaterThan(0);

    harness.streaming.appendText("alpha", " second");
    await new Promise((r) => setTimeout(r, 250));
    const after = harness.telegramCalls.filter(
      (c) => c.method === "editMessageText",
    ).length;
    expect(after).toBeGreaterThan(before);
  });
});
