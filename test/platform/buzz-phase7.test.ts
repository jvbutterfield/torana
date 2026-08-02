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
import { BuzzAdapter } from "../../src/platform/buzz/adapter.js";
import {
  BUZZ_KINDS,
  createOwnerAuthTag,
  decodeSecret,
  publicKey,
} from "../../src/platform/buzz/protocol.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const ENDPOINT_KEY = "31".padStart(64, "0");
const OWNER_KEY = "32".padStart(64, "0");
const ENDPOINT_SECRET = decodeSecret(ENDPOINT_KEY);
const OWNER_SECRET = decodeSecret(OWNER_KEY);
const ENDPOINT_PUBKEY = publicKey(ENDPOINT_SECRET);
const OWNER_PUBKEY = publicKey(OWNER_SECRET);
const CHANNEL = "44444444-5555-4666-8777-888888888888";
const AUTH_TAG = JSON.stringify(
  createOwnerAuthTag(OWNER_SECRET, ENDPOINT_PUBKEY, ""),
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup(channelType: "forum" | "workflow" = "forum") {
  const dir = mkdtempSync(join(tmpdir(), "torana-buzz-p7-"));
  tempDirs.push(dir);
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
  upgraded.platforms.buzz.enabled = true;
  upgraded.sessions.scope = "conversation";
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
    subscribe: "all_channels",
    reactions: {},
    triggers: {
      feed: {
        enabled: true,
        modes: ["mentions", "needs_action"],
        interval_secs: 60,
      },
      workflows: {
        enabled: true,
        event_kinds: [
          BUZZ_KINDS.workflowTriggered,
          BUZZ_KINDS.workflowApprovalRequested,
        ],
      },
      heartbeat: {
        enabled: true,
        interval_secs: 60,
        target_channel: CHANNEL,
        prompt: "Check for work that needs attention.",
      },
    },
    channel_overrides: {
      [CHANNEL]: { require_mention: false },
    },
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
    new Map([[CHANNEL, { id: CHANNEL, name: channelType, type: channelType }]]),
  );
  return { ...loaded, db, adapter };
}

function event(kind: number, content: string, tags: string[][] = []): Event {
  return finalizeEvent(
    {
      kind,
      content,
      tags: [["h", CHANNEL], ...tags],
      created_at: Math.floor(Date.now() / 1000),
    },
    OWNER_SECRET,
  );
}

function accepted(adapter: BuzzAdapter, raw: Event) {
  const decision = adapter.evaluateInbound(raw, new Set([CHANNEL]));
  if (decision.kind !== "accepted") {
    throw new Error(`expected accepted event, got ${decision.kind}`);
  }
  return decision.event;
}

