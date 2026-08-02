import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { finalizeEvent, verifyEvent, type Event } from "nostr-tools";

import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { Bot } from "../../src/core/bot.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { Metrics } from "../../src/metrics.js";
import { OutboxProcessor } from "../../src/outbox.js";
import { AlertManager } from "../../src/alerts.js";
import { BuzzAdapter } from "../../src/platform/buzz/adapter.js";
import {
  BUZZ_KINDS,
  createOwnerAuthTag,
  decodeSecret,
  publicKey,
} from "../../src/platform/buzz/protocol.js";
import { dispatchCommand, parseCommand } from "../../src/core/commands.js";
import { RunnerEventEmitter } from "../../src/runner/types.js";
import type {
  AgentRunner,
  RunnerEventHandler,
  RunnerEventKind,
  RunnerSession,
  SendTurnResult,
  Unsubscribe,
} from "../../src/runner/types.js";
import { StreamManager } from "../../src/streaming.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const ENDPOINT_KEY = "11".padStart(64, "0");
const OWNER_KEY = "12".padStart(64, "0");
const PEER_KEY = "13".padStart(64, "0");
const ENDPOINT_SECRET = decodeSecret(ENDPOINT_KEY);
const OWNER_SECRET = decodeSecret(OWNER_KEY);
const PEER_SECRET = decodeSecret(PEER_KEY);
const ENDPOINT_PUBKEY = publicKey(ENDPOINT_SECRET);
const OWNER_PUBKEY = publicKey(OWNER_SECRET);
const PEER_PUBKEY = publicKey(PEER_SECRET);
const CHANNEL = "11111111-2222-4333-8444-555555555555";
const CHANNEL_TWO = "22222222-3333-4444-8555-666666666666";
const AUTH_TAG = JSON.stringify(
  createOwnerAuthTag(OWNER_SECRET, ENDPOINT_PUBKEY, "kind=9"),
);
const tempDirs: string[] = [];

class SilentRunner implements AgentRunner {
  readonly botId = "alpha";
  private readonly events = new RunnerEventEmitter();
  start = async () => {};
  stop = async () => {};
  reset = async () => {};
  isReady = () => true;
  supportsReset = () => true;
  supportsSideSessions = () => false;
  sendTurn = (): SendTurnResult => ({ accepted: false, reason: "busy" });
  startSideSession = async () => {};
  sendSideTurn = (): SendTurnResult => ({ accepted: false, reason: "busy" });
  stopSideSession = async () => {};
  onSide = (): Unsubscribe => () => {};
  on<E extends RunnerEventKind>(
    event: E,
    handler: RunnerEventHandler<E>,
  ): Unsubscribe {
    return this.events.on(event, handler);
  }
}

class ControlledSession implements RunnerSession {
  readonly id = "buzz-session";
  private readonly events = new RunnerEventEmitter();
  private turnId = "";
  sendTurn(turnId: string): SendTurnResult {
    this.turnId = turnId;
    return { accepted: true, turnId };
  }
  cancel = async () => {};
  reset = async () => {};
  stop = async () => {};
  on<E extends RunnerEventKind>(
    event: E,
    handler: RunnerEventHandler<E>,
  ): Unsubscribe {
    return this.events.on(event, handler);
  }
  finish(finalText: string): void {
    this.events.emit({ kind: "done", turnId: this.turnId, finalText });
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function loaded() {
  const dir = mkdtempSync(join(tmpdir(), "torana-buzz-p5-"));
  tempDirs.push(dir);
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
  upgraded.sessions.scope = "conversation";
  upgraded.platforms.buzz.enabled = true;
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
    allowed_pubkeys: [],
    subscribe: "mentions_and_dms",
    triggers: {},
    channel_overrides: {},
  });
  return loadConfigFromString(yaml.dump(upgraded), {
    skipInterpolation: true,
  });
}

function setup() {
  const config = loaded();
  applyMigrations(config.config.gateway.db_path!);
  const db = new GatewayDB(config.config.gateway.db_path!);
  db.syncNormalizedConfig(config.normalized);
  const endpoint = config.normalized.endpoints.find(
    (candidate) => candidate.id === "alpha-buzz",
  )!;
  const adapter = new BuzzAdapter(endpoint);
  return { ...config, db, adapter };
}

function message(
  args: {
    secret?: Uint8Array;
    content?: string;
    tags?: string[][];
    createdAt?: number;
  } = {},
): Event {
  return finalizeEvent(
    {
      kind: BUZZ_KINDS.streamMessageV1,
      created_at: args.createdAt ?? 1_800_000_000,
      content: args.content ?? "hello",
      tags: [["h", CHANNEL], ...(args.tags ?? [])],
    },
    args.secret ?? OWNER_SECRET,
  );
}

