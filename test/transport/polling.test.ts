import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-poll-"));
  const dbPath = join(tmpDir, "gateway.db");
  loadSchema(dbPath);
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("PollingTransport", () => {
  test("persists offset after receiving an update batch", async () => {
    const received: TelegramUpdate[] = [];
    let delivered = false;

    // Fake Telegram API: returns one update on the first poll, then hangs on the
    // signal-respecting abort. This mimics a long-poll with no new updates —
    // the test aborts by calling stop(), which propagates to fetch via the
    // AbortController.
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
      if (urlStr.endsWith("/deleteWebhook")) {
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
      if (urlStr.endsWith("/getUpdates")) {
        if (!delivered) {
          delivered = true;
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 42,
                  message: {
                    message_id: 1,
                    date: 1,
                    chat: { id: 1, type: "private" },
                    from: { id: 1, is_bot: false },
                    text: "hi",
                  },
                },
              ],
            }),
          );
        }
        // Second call and beyond: respect abort signal and hang until aborted.
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            return reject(new Error("aborted"));
          }
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      }
      return new Response(
        JSON.stringify({ ok: false, error_code: 500, description: "x" }),
      );
    }) as unknown as typeof fetch;

    const clients = new Map<string, TelegramClient>();
    clients.set(
      "alpha",
      new TelegramClient({
        botId: "alpha",
        token: "TT:AAAAAAA",
        apiBaseUrl: "https://api.telegram.org",
        fetchImpl,
      }),
    );

    const config = makeTestConfig([makeTestBotConfig("alpha")], {
      transport: {
        default_mode: "polling",
        allowed_updates: ["message"],
        polling: {
          timeout_secs: 1,
          backoff_base_ms: 100,
          backoff_cap_ms: 1000,
          max_updates_per_batch: 100,
        },
      },
    });

    const transport = new PollingTransport({ config, db, clients });
    await transport.start(async (_botId, update) => {
      received.push(update);
    });

    // Wait for the single delivery to round-trip, then stop.
    await new Promise((r) => setTimeout(r, 150));
    await transport.stop();

    expect(received).toHaveLength(1);
    expect(received[0].update_id).toBe(42);
    const state = db.getBotState("alpha");
    expect(state?.last_update_id).toBe(42);
  });
});
