// processUpdate writes user_chats rows on authorized inbound messages.
// These rows are the ground truth for the agent-api inject handler's
// user_id → chat_id resolution.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { processUpdate } from "../../src/core/process-update.js";
import type { TelegramClient } from "../../src/telegram/client.js";
import type { TelegramUpdate } from "../../src/telegram/types.js";

class FakeTelegram {
  async setMessageReaction(): Promise<boolean> {
    return true;
  }
  async sendMessage(): Promise<{ messageId: number } | null> {
    return { messageId: 999 };
  }
  async getFile(): Promise<null> {
    return null;
  }
  async downloadFile(): Promise<null> {
    return null;
  }
}

let tmpDir: string;
let db: GatewayDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-uc-"));
  const dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function update(
  updateId: number,
  chatId: number,
  fromUserId: number,
  text = "hello",
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 1,
      chat: { id: chatId, type: "private" },
      from: { id: fromUserId, is_bot: false },
      text,
    },
  };
}

describe("processUpdate writes user_chats", () => {
  test("first authorized DM creates a user_chats row", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")], {
      gateway: {
        port: 3000,
        data_dir: tmpDir,
        db_path: join(tmpDir, "gateway.db"),
        log_level: "info",
      },
    });
    const fake = new FakeTelegram();
    const outcome = await processUpdate(
      {
        config,
        db,
        botConfig: config.bots[0],
        telegram: fake as unknown as TelegramClient,
      },
      update(1, 555, 111_222_333),
    );
    expect(outcome.status).toBe("enqueued");

    const row = db.getLastChatForUser("alpha", "111222333");
    expect(row).not.toBeNull();
    expect(row!.chat_id).toBe(555);
  });

  test("subsequent DM from same user updates chat_id (user moved chats)", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")], {
      gateway: {
        port: 3000,
        data_dir: tmpDir,
        db_path: join(tmpDir, "gateway.db"),
        log_level: "info",
      },
    });
    const fake = new FakeTelegram();
    await processUpdate(
      {
        config,
        db,
        botConfig: config.bots[0],
        telegram: fake as unknown as TelegramClient,
      },
      update(1, 555, 111_222_333),
    );
    await processUpdate(
      {
        config,
        db,
        botConfig: config.bots[0],
        telegram: fake as unknown as TelegramClient,
      },
      update(2, 777, 111_222_333),
    );

    const row = db.getLastChatForUser("alpha", "111222333");
    expect(row!.chat_id).toBe(777);
  });

  test("transaction atomicity: if createTurn throws, user_chats is NOT persisted", async () => {
    // PRD US-002 + US-011: upsertUserChat must run inside the same
    // transaction as insertUpdate/createTurn so a downstream throw rolls
    // back the user_chats write. Monkey-patch createTurn to throw and
    // verify nothing was committed.
    const config = makeTestConfig([makeTestBotConfig("alpha")], {
      gateway: {
        port: 3000,
        data_dir: tmpDir,
        db_path: join(tmpDir, "gateway.db"),
        log_level: "info",
      },
    });
    const fake = new FakeTelegram();

    // Save the real implementation, then monkey-patch to fail mid-transaction.
    const realCreateTurn = db.createTurn.bind(db);
    db.createTurn = (() => {
      throw new Error("simulated DB failure mid-transaction");
    }) as typeof db.createTurn;

    let threw: unknown = null;
    try {
      await processUpdate(
        {
          config,
          db,
          botConfig: config.bots[0],
          telegram: fake as unknown as TelegramClient,
        },
        update(1, 555, 111_222_333),
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).not.toBeNull();

    // Restore so we can inspect normal state with a real query.
    db.createTurn = realCreateTurn;

    // The transaction rolled back — user_chats has no row for this user.
    const row = db.getLastChatForUser("alpha", "111222333");
    expect(row).toBeNull();
  });

  test("unauthorized sender is NOT recorded in user_chats", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")], {
      gateway: {
        port: 3000,
        data_dir: tmpDir,
        db_path: join(tmpDir, "gateway.db"),
        log_level: "info",
      },
    });
    const fake = new FakeTelegram();
    const outcome = await processUpdate(
      {
        config,
        db,
        botConfig: config.bots[0],
        telegram: fake as unknown as TelegramClient,
      },
      update(1, 555, 999_999_999),
    );
    expect(outcome.status).toBe("rejected_acl");
    const row = db.getLastChatForUser("alpha", "999999999");
    expect(row).toBeNull();
  });
});