describe("Phase 5 Buzz conversations", () => {
  test("classifies DMs and accepts an owner DM without a mention", () => {
    const { adapter, db } = setup();
    adapter.setChannels(
      new Map([[CHANNEL, { id: CHANNEL, name: "Jason", type: "dm" as const }]]),
    );
    const decision = adapter.evaluateInbound(message(), new Set([CHANNEL]));
    expect(decision.kind).toBe("accepted");
    if (decision.kind !== "accepted") throw new Error("not accepted");
    expect(decision.event.conversation?.type).toBe("direct");
    expect(decision.event.conversation?.threadRootId).toBeNull();
    db.close();
  });

  test("requires the exact endpoint mention in streams", () => {
    const { adapter, db } = setup();
    adapter.setChannels(
      new Map([
        [CHANNEL, { id: CHANNEL, name: "team", type: "stream" as const }],
      ]),
    );
    expect(adapter.evaluateInbound(message(), new Set([CHANNEL])).kind).toBe(
      "rejected",
    );
    expect(
      adapter.evaluateInbound(
        message({ secret: PEER_SECRET, tags: [["p", ENDPOINT_PUBKEY]] }),
        new Set([CHANNEL]),
      ).kind,
    ).toBe("accepted");
    expect(
      adapter.evaluateInbound(
        message({ secret: PEER_SECRET, tags: [["p", OWNER_PUBKEY]] }),
        new Set([CHANNEL]),
      ).kind,
    ).toBe("rejected");
    db.close();
  });

  test("lets a sibling delegate once without recursively triggering on the reply", () => {
    const { adapter, db, normalized } = setup();
    const endpoint = normalized.endpoints.find(
      (candidate) => candidate.id === "alpha-buzz",
    )!;
    const sibling = new BuzzAdapter({
      ...endpoint,
      id: "sibling-buzz",
      agentId: "sibling",
      externalIdentity: PEER_PUBKEY,
      buzz: {
        ...endpoint.buzz!,
        privateKey: PEER_KEY,
        pubkey: PEER_PUBKEY,
      },
    });
    const channels = new Map([
      [CHANNEL, { id: CHANNEL, name: "team", type: "stream" as const }],
    ]);
    adapter.setChannels(channels);
    sibling.setChannels(channels);
    const delegation = adapter.evaluateInbound(
      message({ secret: PEER_SECRET, tags: [["p", ENDPOINT_PUBKEY]] }),
      new Set([CHANNEL]),
    );
    if (delegation.kind !== "accepted" || !delegation.event.conversation) {
      throw new Error("delegation not accepted");
    }
    const prepared = adapter.prepareOutbound(delegation.event.conversation, {
      kind: "send",
      text: "delegated answer",
      files: [],
      replyTo: delegation.event.externalEventId,
      mentions: [PEER_PUBKEY],
      traceId: "delegation-trace",
      hop: 1,
    });
    const reply = JSON.parse(prepared.signedPayloadJson!) as Event;
    expect(reply.tags).toContainEqual(["p", PEER_PUBKEY]);
    expect(reply.tags).toContainEqual([
      "e",
      delegation.event.externalEventId,
      "",
      "reply",
    ]);
    expect(sibling.evaluateInbound(reply, new Set([CHANNEL]))).toEqual(
      expect.objectContaining({
        kind: "rejected",
        reason: "agent_reply_not_triggering",
      }),
    );
    db.close();
  });

  test("isolates two Buzz channels and Telegram in separate sessions", () => {
    const { adapter, db } = setup();
    const buzz = (channelId: string) =>
      db.resolveConversation("alpha", {
        platform: "buzz",
        communityId: "primary",
        endpointId: adapter.endpoint.id,
        channelId,
        threadRootId: null,
        workflowRunId: null,
        type: "stream",
      }).sessionKey;
    const first = buzz(CHANNEL);
    const second = buzz(CHANNEL_TWO);
    const telegram = db.resolveConversation("alpha", {
      platform: "telegram",
      communityId: null,
      endpointId: "alpha-telegram",
      channelId: "12345",
      threadRootId: null,
      workflowRunId: null,
      type: "direct",
    }).sessionKey;
    expect(first).toStartWith("conversation:");
    expect(new Set([first, second, telegram]).size).toBe(3);
    db.close();
  });

  test("normalizes nested threads and imeta without fetching media", () => {
    const { adapter, db } = setup();
    adapter.setChannels(
      new Map([
        [CHANNEL, { id: CHANNEL, name: "team", type: "stream" as const }],
      ]),
    );
    const root = "aa".repeat(32);
    const parent = "bb".repeat(32);
    const decision = adapter.evaluateInbound(
      message({
        tags: [
          ["p", ENDPOINT_PUBKEY],
          ["e", root, "", "root"],
          ["e", parent, "", "reply"],
          [
            "imeta",
            "url https://cdn.example/x.png",
            "m image/png",
            "filename proof.png",
            "size 42",
          ],
        ],
      }),
      new Set([CHANNEL]),
    );
    if (decision.kind !== "accepted") throw new Error("not accepted");
    expect(decision.event.rootEventId).toBe(root);
    expect(decision.event.replyTo).toBe(parent);
    expect(decision.event.attachments).toEqual([
      expect.objectContaining({
        kind: "image",
        mimeType: "image/png",
        originalFilename: "proof.png",
        sizeBytes: 42,
      }),
    ]);
    db.close();
  });

  test("persists one signed threaded reply and retries the identical event", async () => {
    const { adapter, db, config, normalized } = setup();
    adapter.setChannels(
      new Map([[CHANNEL, { id: CHANNEL, name: "Jason", type: "dm" as const }]]),
    );
    const raw = message();
    const decision = adapter.evaluateInbound(raw, new Set([CHANNEL]));
    if (decision.kind !== "accepted") throw new Error("not accepted");
    const recorded = db.recordBuzzInbound({
      event: decision.event,
      status: "received",
      cursorScope: decision.cursorScope,
    });
    if (recorded.kind !== "inserted") throw new Error("duplicate fixture");
    db.transitionInboundEvent(recorded.id, "received", "dispatched");
    const turnId = db.enqueueRecordedBuzzTurn(recorded.id, "alpha", "prompt")!;
    const metrics = new Metrics(config);
    const outbox = new OutboxProcessor(
      config,
      db,
      new Map([["alpha-buzz", adapter]]),
      metrics,
      null,
      { normalized },
    );
    const published: Event[] = [];
    adapter.setPublisher(async (event) => {
      published.push(event);
      return published.length === 1
        ? { ok: false, retriable: true, description: "ack lost" }
        : { ok: true, externalMessageId: event.id };
    });
    const outboxId = outbox.queueFinalResponse(turnId, "**reply**")!;
    const stored = db
      ._unsafeQuery(
        "SELECT signed_payload_json, signed_event_id FROM outbox WHERE id=?",
      )
      .get(outboxId) as {
      signed_payload_json: string;
      signed_event_id: string;
    };
    const signed = JSON.parse(stored.signed_payload_json) as Event;
    expect(verifyEvent(signed)).toBe(true);
    expect(signed.id).toBe(stored.signed_event_id);
    expect(signed.content).toBe("**reply**");
    expect(signed.tags).toContainEqual(["h", CHANNEL]);
    expect(signed.tags).toContainEqual(["e", raw.id, "", "reply"]);
    expect(signed.tags).toContainEqual(["p", OWNER_PUBKEY]);

    await outbox.drain(50);
    db._unsafeQuery(
      "UPDATE outbox SET next_attempt_at=datetime('now','-1 second') WHERE id=?",
    ).run(outboxId);
    await outbox.drain(100);
    expect(published).toHaveLength(2);
    expect(JSON.stringify(published[0])).toBe(JSON.stringify(published[1]));
    expect(db.getOutboxRow(outboxId)?.status).toBe("sent");
    db.close();
  });

  test("suppresses a seventh reply in one minute without trusting trace tags", () => {
    const { adapter, db, config, normalized } = setup();
    adapter.setChannels(
      new Map([[CHANNEL, { id: CHANNEL, name: "Jason", type: "dm" as const }]]),
    );
    const decision = adapter.evaluateInbound(message(), new Set([CHANNEL]));
    if (decision.kind !== "accepted" || !decision.event.conversation) {
      throw new Error("not accepted");
    }
    const metrics = new Metrics(config);
    const outbox = new OutboxProcessor(
      config,
      db,
      new Map([["alpha-buzz", adapter]]),
      metrics,
      null,
      { normalized },
    );
    const ids = Array.from({ length: 7 }, (_, index) =>
      outbox.queueOperation(null, "alpha", decision.event.conversation!, {
        kind: "send",
        text: `reply ${index + 1}`,
        files: [],
        replyTo: decision.event.externalEventId,
        mentions: [OWNER_PUBKEY],
      }),
    );
    expect(ids.slice(0, 6).map((id) => db.getOutboxRow(id)?.status)).toEqual(
      Array(6).fill("pending"),
    );
    expect(db.getOutboxRow(ids[6]!)?.status).toBe("dead");
    expect(metrics.snapshot().alpha?.counters.loop_budget_rejected).toBe(1);
    db.close();
  });

  test("owns final runner delivery and durably signs the reply", async () => {
    const { adapter, db, config, normalized } = setup();
    adapter.setChannels(
      new Map([[CHANNEL, { id: CHANNEL, name: "Jason", type: "dm" as const }]]),
    );
    const raw = message();
    const decision = adapter.evaluateInbound(raw, new Set([CHANNEL]));
    if (decision.kind !== "accepted") throw new Error("not accepted");
    const recorded = db.recordBuzzInbound({
      event: decision.event,
      status: "received",
      cursorScope: decision.cursorScope,
    });
    if (recorded.kind !== "inserted") throw new Error("duplicate fixture");
    db.transitionInboundEvent(recorded.id, "received", "dispatched");
    const turnId = db.enqueueRecordedBuzzTurn(recorded.id, "alpha", "prompt")!;
    db.initWorkerState("alpha");
    const metrics = new Metrics(config);
    const adapters = new Map([["alpha-buzz", adapter]]);
    const outbox = new OutboxProcessor(config, db, adapters, metrics, null, {
      normalized,
    });
    const bot = new Bot({
      config,
      botConfig: makeTestBotConfig("alpha"),
      db,
      endpoint: adapter,
      streaming: new StreamManager(config, db, outbox, adapters),
      outbox,
      metrics,
      alerts: new AlertManager(config, adapters),
      runner: new SilentRunner(),
    });
    const session = new ControlledSession();
    const outcome = new Promise<string>((resolve) => {
      expect(
        bot.dispatchSessionTurn(
          "buzz:alpha",
          session,
          turnId,
          0,
          "prompt",
          [],
          (terminal) => resolve(terminal.kind),
        ),
      ).toBe(true);
    });
    session.finish("transport-owned final");
    expect(await outcome).toBe("completed");
    const turn = db.getTurnExtended(turnId);
    expect(turn?.status).toBe("completed");
    expect(turn?.final_text).toBe("transport-owned final");
    const row = db
      ._unsafeQuery(
        "SELECT status, signed_payload_json FROM outbox WHERE turn_id=?",
      )
      .get(turnId) as { status: string; signed_payload_json: string };
    expect(row.status).toBe("pending");
    expect(verifyEvent(JSON.parse(row.signed_payload_json) as Event)).toBe(
      true,
    );
    expect(
      (
        db
          ._unsafeQuery("SELECT status FROM inbound_events WHERE id=?")
          .get(recorded.id) as { status: string }
      ).status,
    ).toBe("processed");
    db.close();
  });

  test("supports intrinsic owner commands and durable command replies", async () => {
    const { adapter, db } = setup();
    const replies: string[] = [];
    const parsed = parseCommand("!rotate");
    expect(parsed).toEqual({ trigger: "!rotate", rest: "" });
    await dispatchCommand(
      {
        botConfig: makeTestBotConfig("alpha"),
        chatId: 0,
        messageId: 0,
        fromUserId: 0,
        rawText: "!rotate",
        adapter,
        conversation: {
          platform: "buzz",
          communityId: "primary",
          endpointId: "alpha-buzz",
          channelId: CHANNEL,
          threadRootId: null,
          workflowRunId: null,
          type: "direct",
        },
        runner: {
          supportsReset: () => true,
          reset: async () => {},
        } as never,
        getStatus: () => ({
          botId: "alpha",
          runner_ready: true,
          mailbox_depth: 0,
          last_turn_at: null,
          disabled: false,
          disabled_reason: null,
        }),
        resetConversation: async () => "Session cleared. Fresh start ready.",
        queueReply: (text) => replies.push(text),
      },
      parsed!,
    );
    expect(replies).toEqual(["Session cleared. Fresh start ready."]);
    expect(
      adapter.evaluateInbound(
        message({ secret: PEER_SECRET, content: "!status" }),
        new Set([CHANNEL]),
      ),
    ).toEqual(
      expect.objectContaining({
        kind: "rejected",
        reason: "owner_control_required",
      }),
    );
    expect(PEER_PUBKEY).toHaveLength(64);
    db.close();
  });
});
