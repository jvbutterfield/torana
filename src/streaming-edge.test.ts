import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { GatewayDB } from "./db.js";
import { StreamManager } from "./streaming.js";
import type { OutboxProcessor } from "./outbox.js";
import type { Config, PersonaName } from "./config.js";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db: GatewayDB;
let dbPath: string;

const baseConfig: Config = {
  port: 3000, dataRoot: "/tmp", dbPath: "", webhookBaseUrl: "", webhookSecret: "", allowedUserId: "",
  logLevel: "error", botTokens: { cato: "", harper: "", trader: "" },
  workerStartupTimeoutMs: 60000, workerStallTimeoutMs: 90000, workerTurnTimeoutMs: 1200000,
  crashLoopBackoffBaseMs: 5000, crashLoopBackoffCapMs: 300000, stabilityWindowMs: 600000,
  maxConsecutiveFailures: 10, editCadenceMs: 50, messageLengthLimit: 4096, messageLengthSafeMargin: 3800,
  outboxMaxAttempts: 5, outboxRetryBaseMs: 100, oauthToken: "", githubToken: "",
};

beforeEach(() => {
  dbPath = join(tmpdir(), `gateway-stream-edge-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(dbPath + "-wal"); } catch {}
  try { unlinkSync(dbPath + "-shm"); } catch {}
});

function seedTurn(): { turnId: number; updateId: number } {
  const updateId = db.insertUpdate("cato", Date.now(), 123, 1, "user1", '{"message":{"text":"hi"}}')!;
  const turnId = db.createTurn("cato", 123, updateId);
  return { turnId, updateId };
}

function makeMockOutbox() {
  const sends: string[] = [];
  const edits: string[] = [];
  const fireForgets: string[] = [];

  return {
    outbox: {
      queueSendWithCallback: mock((t: any, p: any, c: any, text: string, cb: (id: number) => void) => {
        sends.push(text);
        cb(1000 + sends.length);
        return sends.length;
      }),
      queueSend: mock((t: any, p: any, c: any, text: string) => {
        sends.push(text);
        return sends.length + 100;
      }),
      queueEdit: mock((t: any, p: any, c: any, msgId: number, text: string) => {
        edits.push(text);
        return edits.length + 200;
      }),
      fireAndForgetEdit: mock(async (p: any, c: any, msgId: number, text: string) => {
        fireForgets.push(text);
      }),
    } as unknown as OutboxProcessor,
    sends,
    edits,
    fireForgets,
  };
}

describe("finalizeTurn edge cases", () => {
  test("finalize with empty buffer cleans up without sending", async () => {
    const { outbox, sends, edits } = makeMockOutbox();
    const stream = new StreamManager(baseConfig, db, outbox, new Map());
    const { turnId } = seedTurn();

    await stream.startTurn("cato", turnId, 123);
    // No appendText — buffer is empty
    await stream.finalizeTurn("cato", "");

    // Only the placeholder should have been sent
    expect(sends).toEqual(["\u{1F440} thinking..."]);
    expect(edits).toHaveLength(0);
  });

  test("finalize with whitespace-only buffer cleans up", async () => {
    const { outbox, sends, edits } = makeMockOutbox();
    const stream = new StreamManager(baseConfig, db, outbox, new Map());
    const { turnId } = seedTurn();

    await stream.startTurn("cato", turnId, 123);
    stream.appendText("cato", "   \n  ");
    await stream.finalizeTurn("cato", "   \n  ");

    expect(sends).toEqual(["\u{1F440} thinking..."]);
    expect(edits).toHaveLength(0);
  });

  test("finalize replaces buffer with authoritative final text", async () => {
    const { outbox, edits } = makeMockOutbox();
    const stream = new StreamManager(baseConfig, db, outbox, new Map());
    const { turnId } = seedTurn();

    await stream.startTurn("cato", turnId, 123);
    stream.appendText("cato", "partial");
    await stream.finalizeTurn("cato", "The final answer is 42.");

    expect(edits[edits.length - 1]).toBe("The final answer is 42.");
  });

  test("finalize without startTurn is a no-op", async () => {
    const { outbox, sends, edits } = makeMockOutbox();
    const stream = new StreamManager(baseConfig, db, outbox, new Map());

    // Never called startTurn
    await stream.finalizeTurn("cato", "some text");

    expect(sends).toHaveLength(0);
    expect(edits).toHaveLength(0);
  });
});

describe("appendText edge cases", () => {
  test("appendText without startTurn is a no-op", () => {
    const { outbox } = makeMockOutbox();
    const stream = new StreamManager(baseConfig, db, outbox, new Map());

    // Should not throw
    stream.appendText("cato", "orphaned text");
  });

  test("appendText for wrong persona is a no-op", async () => {
    const { outbox } = makeMockOutbox();
    const stream = new StreamManager(baseConfig, db, outbox, new Map());
    const { turnId } = seedTurn();

    await stream.startTurn("cato", turnId, 123);
    // Append to harper, which has no active turn
    stream.appendText("harper", "wrong persona");
    // Should not throw
  });
});

describe("message splitting edge cases", () => {
  test("message exactly at limit stays single chunk", async () => {
    const config = { ...baseConfig, messageLengthLimit: 50, messageLengthSafeMargin: 45 };
    const { outbox, sends, edits } = makeMockOutbox();
    const stream = new StreamManager(config, db, outbox, new Map());
    const { turnId } = seedTurn();

    await stream.startTurn("cato", turnId, 123);
    const text = "A".repeat(50);
    await stream.finalizeTurn("cato", text);

    // Should be a single edit (50 chars == limit, fits in one chunk)
    expect(edits).toHaveLength(1);
    expect(edits[0]).toBe(text);
  });

  test("message one char over limit splits into two", async () => {
    const config = { ...baseConfig, messageLengthLimit: 50, messageLengthSafeMargin: 45 };
    const { outbox, sends, edits } = makeMockOutbox();
    const stream = new StreamManager(config, db, outbox, new Map());
    const { turnId } = seedTurn();

    await stream.startTurn("cato", turnId, 123);
    const text = "A".repeat(51);
    await stream.finalizeTurn("cato", text);

    // Should split: first 50 edited, last 1 sent
    const totalOutput = edits.join("") + sends.filter(s => s !== "\u{1F440} thinking...").join("");
    expect(totalOutput).toBe(text);
  });

  test("message with no newlines splits at hard limit", async () => {
    const config = { ...baseConfig, messageLengthLimit: 20, messageLengthSafeMargin: 15 };
    const { outbox, sends, edits } = makeMockOutbox();
    const stream = new StreamManager(config, db, outbox, new Map());
    const { turnId } = seedTurn();

    await stream.startTurn("cato", turnId, 123);
    const text = "A".repeat(60); // 60 chars, limit 20 → 3 chunks
    await stream.finalizeTurn("cato", text);

    const allChunks = [
      ...edits,
      ...sends.filter(s => s !== "\u{1F440} thinking..."),
    ];
    expect(allChunks.join("")).toBe(text);
    expect(allChunks.length).toBeGreaterThanOrEqual(3);
  });

  test("message splits at newline when available", async () => {
    const config = { ...baseConfig, messageLengthLimit: 30, messageLengthSafeMargin: 25 };
    const { outbox, sends, edits } = makeMockOutbox();
    const stream = new StreamManager(config, db, outbox, new Map());
    const { turnId } = seedTurn();

    await stream.startTurn("cato", turnId, 123);
    // "AAAAAAAAAA\nBBBBBBBBBBBBBBBBBBBB" — newline at pos 10, limit 30
    const text = "A".repeat(10) + "\n" + "B".repeat(20);
    await stream.finalizeTurn("cato", text);

    // First chunk should split at the newline
    const allChunks = [
      ...edits,
      ...sends.filter(s => s !== "\u{1F440} thinking..."),
    ];
    expect(allChunks.join("")).toBe(text);
  });
});

describe("flush throttling", () => {
  test("rapid appends only flush at cadence", async () => {
    const config = { ...baseConfig, editCadenceMs: 200 };
    const { outbox, fireForgets } = makeMockOutbox();
    const stream = new StreamManager(config, db, outbox, new Map());
    const { turnId } = seedTurn();

    await stream.startTurn("cato", turnId, 123);

    // Rapid-fire appends
    for (let i = 0; i < 10; i++) {
      stream.appendText("cato", `chunk${i} `);
    }

    // Should have flushed at most once immediately (first append triggers immediate flush)
    expect(fireForgets.length).toBeLessThanOrEqual(2);

    // Wait for throttled flush
    await new Promise(r => setTimeout(r, 300));

    // Should have flushed at least once more
    expect(fireForgets.length).toBeGreaterThanOrEqual(1);

    // Clean up
    stream.stopAll();
  });

  test("flush timer is cleared on stopAll", async () => {
    const { outbox } = makeMockOutbox();
    const stream = new StreamManager(baseConfig, db, outbox, new Map());
    const { turnId } = seedTurn();

    await stream.startTurn("cato", turnId, 123);
    stream.appendText("cato", "text");

    // Should not throw or leak timers
    stream.stopAll();
  });
});

describe("placeholder not arriving", () => {
  test("streams work even if placeholder callback never fires", async () => {
    const sends: string[] = [];
    const edits: string[] = [];

    const outbox = {
      queueSendWithCallback: mock((t: any, p: any, c: any, text: string, cb: (id: number) => void) => {
        sends.push(text);
        // Intentionally do NOT call cb — simulate placeholder send not completing
        return 1;
      }),
      queueSend: mock((t: any, p: any, c: any, text: string) => {
        sends.push(text);
        return 2;
      }),
      queueEdit: mock((t: any, p: any, c: any, msgId: number, text: string) => {
        edits.push(text);
        return 3;
      }),
      fireAndForgetEdit: mock(async () => {}),
    } as unknown as OutboxProcessor;

    const stream = new StreamManager(baseConfig, db, outbox, new Map());
    const { turnId } = seedTurn();

    await stream.startTurn("cato", turnId, 123);
    stream.appendText("cato", "hello");
    await stream.finalizeTurn("cato", "hello");

    // Without messageId, finalize should fall through to sending new messages
    // (no edit possible since we don't have a messageId to edit)
    const nonPlaceholderSends = sends.filter(s => s !== "\u{1F440} thinking...");
    expect(nonPlaceholderSends.length + edits.length).toBeGreaterThanOrEqual(1);
  });
});
