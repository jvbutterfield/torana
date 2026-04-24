// runCrashRecovery tests.
//
// Fabricates the load-bearing states the recovery function handles and
// verifies the correct transitions:
//   - Orphaned "running" turn with NO first_output → re-queued to 'queued',
//     pending outbox for that turn cancelled.
//   - Orphaned "running" turn WITH first_output → 'interrupted',
//     user-facing notification scheduled via the client.
//   - Outbox edit row whose target message already has a newer sent row
//     on the same message id → marked 'failed' (superseded).
//   - worker_state rows all reset to 'starting' regardless of prior status.
//   - "no clients map entry for bot_id": recovery proceeds (no throw), no
//     user-facing notification.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCrashRecovery } from "../../src/main.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import type { TelegramClient } from "../../src/telegram/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSchema(dbPath: string): void {
  const sqlPath = resolve(__dirname, "../../src/db/schema.sql");
  const raw = new Database(dbPath, { create: true });
  raw.exec(readFileSync(sqlPath, "utf8") + "\nPRAGMA user_version = 1;");
  raw.close();
}

interface RecordedCall {
  method: string;
  chatId?: number;
  messageId?: number;
  text?: string;
}

function makeRecordingClient(): {
  client: TelegramClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client = {
    async sendMessage(chatId: number, text: string) {
      calls.push({ method: "sendMessage", chatId, text });
      return { messageId: 1 };
    },
    async editMessageText(chatId: number, messageId: number, text: string) {
      calls.push({ method: "editMessageText", chatId, messageId, text });
      return true;
    },
  } as unknown as TelegramClient;
  return { client, calls };
}

