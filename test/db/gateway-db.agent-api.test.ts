// Agent API additions to GatewayDB: user_chats, idempotency, side_sessions,
// synthetic-inbound allocator, insertAskTurn/insertSendTurn, getTurnExtended,
// and the extended getTurnText branch for send payloads.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";

let tmpDir: string;
let dbPath: string;
let db: GatewayDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-gdb-aa-"));
  dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("gateway-db: user_chats", () => {
  test("upsertUserChat + getLastChatForUser round-trip", () => {
    db.upsertUserChat("bot1", "42", 111);
    expect(db.getLastChatForUser("bot1", "42")).toEqual({ chat_id: 111 });
    expect(db.getLastChatForUser("bot1", "99")).toBeNull();
    expect(db.getLastChatForUser("bot2", "42")).toBeNull();
  });

  test("upsertUserChat updates existing chat_id", () => {
    db.upsertUserChat("bot1", "42", 111);
    db.upsertUserChat("bot1", "42", 222);
    expect(db.getLastChatForUser("bot1", "42")).toEqual({ chat_id: 222 });
  });

  test("listUserChatsByBot returns all chats for a bot", () => {
    db.upsertUserChat("bot1", "42", 111);
    db.upsertUserChat("bot1", "43", 222);
    db.upsertUserChat("bot2", "44", 333);
    const list = db
      .listUserChatsByBot("bot1")
      .map((r) => r.chat_id)
      .sort();
    expect(list).toEqual([111, 222]);
  });
});

describe("gateway-db: side_sessions", () => {
  test("upsert + list + state transitions + delete", () => {
    const now = new Date().toISOString();
    db.upsertSideSession({
      botId: "bot1",
      sessionId: "sess-1",
      pid: 123,
      startedAt: now,
      lastUsedAt: now,
      hardExpiresAt: now,
      state: "starting",
    });
    let rows = db.listSideSessions("bot1");
    expect(rows.length).toBe(1);
    expect(rows[0]!.state).toBe("starting");

    db.markSideSessionState("bot1", "sess-1", "ready");
    rows = db.listSideSessions("bot1");
    expect(rows[0]!.state).toBe("ready");

    db.deleteSideSession("bot1", "sess-1");
    expect(db.listSideSessions("bot1").length).toBe(0);
  });

  test("markAllSideSessionsStopped clears leftover state", () => {
    const now = new Date().toISOString();
    db.upsertSideSession({
      botId: "bot1",
      sessionId: "sess-a",
      pid: null,
      startedAt: now,
      lastUsedAt: now,
      hardExpiresAt: now,
      state: "ready",
    });
    db.upsertSideSession({
      botId: "bot1",
      sessionId: "sess-b",
      pid: null,
      startedAt: now,
      lastUsedAt: now,
      hardExpiresAt: now,
      state: "busy",
    });
    db.markAllSideSessionsStopped();
    const states = db
      .listSideSessions("bot1")
      .map((r) => r.state)
      .sort();
    expect(states).toEqual(["stopped", "stopped"]);
  });
});

describe("gateway-db: insertAskTurn", () => {
  test("creates turn with status=running and synthetic inbound", () => {
    const turnId = db.insertAskTurn({
      botId: "bot1",
      tokenName: "cos",
      sessionId: "s1",
      textPreview: "hello",
      attachmentPaths: [],
    });
    expect(typeof turnId).toBe("number");

    const turn = db.getTurnExtended(turnId)!;
    expect(turn.status).toBe("running");
    expect(turn.source).toBe("agent_api_ask");
    expect(turn.agent_api_token_name).toBe("cos");
    expect(turn.chat_id).toBe(0);

    const inbound = JSON.parse(turn.inbound_payload_json!);
    expect(inbound.kind).toBe("ask");
    expect(inbound.session_id).toBe("s1");
  });

  test("two concurrent ask turns get distinct negative inbound ids", () => {
    const id1 = db.insertAskTurn({
      botId: "bot1",
      tokenName: "cos",
      sessionId: "s1",
      textPreview: "a",
      attachmentPaths: [],
    });
    const id2 = db.insertAskTurn({
      botId: "bot1",
      tokenName: "cos",
      sessionId: "s1",
      textPreview: "b",
      attachmentPaths: [],
    });
    expect(id1).not.toBe(id2);
    const t1 = db.getTurnExtended(id1)!;
    const t2 = db.getTurnExtended(id2)!;
    expect(t1.source_update_id).not.toBe(t2.source_update_id);
  });
});

