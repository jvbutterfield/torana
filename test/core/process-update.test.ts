import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { processUpdate } from "../../src/core/process-update.js";
import type { TelegramClient } from "../../src/telegram/client.js";
import type { TelegramUpdate } from "../../src/telegram/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let tmpDir: string;
let db: GatewayDB;

function loadSchema(dbPath: string): void {
  const schemaPath = resolve(__dirname, "../../src/db/schema.sql");
  const sql = readFileSync(schemaPath, "utf8") + "\nPRAGMA user_version = 1;";
  const raw = new Database(dbPath, { create: true });
  raw.exec(sql);
  raw.close();
}

class FakeTelegram {
  calls: Array<{ method: string; args: unknown[] }> = [];
  async setMessageReaction(
    chatId: number,
    messageId: number,
    emoji: string,
  ): Promise<boolean> {
    this.calls.push({
      method: "setMessageReaction",
      args: [chatId, messageId, emoji],
    });
    return true;
  }
  async sendMessage(
    chatId: number,
    text: string,
  ): Promise<{ messageId: number } | null> {
    this.calls.push({ method: "sendMessage", args: [chatId, text] });
    return { messageId: 999 };
  }
  async getFile(): Promise<null> {
    return null;
  }
  async downloadFile(): Promise<null> {
    return null;
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-proc-"));
  const dbPath = join(tmpDir, "gateway.db");
  loadSchema(dbPath);
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function baseUpdate(overrides: Partial<TelegramUpdate> = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1,
      chat: { id: 111, type: "private" },
      from: { id: 111_222_333, is_bot: false },
      text: "hello",
    },
    ...overrides,
  };
}

describe("processUpdate", () => {
  test("happy path: enqueues turn and marks inbound enqueued", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")], {
      gateway: {
        port: 3000,
        bind_host: "127.0.0.1",
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
      baseUpdate(),
    );
    expect(outcome.status).toBe("enqueued");
    expect(outcome.turnId).toBeGreaterThan(0);
    expect(fake.calls.some((c) => c.method === "setMessageReaction")).toBe(
      true,
    );

    const row = db.getInboundUpdateStatus("alpha", 1);
    expect(row?.status).toBe("enqueued");
    const queued = db.getQueuedTurns("alpha");
    expect(queued).toHaveLength(1);
  });

  test("ACL reject: unauthorized sender → rejected_acl, no turn enqueued", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")]);
    const fake = new FakeTelegram();
    const update = baseUpdate();
    update.message!.from!.id = 99999; // not allowlisted
    const outcome = await processUpdate(
      {
        config,
        db,
        botConfig: config.bots[0],
        telegram: fake as unknown as TelegramClient,
      },
      update,
    );
    expect(outcome.status).toBe("rejected_acl");
    const row = db.getInboundUpdateStatus("alpha", 1);
    expect(row?.status).toBe("rejected");
    expect(db.getQueuedTurns("alpha")).toHaveLength(0);
  });

  test("replay: same update_id twice → second returns replay_skipped", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")], {
      gateway: {
        port: 3000,
        bind_host: "127.0.0.1",
        data_dir: tmpDir,
        db_path: join(tmpDir, "gateway.db"),
        log_level: "info",
      },
    });
    const fake = new FakeTelegram();
    const deps = {
      config,
      db,
      botConfig: config.bots[0],
      telegram: fake as unknown as TelegramClient,
    };
    const first = await processUpdate(deps, baseUpdate());
    const second = await processUpdate(deps, baseUpdate());
    expect(first.status).toBe("enqueued");
    expect(second.status).toBe("replay_skipped");
    expect(db.getQueuedTurns("alpha")).toHaveLength(1);
  });

  test("unsupported media (voice, no text) → rejected_unsupported_media", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")], {
      gateway: {
        port: 3000,
        bind_host: "127.0.0.1",
        data_dir: tmpDir,
        db_path: join(tmpDir, "gateway.db"),
        log_level: "info",
      },
    });
    const fake = new FakeTelegram();
    const update = baseUpdate({
      update_id: 5,
      message: {
        message_id: 10,
        date: 1,
        chat: { id: 111, type: "private" },
        from: { id: 111_222_333, is_bot: false },
        voice: { file_id: "v1", duration: 5 },
      },
    });
    const outcome = await processUpdate(
      {
        config,
        db,
        botConfig: config.bots[0],
        telegram: fake as unknown as TelegramClient,
      },
      update,
    );
    expect(outcome.status).toBe("rejected_unsupported_media");
    expect(
      fake.calls.some(
        (c) =>
          c.method === "sendMessage" &&
          typeof c.args[1] === "string" &&
          c.args[1].includes("media type"),
      ),
    ).toBe(true);
  });

  test("missing from.id drops update", async () => {
    const config = makeTestConfig([makeTestBotConfig("alpha")]);
    const fake = new FakeTelegram();
    const update: TelegramUpdate = {
      update_id: 7,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 111, type: "private" },
        text: "x",
      },
    };
    const outcome = await processUpdate(
      {
        config,
        db,
        botConfig: config.bots[0],
        telegram: fake as unknown as TelegramClient,
      },
      update,
    );
    expect(outcome.status).toBe("dropped_malformed");
  });

  test("per-bot ACL override replaces global", async () => {
    const bot = makeTestBotConfig("alpha", {
      access_control: { allowed_user_ids: [555] },
    });
    const config = makeTestConfig([bot]);
    const fake = new FakeTelegram();
    const update = baseUpdate();
    update.message!.from!.id = 555;
    const outcome = await processUpdate(
      {
        config,
        db,
        botConfig: bot,
        telegram: fake as unknown as TelegramClient,
      },
      update,
    );
    expect(outcome.status).toBe("enqueued");
  });
});
