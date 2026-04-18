import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { GatewayDB } from "./db.js";
import { StreamManager } from "./streaming.js";
import { OutboxProcessor } from "./outbox.js";
import type { Config, PersonaName } from "./config.js";
import type { TelegramClient } from "./telegram.js";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Minimal config for streaming tests
const testConfig: Config = {
  port: 3000,
  dataRoot: "/tmp",
  dbPath: "",
  webhookBaseUrl: "https://test.example.com",
  webhookSecret: "secret",
  allowedUserId: "123",
  logLevel: "error",
  botTokens: { cato: "t1", harper: "t2", trader: "t3" },
  workerStartupTimeoutMs: 60000,
  workerStallTimeoutMs: 90000,
  workerTurnTimeoutMs: 1200000,
  crashLoopBackoffBaseMs: 5000,
  crashLoopBackoffCapMs: 300000,
  stabilityWindowMs: 600000,
  maxConsecutiveFailures: 10,
  editCadenceMs: 100, // Fast for tests
  messageLengthLimit: 4096,
  messageLengthSafeMargin: 3800,
  outboxMaxAttempts: 5,
  outboxRetryBaseMs: 100,
  oauthToken: "token",
  githubToken: "ghtoken",
};

let db: GatewayDB;
let dbPath: string;

beforeEach(() => {
  dbPath = join(tmpdir(), `gateway-stream-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  testConfig.dbPath = dbPath;
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  try { unlinkSync(dbPath); } catch {}
  try { unlinkSync(dbPath + "-wal"); } catch {}
  try { unlinkSync(dbPath + "-shm"); } catch {}
});

function setupTurn(): { turnId: number; updateId: number } {
  const updateId = db.insertUpdate("cato", 100, 123, 456, "user1", '{"message":{"text":"hi"}}')!;
  const turnId = db.createTurn("cato", 123, updateId);
  return { turnId, updateId };
}

describe("StreamManager.splitMessage (via finalizeTurn)", () => {
  test("short message stays as one chunk", async () => {
    const sentTexts: string[] = [];
    const editedTexts: string[] = [];

    const mockOutbox = {
      queueSendWithCallback: mock((turnId: number, persona: PersonaName, chatId: number, text: string, cb: (id: number) => void) => {
        sentTexts.push(text);
        cb(1000); // Simulate immediate send
        return 1;
      }),
      queueSend: mock((turnId: number, persona: PersonaName, chatId: number, text: string) => {
        sentTexts.push(text);
        return 2;
      }),
      queueEdit: mock((turnId: number, persona: PersonaName, chatId: number, msgId: number, text: string) => {
        editedTexts.push(text);
        return 3;
      }),
      fireAndForgetEdit: mock(async () => {}),
    } as unknown as OutboxProcessor;

    const stream = new StreamManager(testConfig, db, mockOutbox, new Map());
    const { turnId } = setupTurn();

    await stream.startTurn("cato", turnId, 123);
    stream.appendText("cato", "Hello world");
    await stream.finalizeTurn("cato", "Hello world");

    // Should have: 1 placeholder send + 1 final edit
    expect(sentTexts[0]).toBe("\u{1F440} thinking...");
    expect(editedTexts[0]).toBe("Hello world");
  });

  test("long message is split at newlines", async () => {
    const sentTexts: string[] = [];
    const editedTexts: string[] = [];

    const mockOutbox = {
      queueSendWithCallback: mock((turnId: number, persona: PersonaName, chatId: number, text: string, cb: (id: number) => void) => {
        sentTexts.push(text);
        cb(1000);
        return 1;
      }),
      queueSend: mock((turnId: number, persona: PersonaName, chatId: number, text: string) => {
        sentTexts.push(text);
        return 2;
      }),
      queueEdit: mock((turnId: number, persona: PersonaName, chatId: number, msgId: number, text: string) => {
        editedTexts.push(text);
        return 3;
      }),
      fireAndForgetEdit: mock(async () => {}),
    } as unknown as OutboxProcessor;

    const shortLimitConfig = { ...testConfig, messageLengthLimit: 50 };
    const stream = new StreamManager(shortLimitConfig, db, mockOutbox, new Map());
    const { turnId } = setupTurn();

    await stream.startTurn("cato", turnId, 123);

    // 80 chars total — should split into 2 chunks at limit 50
    const longText = "A".repeat(30) + "\n" + "B".repeat(49);
    await stream.finalizeTurn("cato", longText);

    // First chunk edited into placeholder, second sent as new message
    expect(editedTexts.length).toBeGreaterThanOrEqual(1);
    expect(sentTexts.length).toBeGreaterThanOrEqual(2); // placeholder + overflow
  });
});

describe("StreamManager.appendText", () => {
  test("sets first output flag on first append", async () => {
    const mockOutbox = {
      queueSendWithCallback: mock((t: any, p: any, c: any, text: string, cb: any) => { cb(1000); return 1; }),
      queueSend: mock(() => 2),
      queueEdit: mock(() => 3),
      fireAndForgetEdit: mock(async () => {}),
    } as unknown as OutboxProcessor;

    const stream = new StreamManager(testConfig, db, mockOutbox, new Map());
    const { turnId } = setupTurn();
    db.startTurn(turnId, 1);

    await stream.startTurn("cato", turnId, 123);
    stream.appendText("cato", "chunk1");

    // first_output_at should be set
    const running = db.getRunningTurns();
    expect(running).toHaveLength(1);
    expect(running[0].first_output_at).not.toBeNull();
  });
});
