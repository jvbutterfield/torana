import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations, planMigration } from "../../src/db/migrate.js";
import { Metrics } from "../../src/metrics.js";
import { OutboxProcessor } from "../../src/outbox.js";
import type { PlatformAdapter } from "../../src/platform/capabilities.js";
import {
  ConfigV2Schema,
  normalizeV2,
  normalizedV1Model,
  upgradeV1Object,
} from "../../src/config/v2.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-v5-bridge-"));
  dbPath = join(tmpDir, "gateway.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function createV3Database(): void {
  const db = new Database(dbPath, { create: true });
  db.exec(
    readFileSync(resolve(__dirname, "../../src/db/schema.sql"), "utf8") +
      "\nPRAGMA user_version=3;",
  );
  db.close();
}

describe("schema-v5 compatibility bridge", () => {
  test("runs v1 Telegram and Agent API helpers directly on schema v3", () => {
    createV3Database();
    const config = makeTestConfig([makeTestBotConfig("alpha")]);
    const bridge = new GatewayDB(dbPath);
    bridge.syncNormalizedConfig(normalizedV1Model(config));
    expect(bridge.getEndpointId("alpha", "telegram")).toBe("alpha-telegram");
    const inboundId = bridge.insertUpdate(
      "alpha",
      1,
      111,
      1,
      "42",
      '{"message":{"text":"schema 3"}}',
      "enqueued",
    )!;
    const turnId = bridge.createTurn("alpha", 111, inboundId);
    bridge.insertOutbox(turnId, "alpha", 111, "send", '{"text":"schema 3"}');
    expect(bridge.getPendingOutbox()).toHaveLength(1);
    expect(
      bridge.insertSendTurn({
        botId: "alpha",
        tokenName: "bridge-test",
        chatId: 111,
        markerWrappedText: "agent api on v3",
        idempotencyKey: "schema-v3-agent-api-key",
        sourceLabel: "test",
        attachmentPaths: [],
      }).replay,
    ).toBe(false);
    bridge.close();
  });

  test("dry-run reports sanitized table counts and planned v3 backfills", () => {
    createV3Database();
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO inbound_updates
        (bot_id, telegram_update_id, chat_id, message_id, from_user_id, payload_json)
      VALUES ('alpha', 1, 9007199254740991, 2, '3', '{"message":{"text":"secret-free count"}}');
    `);
    db.close();

    const plan = planMigration(dbPath);
    expect(plan.currentVersion).toBe(3);
    expect(plan.steps.map((step) => step.id)).toEqual([
      "0004_normalized_platform_state",
      "0005_normalized_turns_outbox",
      "0006_publisher_publications",
      "0007_provisioned_endpoints",
    ]);
    expect(plan.backfills?.inbound_updates).toBe(1);
    expect(JSON.stringify(plan.backfills)).not.toContain("secret-free count");
  });

  test("bridge to v2 to bridge dual-writes without restoring the snapshot", () => {
    createV3Database();
    const v1Config = makeTestConfig([makeTestBotConfig("alpha")], {
      gateway: {
        ...makeTestConfig([makeTestBotConfig("alpha")]).gateway,
        data_dir: tmpDir,
        db_path: dbPath,
      },
    });

    const migration = applyMigrations(dbPath);
    expect(migration.snapshotPath).toBe(`${dbPath}.pre-v7`);
    expect(existsSync(migration.snapshotPath!)).toBe(true);

    let bridge = new GatewayDB(dbPath);
    bridge.syncNormalizedConfig(normalizedV1Model(v1Config));
    const firstInbound = bridge.insertUpdate(
      "alpha",
      10,
      111,
      10,
      "42",
      '{"message":{"text":"bridge before v2"}}',
      "enqueued",
    )!;
    const firstTurn = bridge.createTurn("alpha", 111, firstInbound);
    bridge.insertOutbox(firstTurn, "alpha", 111, "send", '{"text":"one"}');
    bridge.initBotState("alpha");
    bridge.setBotLastUpdateId("alpha", 10);
    bridge.setBotDisabled("alpha", "bridge-test");
    bridge.clearBotDisabled("alpha");
    bridge.initStreamState(firstTurn);
    bridge.updateStreamState(firstTurn, { active_telegram_message_id: 99 });
    const now = new Date().toISOString();
    bridge.upsertSideSession({
      botId: "alpha",
      sessionId: "side-one",
      pid: 123,
      startedAt: now,
      lastUsedAt: now,
      hardExpiresAt: now,
      state: "ready",
    });
    bridge.close();

    const upgradedObject = upgradeV1Object(v1Config) as {
      agents: Array<{ endpoints: Array<{ id: string }> }>;
    } & Record<string, unknown>;
    upgradedObject.agents[0]!.endpoints[0]!.id = "alpha-primary";
    const v2 = normalizeV2(ConfigV2Schema.parse(upgradedObject));
    const runtime = new GatewayDB(dbPath);
    runtime.syncNormalizedConfig(v2.model);
    const secondInbound = runtime.insertUpdate(
      "alpha",
      11,
      222,
      11,
      "43",
      '{"message":{"text":"v2 activity"}}',
      "enqueued",
    )!;
    runtime.createTurn("alpha", 222, secondInbound);
    runtime.insertSendTurn({
      botId: "alpha",
      tokenName: "bridge-test",
      chatId: 222,
      markerWrappedText: "agent api activity",
      idempotencyKey: "bridge-v2-agent-api-key",
      sourceLabel: "test",
      attachmentPaths: [],
    });
    runtime.close();

    bridge = new GatewayDB(dbPath);
    bridge.syncNormalizedConfig(normalizedV1Model(v1Config));
    const thirdInbound = bridge.insertUpdate(
      "alpha",
      12,
      333,
      12,
      "44",
      '{"message":{"text":"bridge after v2"}}',
      "enqueued",
    )!;
    bridge.createTurn("alpha", 333, thirdInbound);

    bridge.exec(`
      INSERT OR IGNORE INTO endpoints
        (endpoint_id, agent_id, platform, lifecycle_state)
      VALUES ('alpha-buzz', 'alpha', 'buzz', 'active');
      INSERT OR IGNORE INTO conversations
        (agent_id, endpoint_id, platform, external_conversation_id,
         conversation_type, conversation_key, session_policy, session_key)
      VALUES ('alpha', 'alpha-buzz', 'buzz', 'uuid-channel', 'stream',
              'buzz:test:uuid-channel', 'legacy_agent', 'legacy:alpha');
      INSERT INTO outbox
        (turn_id, bot_id, agent_id, chat_id, kind, payload_json, endpoint_id,
         platform, conversation_id, operation_kind)
      SELECT NULL, NULL, 'alpha', NULL, NULL, '{"text":"preserved"}',
             'alpha-buzz', 'buzz', id, 'send'
      FROM conversations WHERE endpoint_id='alpha-buzz';
    `);
    expect(
      bridge
        .getPendingOutbox()
        .every((row) => row.endpoint_id !== "alpha-buzz"),
    ).toBe(true);
    bridge.close();

    const inspect = new Database(dbPath, { readonly: true });
    const legacyCount = (
      inspect.query("SELECT COUNT(*) AS count FROM inbound_updates").get() as {
        count: number;
      }
    ).count;
    const normalizedCount = (
      inspect.query("SELECT COUNT(*) AS count FROM inbound_events").get() as {
        count: number;
      }
    ).count;
    expect(legacyCount).toBe(4);
    expect(normalizedCount).toBe(4);
    expect(
      inspect
        .query(
          "SELECT COUNT(*) AS count FROM endpoints WHERE endpoint_id IN ('alpha-telegram','alpha-primary','alpha-agent-api')",
        )
        .get(),
    ).toEqual({ count: 3 });
    expect(
      inspect
        .query(
          "SELECT cursor_json, lifecycle_state FROM endpoints WHERE endpoint_id='alpha-telegram'",
        )
        .get(),
    ).toEqual({
      cursor_json: '{"kind":"telegram_offset","last_update_id":10}',
      lifecycle_state: "active",
    });
    expect(
      inspect
        .query(
          "SELECT active_telegram_message_id, active_external_message_id FROM stream_state WHERE turn_id=?",
        )
        .get(firstTurn),
    ).toEqual({
      active_telegram_message_id: 99,
      active_external_message_id: "99",
    });
    expect(
      inspect
        .query(
          "SELECT state FROM conversation_sessions WHERE session_key='agentapi:alpha:side-one'",
        )
        .get(),
    ).toEqual({ state: "ready" });
    inspect.close();
  });

  test("delivers a nonnumeric Buzz conversation through the generic outbox", async () => {
    createV3Database();
    applyMigrations(dbPath);
    const runtime = new GatewayDB(dbPath);
    runtime.exec(`
      INSERT INTO endpoints
        (endpoint_id, agent_id, platform, lifecycle_state)
      VALUES ('alpha-buzz', 'alpha', 'buzz', 'active');
    `);
    const delivered: Array<{ channelId: string; kind: string }> = [];
    const adapter: PlatformAdapter = {
      endpoint: {
        id: "alpha-buzz",
        agentId: "alpha",
        platform: "buzz",
        communityId: "buzz-community",
        capabilities: new Set(["send"]),
      },
      normalizeInbound: () => null,
      deliver: async (conversation, operation) => {
        delivered.push({
          channelId: conversation.channelId,
          kind: operation.kind,
        });
        return { ok: true, externalMessageId: "buzz-message-uuid" };
      },
      signal: async () => true,
      materializeAttachments: async () => ({ attachments: [], errors: [] }),
    };
    const config = makeTestConfig([makeTestBotConfig("alpha")]);
    const outbox = new OutboxProcessor(
      config,
      runtime,
      new Map([["alpha", adapter]]),
      new Metrics(config),
    );
    const outboxId = outbox.queueOperation(
      null,
      "alpha",
      {
        platform: "buzz",
        communityId: "buzz-community",
        endpointId: "alpha-buzz",
        channelId: "53ccd26b-b0f7-4742-a410-650850fba36b",
        threadRootId: null,
        workflowRunId: null,
        type: "stream",
      },
      { kind: "send", text: "generic delivery", files: [] },
    );

    await outbox.drain(2_000);

    expect(delivered).toEqual([
      {
        channelId: "53ccd26b-b0f7-4742-a410-650850fba36b",
        kind: "send",
      },
    ]);
    expect(runtime.getOutboxRow(outboxId)).toEqual({
      telegram_message_id: null,
      status: "sent",
    });
    expect(
      runtime
        ._unsafeQuery("SELECT external_message_id FROM outbox WHERE id = ?")
        .get(outboxId),
    ).toEqual({ external_message_id: "buzz-message-uuid" });
    runtime.close();
  });

  test("the pre-v7 snapshot restores the v3 emergency fallback", () => {
    createV3Database();
    const migration = applyMigrations(dbPath);
    const restored = join(tmpDir, "restored.db");
    copyFileSync(migration.snapshotPath!, restored);
    const db = new Database(restored, { readonly: true });
    expect(
      (db.query("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(3);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='endpoints'",
        )
        .get(),
    ).toBeNull();
    db.close();
  });
});
