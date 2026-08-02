import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { finalizeEvent, type Event } from "nostr-tools";

import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { Metrics } from "../../src/metrics.js";
import { OutboxProcessor } from "../../src/outbox.js";
import { BuzzAdapter } from "../../src/platform/buzz/adapter.js";
import {
  buzzMessageBytes,
  splitBuzzMessage,
} from "../../src/platform/buzz/renderer.js";
import {
  BUZZ_KINDS,
  createOwnerAuthTag,
  decodeSecret,
  publicKey,
} from "../../src/platform/buzz/protocol.js";
import { StreamManager } from "../../src/streaming.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const ENDPOINT_KEY = "21".padStart(64, "0");
const OWNER_KEY = "22".padStart(64, "0");
const ENDPOINT_SECRET = decodeSecret(ENDPOINT_KEY);
const OWNER_SECRET = decodeSecret(OWNER_KEY);
const ENDPOINT_PUBKEY = publicKey(ENDPOINT_SECRET);
const OWNER_PUBKEY = publicKey(OWNER_SECRET);
const CHANNEL = "33333333-4444-4555-8666-777777777777";
const AUTH_TAG = JSON.stringify(
  createOwnerAuthTag(OWNER_SECRET, ENDPOINT_PUBKEY, ""),
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "torana-buzz-p6-"));
  tempDirs.push(dir);
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
  upgraded.platforms.buzz.enabled = true;
  upgraded.platforms.buzz.message_max_bytes = 1024;
  upgraded.limits.buzz_edit_cadence_ms = 100;
  upgraded.agents[0].endpoints.push({
    id: "alpha-buzz",
    platform: "buzz",
    enabled: true,
    community_id: "primary",
    relay_url: "ws://127.0.0.1:65535",
    private_key: ENDPOINT_KEY,
    auth_tag: AUTH_TAG,
    respond_to: "anyone",
    owner_pubkey: OWNER_PUBKEY,
    subscribe: "mentions_and_dms",
    reactions: { received_emoji: "👀" },
    custom_emoji_palette: { ship_it: "https://cdn.example/ship-it.png" },
    triggers: {},
    channel_overrides: {},
  });
  const loaded = loadConfigFromString(yaml.dump(upgraded), {
    skipInterpolation: true,
  });
  applyMigrations(loaded.config.gateway.db_path!);
  const db = new GatewayDB(loaded.config.gateway.db_path!);
  db.syncNormalizedConfig(loaded.normalized);
  const endpoint = loaded.normalized.endpoints.find(
    (candidate) => candidate.id === "alpha-buzz",
  )!;
  const adapter = new BuzzAdapter(endpoint);
  adapter.setChannels(
    new Map([[CHANNEL, { id: CHANNEL, name: "owner", type: "dm" as const }]]),
  );
  return { ...loaded, db, adapter };
}

function event(
  kind: number,
  content: string,
  tags: string[][],
  createdAt = Math.floor(Date.now() / 1000),
): Event {
  return finalizeEvent(
    { kind, content, tags: [["h", CHANNEL], ...tags], created_at: createdAt },
    OWNER_SECRET,
  );
}

function recordMessage(db: GatewayDB, adapter: BuzzAdapter, raw: Event) {
  const decision = adapter.evaluateInbound(raw, new Set([CHANNEL]));
  if (decision.kind !== "accepted") throw new Error("fixture was not accepted");
  const recorded = db.recordBuzzInbound({
    event: decision.event,
    status: "received",
    cursorScope: decision.cursorScope,
  });
  if (recorded.kind !== "inserted") throw new Error("duplicate fixture");
  db.transitionInboundEvent(recorded.id, "received", "dispatched");
  const turnId = db.enqueueRecordedBuzzTurn(
    recorded.id,
    "alpha",
    decision.event.text,
  )!;
  return { recorded, turnId, normalized: decision.event };
}

function recordControl(db: GatewayDB, adapter: BuzzAdapter, raw: Event) {
  const decision = adapter.evaluateInbound(raw, new Set([CHANNEL]));
  if (decision.kind !== "control") throw new Error("fixture was not control");
  const recorded = db.recordBuzzInbound({
    event: decision.event,
    status: "control",
    cursorScope: decision.cursorScope,
  });
  if (recorded.kind !== "inserted") throw new Error("duplicate fixture");
  return recorded.id;
}

