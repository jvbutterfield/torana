// Phase 11 mixed-platform soak, gated by BUZZ_PLATFORM_SOAK=1.
//
// Defaults to the release-gate duration (24 hours). A fast deterministic
// smoke run can use:
//   BUZZ_PLATFORM_SOAK=1 BUZZ_PLATFORM_SOAK_DURATION_MS=250 \
//   BUZZ_PLATFORM_SOAK_INTERVAL_MS=10 bun test test/soak/buzz-platform.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { verifyEvent, type Event } from "nostr-tools";

import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { Metrics } from "../../src/metrics.js";
import { OutboxProcessor } from "../../src/outbox.js";
import type {
  DeliveryResult,
  MessagingEndpoint,
  PlatformAdapter,
} from "../../src/platform/capabilities.js";
import { BuzzAdapter } from "../../src/platform/buzz/adapter.js";
import type {
  ConversationRef,
  EphemeralSignal,
  InboundEvent,
  OutboundOperation,
} from "../../src/platform/types.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const SOAK_ENABLED = process.env.BUZZ_PLATFORM_SOAK === "1";
const PERSONAS = ["planner", "builder", "reviewer", "researcher", "operator"];
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

class RecordingTelegramAdapter implements PlatformAdapter {
  readonly endpoint: MessagingEndpoint;
  constructor(
    endpoint: MessagingEndpoint,
    private readonly delivered: Array<{ endpointId: string; text: string }>,
  ) {
    this.endpoint = endpoint;
  }
  normalizeInbound(_raw: unknown): InboundEvent | null {
    return null;
  }
  async deliver(
    _conversation: ConversationRef,
    operation: OutboundOperation,
  ): Promise<DeliveryResult> {
    this.delivered.push({
      endpointId: this.endpoint.id,
      text: "text" in operation ? operation.text : operation.kind,
    });
    return {
      ok: true,
      externalMessageId: `${this.endpoint.id}-${this.delivered.length}`,
    };
  }
  async signal(
    _conversation: ConversationRef,
    _signal: EphemeralSignal,
  ): Promise<boolean> {
    return true;
  }
  async materializeAttachments() {
    return { attachments: [], errors: [] };
  }
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function conversation(
  platform: "telegram" | "buzz",
  endpointId: string,
  communityId: string | null,
  index: number,
): ConversationRef {
  return {
    platform,
    endpointId,
    communityId,
    channelId:
      platform === "telegram"
        ? String(900_000 + index)
        : `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    threadRootId: null,
    workflowRunId: null,
    type: platform === "telegram" ? "direct" : "stream",
  };
}

describe.skipIf(!SOAK_ENABLED)("Phase 11 mixed-platform soak", () => {
  test("preserves delivery and session isolation across every persona", async () => {
    const durationMs = positiveNumber(
      "BUZZ_PLATFORM_SOAK_DURATION_MS",
      24 * 60 * 60 * 1000,
    );
    const intervalMs = positiveNumber("BUZZ_PLATFORM_SOAK_INTERVAL_MS", 60_000);
    const conversationCount = positiveNumber(
      "BUZZ_PLATFORM_SOAK_CONVERSATIONS",
      20,
    );
    const dir = mkdtempSync(join(tmpdir(), "torana-buzz-soak-"));
    dirs.push(dir);
    const upgraded = upgradeV1Object(
      makeTestConfig(PERSONAS.map((id) => makeTestBotConfig(id))),
    ) as any;
    upgraded.gateway.data_dir = dir;
    upgraded.gateway.db_path = join(dir, "gateway.db");
    upgraded.sessions.scope = "conversation";
    upgraded.platforms.buzz.enabled = true;
    for (const [index, agent] of upgraded.agents.entries()) {
      agent.endpoints.push({
        id: `${agent.id}-buzz`,
        platform: "buzz",
        enabled: true,
        community_id: "soak",
        relay_url: "ws://127.0.0.1:65535",
        private_key: String(index + 1).padStart(64, "0"),
        respond_to: "anyone",
        allowed_pubkeys: [],
        subscribe: "mentions_and_dms",
        triggers: {},
        channel_overrides: {},
      });
    }
    const loaded = loadConfigFromString(yaml.dump(upgraded), {
      skipInterpolation: true,
    });
    applyMigrations(loaded.config.gateway.db_path!);
    const db = new GatewayDB(loaded.config.gateway.db_path!);
    db.syncNormalizedConfig(loaded.normalized);

    const telegramDelivered: Array<{ endpointId: string; text: string }> = [];
    const buzzDelivered: Array<{ endpointId: string; event: Event }> = [];
    const adapters = new Map<string, PlatformAdapter>();
    for (const endpoint of loaded.normalized.endpoints) {
      if (endpoint.platform === "telegram") {
        adapters.set(
          endpoint.id,
          new RecordingTelegramAdapter(
            {
              id: endpoint.id,
              agentId: endpoint.agentId,
              platform: "telegram",
              communityId: null,
              capabilities: new Set(["send"]),
            },
            telegramDelivered,
          ),
        );
      } else if (endpoint.platform === "buzz") {
        const adapter = new BuzzAdapter(endpoint);
        adapter.setPublisher(async (event) => {
          expect(verifyEvent(event)).toBe(true);
          buzzDelivered.push({ endpointId: endpoint.id, event });
          return { ok: true, externalMessageId: event.id };
        });
        adapters.set(endpoint.id, adapter);
      }
    }
    const outbox = new OutboxProcessor(
      loaded.config,
      db,
      adapters,
      new Metrics(loaded.config),
      null,
      { normalized: loaded.normalized },
    );

    const startedAt = Date.now();
    const initialRss = process.memoryUsage.rss();
    let cycles = 0;
    do {
      const conversationIndex = cycles % conversationCount;
      for (const endpoint of loaded.normalized.endpoints) {
        if (endpoint.platform === "agent_api") continue;
        const ref = conversation(
          endpoint.platform as "telegram" | "buzz",
          endpoint.id,
          endpoint.communityId,
          conversationIndex,
        );
        outbox.queueOperation(null, endpoint.agentId, ref, {
          kind: "send",
          text: `${endpoint.agentId}:${endpoint.platform}:${cycles}`,
          files: [],
        });
      }
      await outbox.drain(5_000);
      cycles += 1;
      const remaining = startedAt + durationMs - Date.now();
      if (remaining > 0) {
        await Bun.sleep(Math.min(intervalMs, remaining));
      }
    } while (Date.now() < startedAt + durationMs);

    const expectedPerPlatform = PERSONAS.length * cycles;
    const sent = db
      ._unsafeQuery("SELECT COUNT(*) AS count FROM outbox WHERE status='sent'")
      .get() as { count: number };
    const failed = db
      ._unsafeQuery("SELECT COUNT(*) AS count FROM outbox WHERE status!='sent'")
      .get() as { count: number };
    const sessions = db
      ._unsafeQuery(
        "SELECT COUNT(DISTINCT session_key) AS count FROM conversations",
      )
      .get() as { count: number };
    const conversations = db
      ._unsafeQuery("SELECT COUNT(*) AS count FROM conversations")
      .get() as { count: number };
    const finalRss = process.memoryUsage.rss();

    expect(telegramDelivered).toHaveLength(expectedPerPlatform);
    expect(buzzDelivered).toHaveLength(expectedPerPlatform);
    expect(new Set(buzzDelivered.map(({ event }) => event.id)).size).toBe(
      expectedPerPlatform,
    );
    expect(sent.count).toBe(expectedPerPlatform * 2);
    expect(failed.count).toBe(0);
    expect(sessions.count).toBe(conversations.count);
    expect(conversations.count).toBe(
      PERSONAS.length * 2 * Math.min(cycles, conversationCount),
    );
    expect(finalRss).toBeLessThan(initialRss * 2 + 128 * 1024 * 1024);

    const summary = {
      duration_ms: Date.now() - startedAt,
      cycles,
      personas: PERSONAS,
      conversations: conversations.count,
      sent: sent.count,
      failed: failed.count,
      initial_rss_bytes: initialRss,
      final_rss_bytes: finalRss,
    };
    const artifactDir = process.env.BUZZ_PLATFORM_SOAK_ARTIFACT_DIR ?? dir;
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "buzz-platform-soak-summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
    );
    db.close();
  });
});