describe("Phase 7 Buzz forums", () => {
  test("isolates forum roots and keeps nested comments on the root session", () => {
    const { db, adapter } = setup();
    const first = accepted(adapter, event(BUZZ_KINDS.forumPost, "First"));
    const second = accepted(adapter, event(BUZZ_KINDS.forumPost, "Second"));
    const parent = event(BUZZ_KINDS.forumComment, "Parent", [
      ["e", first.externalEventId, "", "root"],
      ["e", first.externalEventId, "", "reply"],
    ]);
    const nested = accepted(
      adapter,
      event(BUZZ_KINDS.forumComment, "Nested", [
        ["e", first.externalEventId, "", "root"],
        ["e", parent.id, "", "reply"],
      ]),
    );

    const firstSession = db.resolveConversation("alpha", first.conversation!);
    const secondSession = db.resolveConversation("alpha", second.conversation!);
    const nestedSession = db.resolveConversation("alpha", nested.conversation!);
    expect(first.conversation!.threadRootId).toBe(first.externalEventId);
    expect(nested.conversation!.threadRootId).toBe(first.externalEventId);
    expect(nested.replyTo).toBe(parent.id);
    expect(firstSession.sessionKey).toBe(nestedSession.sessionKey);
    expect(firstSession.sessionKey).not.toBe(secondSession.sessionKey);
    db.close();
  });

  test("signs native forum posts, nested comments, and votes", () => {
    const { db, adapter } = setup();
    const conversation = {
      platform: "buzz" as const,
      communityId: "primary",
      endpointId: "alpha-buzz",
      channelId: CHANNEL,
      threadRootId: "a".repeat(64),
      workflowRunId: null,
      type: "forum" as const,
    };
    const post = JSON.parse(
      adapter.prepareOutbound(conversation, {
        kind: "forum_post",
        channelId: CHANNEL,
        title: "Release",
        text: "Ship it",
      }).signedPayloadJson!,
    ) as Event;
    const comment = JSON.parse(
      adapter.prepareOutbound(conversation, {
        kind: "forum_comment",
        rootEventId: "a".repeat(64),
        replyTo: "b".repeat(64),
        text: "Agreed",
      }).signedPayloadJson!,
    ) as Event;
    const vote = JSON.parse(
      adapter.prepareOutbound(conversation, {
        kind: "vote",
        externalMessageId: "b".repeat(64),
        direction: "up",
      }).signedPayloadJson!,
    ) as Event;

    expect(post.kind).toBe(BUZZ_KINDS.forumPost);
    expect(post.content).toBe("# Release\n\nShip it");
    expect(comment.kind).toBe(BUZZ_KINDS.forumComment);
    expect(comment.tags).toContainEqual(["e", "a".repeat(64), "", "root"]);
    expect(comment.tags).toContainEqual(["e", "b".repeat(64), "", "reply"]);
    expect(vote.kind).toBe(BUZZ_KINDS.forumVote);
    expect(vote.content).toBe("+");
    db.close();
  });
});

describe("Phase 7 Buzz workflows and proactive triggers", () => {
  test("accepts needs-action feed events without enabling all workflow events", () => {
    const { db, adapter } = setup("workflow");
    adapter.config.triggers.workflows.enabled = false;
    const approval = accepted(
      adapter,
      event(BUZZ_KINDS.workflowApprovalRequested, "Approval required", [
        ["run", "run-approval"],
      ]),
    );
    expect(approval.kind).toBe("workflow_event");
    expect(approval.workflowRunId).toBe("run-approval");
    db.close();
  });

  test("isolates configured workflow events by run provenance", () => {
    const { db, adapter } = setup("workflow");
    const first = accepted(
      adapter,
      event(BUZZ_KINDS.workflowTriggered, JSON.stringify({ run_id: "run-a" })),
    );
    const second = accepted(
      adapter,
      event(BUZZ_KINDS.workflowTriggered, "started", [["run", "run-b"]]),
    );
    expect(first.kind).toBe("workflow_event");
    expect(first.workflowRunId).toBe("run-a");
    expect(second.workflowRunId).toBe("run-b");
    expect(
      db.resolveConversation("alpha", first.conversation!).sessionKey,
    ).not.toBe(
      db.resolveConversation("alpha", second.conversation!).sessionKey,
    );
    db.close();
  });

  test("queues at most one heartbeat and never queues behind human work", () => {
    const { db } = setup();
    const args = {
      agentId: "alpha",
      endpointId: "alpha-buzz",
      communityId: "primary",
      channelId: CHANNEL,
      prompt: "Check for work that needs attention.",
    };
    const first = db.enqueueBuzzHeartbeat(args);
    expect(first).toBeNumber();
    expect(db.enqueueBuzzHeartbeat(args)).toBeNull();
    const row = db
      ._unsafeQuery("SELECT prompt_text FROM turns WHERE id=?")
      .get(first!) as { prompt_text: string };
    expect(row.prompt_text).toContain("lower-priority proactive work");
    expect(row.prompt_text).toContain("Do not issue workflow approvals");
    expect(
      db
        ._unsafeQuery(
          "SELECT COUNT(*) AS count FROM turns WHERE agent_id='alpha' AND status='queued'",
        )
        .get(),
    ).toEqual({ count: 1 });
    db.close();
  });
});
