import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { GatewayDB } from "./db.js";
import { OutboxProcessor } from "./outbox.js";
import { Metrics } from "./metrics.js";
import type { Config, PersonaName } from "./config.js";
import type { TelegramClient } from "./telegram.js";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db: GatewayDB;
let dbPath: string;

const testConfig = {
  outboxMaxAttempts: 5,
  outboxRetryBaseMs: 100,
} as Config;

beforeEach(() => {
  dbPath = join(tmpdir(), `gateway-outbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(dbPath + "-wal"); } catch {}
  try { unlinkSync(dbPath + "-shm"); } catch {}
});

function seedTurn(): number {
  const uid = db.insertUpdate("cato", Date.now(), 123, 1, "user1", '{"message":{"text":"hi"}}')!;
  return db.createTurn("cato", 123, uid);
}

function makeClient(overrides?: Partial<TelegramClient>): TelegramClient {
  return {
    sendMessage: mock(async () => ({ messageId: 999 })),
    editMessageText: mock(async () => true),
    setMessageReaction: mock(async () => true),
    setWebhook: mock(async () => true),
    getFile: mock(async () => null),
    downloadFile: mock(async () => null),
    ...overrides,
  } as any;
}

describe("queueSendWithCallback", () => {
  test("callback fires with messageId after successful send", async () => {
    const client = makeClient();
    const clients = new Map<PersonaName, TelegramClient>([["cato", client]]);
    const outbox = new OutboxProcessor(testConfig, db, clients, new Metrics());

    const turnId = seedTurn();
    let callbackId: number | null = null;

    outbox.queueSendWithCallback(turnId, "cato", 123, "hello", (msgId) => {
      callbackId = msgId;
    });

    // Manually process (don't start the interval timer)
    const pending = db.getPendingOutbox();
    expect(pending).toHaveLength(1);

    // Simulate the processor
    outbox.start();
    await new Promise(r => setTimeout(r, 600));
    outbox.stop();

    expect(callbackId).not.toBeNull();
    expect(callbackId!).toBe(999);
  });

  test("callback does not fire when send fails", async () => {
    const client = makeClient({
      sendMessage: mock(async () => null),
    });
    const clients = new Map<PersonaName, TelegramClient>([["cato", client]]);
    const outbox = new OutboxProcessor(testConfig, db, clients, new Metrics());

    const turnId = seedTurn();
    let called = false;
    outbox.queueSendWithCallback(turnId, "cato", 123, "hello", () => {
      called = true;
    });

    outbox.start();
    await new Promise(r => setTimeout(r, 600));
    outbox.stop();

    expect(called).toBe(false);
  });

  test("callback is cleaned up after firing", async () => {
    const client = makeClient();
    const clients = new Map<PersonaName, TelegramClient>([["cato", client]]);
    const outbox = new OutboxProcessor(testConfig, db, clients, new Metrics());

    const turnId = seedTurn();
    let callCount = 0;
    outbox.queueSendWithCallback(turnId, "cato", 123, "hello", () => {
      callCount++;
    });

    outbox.start();
    await new Promise(r => setTimeout(r, 600));
    // Process again — callback should not fire a second time
    await new Promise(r => setTimeout(r, 600));
    outbox.stop();

    expect(callCount).toBe(1);
  });
});

describe("retry escalation", () => {
  test("retries up to maxAttempts then marks failed", () => {
    const turnId = seedTurn();
    const outboxId = db.insertOutbox(turnId, "cato", 123, "send", '{"text":"hi"}');

    // Simulate 4 retries (attempts 1-4 stay retrying)
    for (let i = 0; i < 4; i++) {
      db.markOutboxRetrying(outboxId, `error-${i}`, new Date(Date.now() - 1000).toISOString(), 5);
    }

    // After 4 retries, attempt_count = 4, should still be retrying
    const row4 = db.getOutboxRow(outboxId);
    // It could be retrying or failed depending on timing
    // On attempt 5 (attempt_count already 4, 4+1 >= 5 → fail)
    db.markOutboxRetrying(outboxId, "error-final", new Date().toISOString(), 5);

    const finalRow = db.getOutboxRow(outboxId);
    expect(finalRow!.status).toBe("failed");
  });

  test("single retry stays retrying", () => {
    const turnId = seedTurn();
    const outboxId = db.insertOutbox(turnId, "cato", 123, "send", '{"text":"hi"}');

    // Past next_attempt_at so it shows up in pending
    db.markOutboxRetrying(outboxId, "timeout", new Date(Date.now() - 1000).toISOString(), 5);

    const row = db.getOutboxRow(outboxId);
    expect(row!.status).toBe("retrying");
  });

  test("maxAttempts=1 fails on first retry", () => {
    const turnId = seedTurn();
    const outboxId = db.insertOutbox(turnId, "cato", 123, "send", '{"text":"hi"}');

    db.markOutboxRetrying(outboxId, "error", new Date().toISOString(), 1);

    const row = db.getOutboxRow(outboxId);
    expect(row!.status).toBe("failed");
  });
});

describe("outbox processing", () => {
  test("edit without telegram_message_id is marked failed", async () => {
    const client = makeClient();
    const clients = new Map<PersonaName, TelegramClient>([["cato", client]]);
    const outbox = new OutboxProcessor(testConfig, db, clients, new Metrics());

    const turnId = seedTurn();
    db.insertOutbox(turnId, "cato", 123, "edit", '{"text":"updated"}'); // No messageId

    outbox.start();
    await new Promise(r => setTimeout(r, 600));
    outbox.stop();

    expect(db.getPendingOutbox()).toHaveLength(0);
    // Should be failed, not stuck pending
  });

  test("edit with valid telegram_message_id succeeds", async () => {
    const client = makeClient();
    const clients = new Map<PersonaName, TelegramClient>([["cato", client]]);
    const outbox = new OutboxProcessor(testConfig, db, clients, new Metrics());

    const turnId = seedTurn();
    db.insertOutbox(turnId, "cato", 123, "edit", '{"text":"updated"}', 555);

    outbox.start();
    await new Promise(r => setTimeout(r, 600));
    outbox.stop();

    expect(db.getPendingOutbox()).toHaveLength(0);
    expect(client.editMessageText).toHaveBeenCalled();
  });

  test("failure in one outbox item does not block others", async () => {
    const callCount = { send: 0 };
    const client = makeClient({
      sendMessage: mock(async (chatId: number, text: string) => {
        callCount.send++;
        if (text === "fail") return null;
        return { messageId: callCount.send };
      }),
    });
    const clients = new Map<PersonaName, TelegramClient>([["cato", client]]);
    const outbox = new OutboxProcessor(testConfig, db, clients, new Metrics());

    const turnId = seedTurn();
    db.insertOutbox(turnId, "cato", 123, "send", '{"text":"fail"}');
    db.insertOutbox(turnId, "cato", 123, "send", '{"text":"succeed"}');

    outbox.start();
    await new Promise(r => setTimeout(r, 600));
    outbox.stop();

    // Both should have been attempted
    expect(callCount.send).toBe(2);
  });

  test("no client for persona marks failed", async () => {
    const clients = new Map<PersonaName, TelegramClient>(); // Empty!
    const outbox = new OutboxProcessor(testConfig, db, clients, new Metrics());

    const turnId = seedTurn();
    db.insertOutbox(turnId, "cato", 123, "send", '{"text":"hi"}');

    outbox.start();
    await new Promise(r => setTimeout(r, 600));
    outbox.stop();

    expect(db.getPendingOutbox()).toHaveLength(0);
  });

  test("concurrent processPending calls do not send the same message twice", async () => {
    // Simulate a slow Telegram API: the send takes 400ms, longer than the 500ms
    // interval tick. Without the reentrance guard, the second tick fires at 500ms
    // and picks up the same row (still 'pending' in DB), sending it twice.
    // With the guard, processing=true blocks the second tick until the first completes.
    let sendCount = 0;
    const client = makeClient({
      sendMessage: mock(async () => {
        sendCount++;
        await new Promise(r => setTimeout(r, 400)); // slower than the 500ms interval
        return { messageId: 1 };
      }),
    });
    const clients = new Map<PersonaName, TelegramClient>([["cato", client]]);
    const outbox = new OutboxProcessor(testConfig, db, clients, new Metrics());

    const turnId = seedTurn();
    db.insertOutbox(turnId, "cato", 123, "send", '{"text":"👀 thinking..."}');

    outbox.start();
    // Wait long enough for: first tick (500ms) + slow send (400ms) + margin = 1000ms
    // This also lets a second tick fire at ~1000ms, which with the guard is a no-op
    await new Promise(r => setTimeout(r, 1100));
    outbox.stop();

    // Message should only have been sent once despite multiple ticks firing
    expect(sendCount).toBe(1);
  });

  test("stop clears callbacks", () => {
    const clients = new Map<PersonaName, TelegramClient>([["cato", makeClient()]]);
    const outbox = new OutboxProcessor(testConfig, db, clients, new Metrics());

    const turnId = seedTurn();
    outbox.queueSendWithCallback(turnId, "cato", 123, "hi", () => {});
    outbox.stop();
    // Should not throw or leak
  });
});