describe("gateway-db: insertSendTurn + idempotency", () => {
  test("creates queued turn with marker prompt on inbound payload", () => {
    const out = db.insertSendTurn({
      botId: "bot1",
      tokenName: "cal",
      chatId: 555,
      markerWrappedText: '[system-message from "cron"]\n\nhello',
      idempotencyKey: "abcdefghijklmnop",
      sourceLabel: "cron",
      attachmentPaths: [],
    });
    expect(out.replay).toBe(false);

    const turn = db.getTurnExtended(out.turnId)!;
    expect(turn.status).toBe("queued");
    expect(turn.source).toBe("agent_api_send");
    expect(turn.chat_id).toBe(555);
    expect(turn.idempotency_key).toBe("abcdefghijklmnop");
    expect(turn.agent_api_source_label).toBe("cron");

    // Prompt is recovered via extended getTurnText.
    expect(db.getTurnText(out.turnId)).toBe(
      '[system-message from "cron"]\n\nhello',
    );
  });

  test("duplicate idempotency key returns replay with same turn id", () => {
    const first = db.insertSendTurn({
      botId: "bot1",
      tokenName: "cal",
      chatId: 555,
      markerWrappedText: "first",
      idempotencyKey: "samekeysamekey12",
      sourceLabel: "cron",
      attachmentPaths: [],
    });
    const second = db.insertSendTurn({
      botId: "bot1",
      tokenName: "cal",
      chatId: 555,
      markerWrappedText: "second — should be ignored",
      idempotencyKey: "samekeysamekey12",
      sourceLabel: "cron",
      attachmentPaths: [],
    });
    expect(second.replay).toBe(true);
    expect(second.turnId).toBe(first.turnId);

    // Body of the stored turn reflects the ORIGINAL text.
    expect(db.getTurnText(first.turnId)).toBe("first");
  });
});

describe("gateway-db: setTurnFinalText + sweepIdempotency", () => {
  test("setTurnFinalText marks completed and stores usage", () => {
    const id = db.insertAskTurn({
      botId: "bot1",
      tokenName: "cos",
      sessionId: "s1",
      textPreview: "hi",
      attachmentPaths: [],
    });
    db.setTurnFinalText(
      id,
      "the answer",
      JSON.stringify({ input_tokens: 5 }),
      1234,
    );
    const t = db.getTurnExtended(id)!;
    expect(t.status).toBe("completed");
    expect(t.final_text).toBe("the answer");
    expect(t.duration_ms).toBe(1234);
  });

  test("sweepIdempotency deletes rows below threshold", async () => {
    const out = db.insertSendTurn({
      botId: "bot1",
      tokenName: "cal",
      chatId: 1,
      markerWrappedText: "x",
      idempotencyKey: "keykeykeykeykey1",
      sourceLabel: "cron",
      attachmentPaths: [],
    });
    expect(out.replay).toBe(false);
    expect(db.getIdempotencyTurn("bot1", "keykeykeykeykey1")).toBe(out.turnId);

    // Threshold far in the future → sweeps everything.
    const deleted = db.sweepIdempotency(Date.now() + 60_000);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(db.getIdempotencyTurn("bot1", "keykeykeykeykey1")).toBeNull();
  });
});

describe("gateway-db: getTurnText telegram-parity", () => {
  test("returns message.text for telegram-origin rows", () => {
    // Seed an inbound manually + createTurn, same as the telegram path.
    db.exec(
      `INSERT INTO inbound_updates (bot_id, telegram_update_id, chat_id, message_id, from_user_id, payload_json, status)
       VALUES ('bot1', 42, 100, 1, '99', '{"message":{"text":"hello world"}}', 'enqueued')`,
    );
    const inboundId = (
      db
        ._unsafeQuery(
          "SELECT id FROM inbound_updates WHERE telegram_update_id = 42",
        )
        .get() as { id: number }
    ).id;
    const turnId = db.createTurn("bot1", 100, inboundId, []);
    expect(db.getTurnText(turnId)).toBe("hello world");
  });

  test("returns null for ask rows (payload has no prompt field)", () => {
    const id = db.insertAskTurn({
      botId: "bot1",
      tokenName: "cos",
      sessionId: "s1",
      textPreview: "hi",
      attachmentPaths: [],
    });
    expect(db.getTurnText(id)).toBeNull();
  });
});
