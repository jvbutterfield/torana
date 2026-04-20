// Unit tests for resolveChatId — covers all three error codes + both
// resolution modes (user_id lookup, chat_id pass-through).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { resolveChatId } from "../../src/agent-api/chat-resolve.js";

let tmpDir: string;
let db: GatewayDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-chat-resolve-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveChatId", () => {
  test("missing_target when neither user_id nor chat_id provided", () => {
    const r = resolveChatId(db, "bot1", {});
    expect(r.kind).toBe("err");
    if (r.kind === "err") expect(r.code).toBe("missing_target");
  });

  test("user_not_opened_bot when user has never DMed", () => {
    const r = resolveChatId(db, "bot1", { user_id: "42" });
    expect(r.kind).toBe("err");
    if (r.kind === "err") expect(r.code).toBe("user_not_opened_bot");
  });

  test("chat_not_permitted when chat_id is not in user_chats for this bot", () => {
    db.upsertUserChat("bot1", "42", 555);
    const r = resolveChatId(db, "bot1", { chat_id: 999 });
    expect(r.kind).toBe("err");
    if (r.kind === "err") expect(r.code).toBe("chat_not_permitted");
  });

  test("user_id happy path returns the most-recent chat", () => {
    db.upsertUserChat("bot1", "42", 555);
    const r = resolveChatId(db, "bot1", { user_id: "42" });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.chatId).toBe(555);
  });

  test("chat_id pass-through works when chat is known for this bot", () => {
    db.upsertUserChat("bot1", "42", 555);
    const r = resolveChatId(db, "bot1", { chat_id: 555 });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.chatId).toBe(555);
  });

  test("chat_not_permitted when the chat belongs to another bot", () => {
    db.upsertUserChat("bot1", "42", 555);
    // bot2 has no user_chats at all.
    const r = resolveChatId(db, "bot2", { chat_id: 555 });
    expect(r.kind).toBe("err");
    if (r.kind === "err") expect(r.code).toBe("chat_not_permitted");
  });

  test("chat_id is validated first when both are supplied", () => {
    db.upsertUserChat("bot1", "42", 555);
    // chat_id=666 is not known to bot1 — rejected even though user_id would
    // resolve cleanly. Caller explicit chat_id is the strictest signal.
    const r = resolveChatId(db, "bot1", { user_id: "42", chat_id: 666 });
    expect(r.kind).toBe("err");
    if (r.kind === "err") expect(r.code).toBe("chat_not_permitted");
  });
});