let tmpDir: string;
let db: GatewayDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-crash-"));
  loadSchema(join(tmpDir, "gateway.db"));
  db = new GatewayDB(join(tmpDir, "gateway.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedInboundUpdate(botId: string, updateId = 1): number {
  const inboundId = db.insertUpdate(
    botId,
    updateId,
    111,
    1,
    "42",
    JSON.stringify({ message: { text: "hi" } }),
    "enqueued",
  );
  return inboundId!;
}

/** Seed a running turn; if `firstOutput`, set first_output_at so recovery
 *  treats it as "mid-stream" rather than "never started". */
function seedRunningTurn(
  botId: string,
  chatId: number,
  firstOutput: boolean,
  opts: { updateId?: number; worker_generation?: number } = {},
): number {
  const inboundId = seedInboundUpdate(botId, opts.updateId);
  const turnId = db.createTurn(botId, chatId, inboundId);
  db.startTurn(turnId, opts.worker_generation ?? 1);
  if (firstOutput) {
    db.setTurnFirstOutput(turnId);
  }
  return turnId;
}

describe("runCrashRecovery", () => {
  test("orphaned turn with no first_output → re-queued; pending outbox cancelled", () => {
    const { client, calls } = makeRecordingClient();
    const turnId = seedRunningTurn("alpha", 111, false);
    // Pending outbox row tied to this turn.
    const outboxId = db.insertOutbox(
      turnId,
      "alpha",
      111,
      "send",
      JSON.stringify({ text: "queued send" }),
    );
    db.initWorkerState("alpha");

    runCrashRecovery(db, new Map([["alpha", client]]));

    const row = db
      .query(
        "SELECT status, started_at, worker_generation FROM turns WHERE id=?",
      )
      .get(turnId) as {
      status: string;
      started_at: string | null;
      worker_generation: number | null;
    };
    expect(row.status).toBe("queued");
    expect(row.started_at).toBeNull();
    expect(row.worker_generation).toBeNull();

    // Pending outbox cancelled (marked failed with the recovery reason).
    const outboxRow = db.getOutboxRow(outboxId);
    expect(outboxRow?.status).toBe("failed");

    // No user-facing apology — turn will re-run silently.
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
  });

  test("orphaned turn WITH first_output → interrupted + user notified", () => {
    const { client, calls } = makeRecordingClient();
    const turnId = seedRunningTurn("alpha", 111, true);
    db.initWorkerState("alpha");
    // Also seed a stream_state with an active message so the edit path is hit.
    db.initStreamState(turnId);
    db.updateStreamState(turnId, {
      active_telegram_message_id: 4242,
      buffer_text: "in-progress text",
    });

    runCrashRecovery(db, new Map([["alpha", client]]));

    const row = db
      .query("SELECT status, error_text FROM turns WHERE id=?")
      .get(turnId) as {
      status: string;
      error_text: string | null;
    };
    expect(row.status).toBe("interrupted");
    expect(row.error_text).toContain("restarted");

    // Two recovery-side calls: an edit of the active stream message with the
    // partial buffer, plus a sendMessage apology to the chat.
    const edits = calls.filter((c) => c.method === "editMessageText");
    const sends = calls.filter((c) => c.method === "sendMessage");
    expect(edits).toHaveLength(1);
    expect(edits[0].messageId).toBe(4242);
    expect(edits[0].text).toContain("in-progress");
    expect(sends).toHaveLength(1);
    expect(sends[0].text?.toLowerCase()).toContain("restarted");
  });

  test("turn with first_output but empty buffer edits '(restarted)' placeholder", () => {
    const { client, calls } = makeRecordingClient();
    const turnId = seedRunningTurn("alpha", 111, true);
    db.initWorkerState("alpha");
    db.initStreamState(turnId);
    db.updateStreamState(turnId, {
      active_telegram_message_id: 9999,
      buffer_text: "   ", // whitespace-only — falls to the placeholder
    });

    runCrashRecovery(db, new Map([["alpha", client]]));

    const edits = calls.filter((c) => c.method === "editMessageText");
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toBe("(restarted)");
  });

  test("missing client for bot_id: recovery completes without throwing", () => {
    const { client, calls } = makeRecordingClient();
    const turnId = seedRunningTurn("alpha", 111, true);
    db.initWorkerState("alpha");
    db.initStreamState(turnId);
    db.updateStreamState(turnId, {
      active_telegram_message_id: 1,
      buffer_text: "text",
    });

    // Pass an empty clients map — no client for 'alpha'.
    runCrashRecovery(db, new Map<string, TelegramClient>());

    // Turn state was still updated even without a client.
    const row = db.query("SELECT status FROM turns WHERE id=?").get(turnId) as {
      status: string;
    };
    expect(row.status).toBe("interrupted");
    // No calls happened against the recording client.
    expect(calls).toHaveLength(0);
  });

  test("edit outbox superseded by newer sent row → marked failed", () => {
    const { client } = makeRecordingClient();
    // Two outbox rows editing the same telegram_message_id. The later one is
    // 'sent' — the earlier one is 'pending' (meaning: we want to edit a message
    // whose newer edit already succeeded, so this older one is stale).
    const inboundId = seedInboundUpdate("alpha");
    const turnId = db.createTurn("alpha", 111, inboundId);
    db.completeTurn(turnId);
    db.initWorkerState("alpha");

    const olderId = db.insertOutbox(
      turnId,
      "alpha",
      111,
      "edit",
      JSON.stringify({ text: "old" }),
      5000,
    );
    const newerId = db.insertOutbox(
      turnId,
      "alpha",
      111,
      "edit",
      JSON.stringify({ text: "new" }),
      5000,
    );
    db.markOutboxSent(newerId);

    runCrashRecovery(db, new Map([["alpha", client]]));

    const olderRow = db.getOutboxRow(olderId);
    const newerRow = db.getOutboxRow(newerId);
    expect(olderRow?.status).toBe("failed");
    expect(newerRow?.status).toBe("sent");
  });

  test("worker_state rows reset to 'starting' regardless of prior status", () => {
    const { client } = makeRecordingClient();
    db.initWorkerState("alpha");
    db.initWorkerState("beta");
    db.updateWorkerState("alpha", { status: "ready", pid: 1234 });
    db.updateWorkerState("beta", {
      status: "degraded",
      consecutive_failures: 7,
    });

    runCrashRecovery(
      db,
      new Map([
        ["alpha", client],
        ["beta", client],
      ]),
    );

    const alpha = db.getWorkerState("alpha");
    const beta = db.getWorkerState("beta");
    expect(alpha?.status).toBe("starting");
    expect(alpha?.pid).toBeNull();
    expect(beta?.status).toBe("starting");
    expect(beta?.pid).toBeNull();
    // consecutive_failures is a separate field — not reset by
    // resetAllWorkerStates (only status + pid).
    expect(beta?.consecutive_failures).toBe(7);
  });

  test("no running turns, no outbox, no workers: recovery is a no-op", () => {
    const { client, calls } = makeRecordingClient();
    runCrashRecovery(db, new Map([["alpha", client]]));
    expect(calls).toHaveLength(0);
  });

  test("turn with stream_state but no active message id: no edit call", () => {
    const { client, calls } = makeRecordingClient();
    const turnId = seedRunningTurn("alpha", 111, true);
    db.initWorkerState("alpha");
    db.initStreamState(turnId);
    // stream_state exists but active_telegram_message_id is null (never sent
    // a placeholder before the crash).

    runCrashRecovery(db, new Map([["alpha", client]]));

    const edits = calls.filter((c) => c.method === "editMessageText");
    expect(edits).toHaveLength(0);
    // Turn still transitions to interrupted and user is notified.
    const row = db.query("SELECT status FROM turns WHERE id=?").get(turnId) as {
      status: string;
    };
    expect(row.status).toBe("interrupted");
    const sends = calls.filter((c) => c.method === "sendMessage");
    expect(sends).toHaveLength(1);
  });

  test("multiple running turns across bots: each handled independently", () => {
    const { client: cA, calls: callsA } = makeRecordingClient();
    const { client: cB, calls: callsB } = makeRecordingClient();
    // alpha: running+first_output → interrupted
    const tA = seedRunningTurn("alpha", 111, true, { updateId: 1 });
    db.initStreamState(tA);
    db.updateStreamState(tA, {
      active_telegram_message_id: 100,
      buffer_text: "A text",
    });
    // beta: running, no first_output → requeued
    const tB = seedRunningTurn("beta", 222, false, { updateId: 2 });
    db.initWorkerState("alpha");
    db.initWorkerState("beta");

    runCrashRecovery(
      db,
      new Map([
        ["alpha", cA],
        ["beta", cB],
      ]),
    );

    const rowA = db.query("SELECT status FROM turns WHERE id=?").get(tA) as {
      status: string;
    };
    const rowB = db.query("SELECT status FROM turns WHERE id=?").get(tB) as {
      status: string;
    };
    expect(rowA.status).toBe("interrupted");
    expect(rowB.status).toBe("queued");

    // Only alpha's client saw calls (edit + send).
    expect(callsA.length).toBe(2);
    expect(callsB.length).toBe(0);
  });
});
