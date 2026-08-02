import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizedV1Model } from "../../src/config/v2.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations } from "../../src/db/migrate.js";
import type { InboundEvent } from "../../src/platform/types.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("DB busy leaves Buzz intake and cursor atomic for relay redelivery", () => {
  const dir = mkdtempSync(join(tmpdir(), "torana-buzz-busy-"));
  dirs.push(dir);
  const dbPath = join(dir, "gateway.db");
  applyMigrations(dbPath);
  const config = makeTestConfig([makeTestBotConfig("alpha")]);
  const db = new GatewayDB(dbPath);
  db.syncNormalizedConfig(normalizedV1Model(config));
  db._unsafeQuery(
    `INSERT INTO endpoints
       (endpoint_id, agent_id, platform, external_identity,
        lifecycle_state, state_reason)
     VALUES (?, ?, 'buzz', ?, 'active', NULL)`,
  ).run("alpha-buzz", "alpha", "ef".repeat(32));
  db._unsafeQuery("PRAGMA busy_timeout=25").run();
  const endpointId = "alpha-buzz";
  const blocker = new Database(dbPath);
  blocker.exec("BEGIN IMMEDIATE");

  const event: InboundEvent = {
    platform: "buzz",
    endpointId,
    agentId: "alpha",
    communityId: "fault-test",
    conversation: {
      platform: "buzz",
      endpointId,
      communityId: "fault-test",
      channelId: "11111111-2222-4333-8444-555555555555",
      threadRootId: null,
      workflowRunId: null,
      type: "stream",
    },
    externalEventId: "ab".repeat(32),
    externalMessageId: "ab".repeat(32),
    targetExternalEventId: null,
    workflowRunId: null,
    sender: {
      id: "cd".repeat(32),
      kind: "human",
      displayName: null,
      username: null,
      raw: null,
    },
    kind: "message",
    text: "retry after database contention",
    markdown: true,
    replyTo: null,
    rootEventId: null,
    mentions: [],
    attachments: [],
    occurredAt: 1_775_000_000,
    receivedSeq: 0,
    raw: { id: "ab".repeat(32), content: "retry after contention" },
  };

  expect(() =>
    db.recordBuzzInbound({
      event,
      status: "received",
      cursorScope: "fault:busy",
    }),
  ).toThrow(/locked|busy/i);
  expect(
    db.getInboundEventStatus(endpointId, event.externalEventId),
  ).toBeNull();
  expect(db.getEndpointState(endpointId)?.cursor.subscriptions).toEqual({});

  blocker.exec("COMMIT");
  const retried = db.recordBuzzInbound({
    event,
    status: "received",
    cursorScope: "fault:busy",
  });
  expect(retried.kind).toBe("inserted");
  expect(
    db.getEndpointState(endpointId)?.cursor.subscriptions["fault:busy"],
  ).toEqual({
    created_at: event.occurredAt,
    event_id: event.externalEventId,
  });

  blocker.close();
  db.close();
});