describe("Phase 6 Buzz rendering and operations", () => {
  test("splits native GFM by UTF-8 bytes without cutting emoji", () => {
    const chunks = splitBuzzMessage("**hello**\n🙂🙂🙂", 14);
    expect(chunks.join("")).toBe("**hello**\n🙂🙂🙂");
    expect(chunks.every((chunk) => buzzMessageBytes(chunk) <= 14)).toBe(true);
    expect(chunks.some((chunk) => chunk.includes("�"))).toBe(false);
  });

  test("signs edits, deletes, reactions, custom emoji, typing, and presence", async () => {
    const { db, adapter } = setup();
    const conversation = {
      platform: "buzz" as const,
      communityId: "primary",
      endpointId: "alpha-buzz",
      channelId: CHANNEL,
      threadRootId: null,
      workflowRunId: null,
      type: "direct" as const,
    };
    const prepared = [
      adapter.prepareOutbound(conversation, {
        kind: "edit",
        externalMessageId: "a".repeat(64),
        text: "**new**",
      }),
      adapter.prepareOutbound(conversation, {
        kind: "delete",
        externalMessageId: "b".repeat(64),
      }),
      adapter.prepareOutbound(conversation, {
        kind: "reaction_add",
        externalMessageId: "c".repeat(64),
        emoji: ":Ship_It:",
      }),
    ].map((item) => JSON.parse(item.signedPayloadJson!) as Event);
    expect(prepared.map((item) => item.kind)).toEqual([
      BUZZ_KINDS.streamEdit,
      BUZZ_KINDS.nativeDelete,
      BUZZ_KINDS.reaction,
    ]);
    expect(prepared[2].content).toBe(":ship_it:");
    expect(prepared[2].tags).toContainEqual([
      "emoji",
      "ship_it",
      "https://cdn.example/ship-it.png",
    ]);

    const published: Event[] = [];
    adapter.setRateLimits({ typing: 1000, presence: 1000 });
    adapter.setPublisher(async (signed) => {
      published.push(signed);
      return { ok: true, externalMessageId: signed.id };
    });
    expect(
      await adapter.signal(conversation, { kind: "typing", active: true }),
    ).toBe(true);
    expect(
      await adapter.signal(conversation, { kind: "typing", active: true }),
    ).toBe(false);
    expect(
      await adapter.signal(conversation, {
        kind: "presence",
        state: "online",
      }),
    ).toBe(true);
    expect(
      await adapter.signal(conversation, {
        kind: "presence",
        state: "offline",
      }),
    ).toBe(true);
    expect(published.map((item) => item.kind)).toEqual([
      BUZZ_KINDS.typing,
      BUZZ_KINDS.presence,
      BUZZ_KINDS.presence,
    ]);
    db.close();
  });
});

describe("Phase 6 Buzz mutation ordering", () => {
  test("updates only a queued prompt, then a delete dead-letters it", () => {
    const { db, adapter } = setup();
    const source = event(BUZZ_KINDS.streamMessageV1, "old", []);
    const { turnId } = recordMessage(db, adapter, source);
    const editId = recordControl(
      db,
      adapter,
      event(BUZZ_KINDS.streamEdit, "new", [["e", source.id]]),
    );
    expect(
      db.applyBuzzControlEvent({
        inboundEventId: editId,
        rerunOnEdit: false,
        includeReactionsInContext: false,
        pendingMutationDays: 30,
      }),
    ).toBe("applied");
    expect(db.getTurnText(turnId)).toBe("new");

    const deleteId = recordControl(
      db,
      adapter,
      event(BUZZ_KINDS.nativeDelete, "", [["e", source.id]]),
    );
    db.applyBuzzControlEvent({
      inboundEventId: deleteId,
      rerunOnEdit: false,
      includeReactionsInContext: false,
      pendingMutationDays: 30,
    });
    const turn = db
      ._unsafeQuery("SELECT status, error_text FROM turns WHERE id=?")
      .get(turnId) as { status: string; error_text: string };
    expect(turn).toEqual({
      status: "dead",
      error_text: "source message deleted",
    });
    db.close();
  });

  test("applies a tombstone that arrived before its message", () => {
    const { db, adapter } = setup();
    const source = event(BUZZ_KINDS.streamMessageV1, "late", [], 100);
    const deleteId = recordControl(
      db,
      adapter,
      event(BUZZ_KINDS.nativeDelete, "", [["e", source.id]], 101),
    );
    expect(
      db.applyBuzzControlEvent({
        inboundEventId: deleteId,
        rerunOnEdit: false,
        includeReactionsInContext: false,
        pendingMutationDays: 30,
      }),
    ).toBe("pending");
    const { turnId } = recordMessage(db, adapter, source);
    const turn = db
      ._unsafeQuery("SELECT status FROM turns WHERE id=?")
      .get(turnId) as { status: string };
    expect(turn.status).toBe("dead");
    expect(
      db
        ._unsafeQuery("SELECT COUNT(*) AS n FROM pending_event_mutations")
        .get(),
    ).toEqual({ n: 0 });
    db.close();
  });
});

describe("Phase 6 Buzz durable streaming", () => {
  test("uses a lazy send, signed edits, and byte-bounded continuations", async () => {
    const { db, adapter, config, normalized } = setup();
    adapter.setRateLimits({ edit: 0, typing: 0 });
    const source = event(BUZZ_KINDS.streamMessageV1, "prompt", []);
    const { turnId } = recordMessage(db, adapter, source);
    const published: Event[] = [];
    adapter.setPublisher(async (signed) => {
      published.push(signed);
      return { ok: true, externalMessageId: signed.id };
    });
    const adapters = new Map([["alpha-buzz", adapter]]);
    const outbox = new OutboxProcessor(
      config,
      db,
      adapters,
      new Metrics(config),
      null,
      { normalized },
    );
    const streaming = new StreamManager(
      config,
      db,
      outbox,
      adapters,
      normalized,
    );
    streaming.startTurn("alpha", turnId, 0);
    streaming.appendText("alpha", "draft", turnId);
    await outbox.drain(200);
    streaming.appendText("alpha", " update", turnId);
    await outbox.drain(200);
    await streaming.finalizeTurn("alpha", "🙂".repeat(2000), turnId);
    await outbox.drain(500);

    const visible = published.filter(
      (item) =>
        item.kind === BUZZ_KINDS.streamMessageV1 ||
        item.kind === BUZZ_KINDS.streamEdit,
    );
    expect(visible[0].kind).toBe(BUZZ_KINDS.streamMessageV1);
    expect(visible.some((item) => item.kind === BUZZ_KINDS.streamEdit)).toBe(
      true,
    );
    expect(
      visible.every((item) => buzzMessageBytes(item.content) <= 1024),
    ).toBe(true);
    expect(visible.map((item) => item.content).join("")).toContain("🙂");
    expect(
      db
        ._unsafeQuery("SELECT COUNT(*) AS n FROM outbox WHERE status='dead'")
        .get(),
    ).toEqual({ n: 0 });
    db.close();
  });
});
