// US-022 — presence heartbeat hardening.
//
// A Buzz client decides "is this agent online?" from nothing but kind-20001
// presence events, which the relay expires 180 s after the last accepted one.
// Everything here defends that one signal: the supervisor's refresh must never
// be dropped by Torana's own rate limiter, and a run of refusals from the relay
// must surface as a health problem before the TTL can lapse.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  finalizeEvent,
  verifyEvent,
  type Event,
  type Filter,
} from "nostr-tools";
import type { AlertManager } from "../../src/alerts.js";
import { loadConfigFromString } from "../../src/config/load.js";
import { ConfigV2Schema, upgradeV1Object } from "../../src/config/v2.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { resetLoggerState } from "../../src/log.js";
import { BuzzAdapter } from "../../src/platform/buzz/adapter.js";
import {
  BuzzTransport,
  PRESENCE_STALE,
} from "../../src/platform/buzz/transport.js";
import {
  BUZZ_KINDS,
  BUZZ_PRESENCE_TTL_SECS,
  createOwnerAuthTag,
  decodeSecret,
  publicKey,
  verifyOwnerAuthTag,
} from "../../src/platform/buzz/protocol.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const ENDPOINT_KEY = "01".padStart(64, "0");
const ENDPOINT_SECRET = decodeSecret(ENDPOINT_KEY);
const RELAY_SECRET = decodeSecret("02".padStart(64, "0"));
const OWNER_SECRET = decodeSecret("04".padStart(64, "0"));
const ENDPOINT_PUBKEY = publicKey(ENDPOINT_SECRET);
const OWNER_PUBKEY = publicKey(OWNER_SECRET);
const CHANNEL = "11111111-2222-4333-8444-555555555555";
const AUTH_TAG = createOwnerAuthTag(OWNER_SECRET, ENDPOINT_PUBKEY, "kind=9");

const tempDirs: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const transports: BuzzTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.stop()));
  for (const relay of servers.splice(0)) relay.stop(true);
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  resetLoggerState();
});

const conversation = {
  platform: "buzz" as const,
  communityId: "primary",
  endpointId: "alpha-buzz",
  channelId: CHANNEL,
  threadRootId: null,
  workflowRunId: null,
  type: "stream" as const,
};

interface SocketData {
  authenticated: boolean;
  subscriptions: Map<string, Filter[]>;
}

/**
 * Minimal relay that can be told to refuse presence events, which is how the
 * failure path is driven: the connection stays up and only the liveness signal
 * stops landing.
 */
function createPresenceRelay() {
  const challenge = "presence-fixed-challenge";
  const accepted: Event[] = [];
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>();
  let rejectPresence = false;
  let presenceRejections = 0;

  const server = Bun.serve<SocketData>({
    port: 0,
    fetch(request, server) {
      if (
        server.upgrade(request, {
          data: { authenticated: false, subscriptions: new Map() },
        })
      ) {
        return undefined;
      }
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        socket.send(JSON.stringify(["AUTH", challenge]));
      },
      close(socket) {
        sockets.delete(socket);
      },
      message(socket, raw) {
        const frame = JSON.parse(String(raw)) as [string, ...unknown[]];
        if (frame[0] === "AUTH") {
          const auth = frame[1] as Event;
          const ownerTag = auth.tags.find((tag) => tag[0] === "auth");
          const ok =
            verifyEvent(auth) &&
            auth.pubkey === ENDPOINT_PUBKEY &&
            Boolean(
              ownerTag &&
              verifyOwnerAuthTag(ownerTag as typeof AUTH_TAG, auth.pubkey),
            );
          socket.data.authenticated = ok;
          socket.send(JSON.stringify(["OK", auth.id, ok, "authenticated"]));
          return;
        }
        if (!socket.data.authenticated) return;
        if (frame[0] === "EVENT") {
          const event = frame[1] as Event;
          if (event.kind === BUZZ_KINDS.presence && rejectPresence) {
            presenceRejections += 1;
            socket.send(
              JSON.stringify(["OK", event.id, false, "presence refused"]),
            );
            return;
          }
          accepted.push(event);
          socket.send(JSON.stringify(["OK", event.id, true, "saved"]));
          return;
        }
        if (frame[0] === "CLOSE") {
          socket.data.subscriptions.delete(String(frame[1]));
          return;
        }
        if (frame[0] !== "REQ") return;
        const id = String(frame[1]);
        socket.data.subscriptions.set(id, frame.slice(2) as Filter[]);
        socket.send(
          JSON.stringify([
            "EVENT",
            id,
            finalizeEvent(
              {
                kind: BUZZ_KINDS.groupMembers,
                created_at: 1_700_000_000,
                content: "",
                tags: [
                  ["d", CHANNEL],
                  ["p", ENDPOINT_PUBKEY],
                ],
              },
              RELAY_SECRET,
            ),
          ]),
        );
        socket.send(JSON.stringify(["EOSE", id]));
      },
    },
  });
  servers.push(server);

  return {
    url: `ws://127.0.0.1:${server.port}`,
    presence: () => accepted.filter((e) => e.kind === BUZZ_KINDS.presence),
    presenceRejections: () => presenceRejections,
    setRejectPresence(value: boolean) {
      rejectPresence = value;
    },
  };
}

function makeLoaded(
  relayUrl: string,
  options: { heartbeatSecs?: number; presenceMinIntervalMs?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "torana-buzz-presence-"));
  tempDirs.push(dir);
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
  upgraded.platforms.buzz = {
    enabled: true,
    reconnect: { base_ms: 100, cap_ms: 100 },
    subscription: {
      historical_limit: 100,
      replay_overlap_secs: 5,
      heartbeat_secs: options.heartbeatSecs ?? 5,
    },
    message_max_bytes: 65_536,
  };
  upgraded.limits.relay_ok_wait_ms = 1000;
  upgraded.limits.reconnect_alert_after_secs = 3600;
  upgraded.limits.presence_min_interval_ms =
    options.presenceMinIntervalMs ?? 300_000;
  upgraded.agents[0].endpoints.push({
    id: "alpha-buzz",
    platform: "buzz",
    enabled: true,
    community_id: "primary",
    relay_url: relayUrl,
    private_key: ENDPOINT_KEY,
    auth_tag: JSON.stringify(AUTH_TAG),
    respond_to: "owner_only",
    owner_pubkey: OWNER_PUBKEY,
    allowed_pubkeys: [],
    subscribe: "mentions_and_dms",
    channel_overrides: {},
  });
  return loadConfigFromString(yaml.dump(upgraded), { skipInterpolation: true });
}

function openDb(loaded: ReturnType<typeof makeLoaded>): GatewayDB {
  applyMigrations(loaded.config.gateway.db_path!);
  const db = new GatewayDB(loaded.config.gateway.db_path!);
  db.syncNormalizedConfig(loaded.normalized);
  return db;
}

function trackTransport(transport: BuzzTransport): BuzzTransport {
  transports.push(transport);
  return transport;
}

function recordingAlerts(): {
  alerts: AlertManager;
  degraded: Array<{ botId: string; reason: string }>;
} {
  const degraded: Array<{ botId: string; reason: string }> = [];
  const alerts = {
    async workerDegraded(botId: string, reason: string) {
      degraded.push({ botId, reason });
    },
  } as unknown as AlertManager;
  return { alerts, degraded };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out: ${message}`);
}

function adapterFor(loaded: ReturnType<typeof makeLoaded>): BuzzAdapter {
  return new BuzzAdapter(
    loaded.normalized.endpoints.find((item) => item.id === "alpha-buzz")!,
  );
}

describe("Buzz presence rate limiting", () => {
  test("a lifecycle refresh publishes at, and inside, the rate-limit boundary", async () => {
    const relay = createPresenceRelay();
    const loaded = makeLoaded(relay.url);
    const adapter = adapterFor(loaded);
    const published: Event[] = [];
    adapter.setRateLimits({ presence: 30_000 });
    adapter.setPublisher(async (event) => {
      published.push(event);
      return { ok: true, externalMessageId: event.id };
    });

    // Back-to-back: elapsed is ~0 ms, far inside a 30 s limit. Both land
    // because the lifecycle loop owns the liveness signal.
    for (let i = 0; i < 3; i++) {
      expect(
        await adapter.signalDetailed(conversation, {
          kind: "presence",
          state: "online",
          lifecycle: true,
        }),
      ).toBe("published");
    }
    expect(published).toHaveLength(3);
    expect(published.every((e) => e.kind === BUZZ_KINDS.presence)).toBe(true);
    expect(published.every((e) => e.content === "online")).toBe(true);
  });

  test("conversation-driven presence stays rate-limited", async () => {
    const relay = createPresenceRelay();
    const loaded = makeLoaded(relay.url);
    const adapter = adapterFor(loaded);
    const published: Event[] = [];
    adapter.setRateLimits({ presence: 30_000 });
    adapter.setPublisher(async (event) => {
      published.push(event);
      return { ok: true, externalMessageId: event.id };
    });

    expect(
      await adapter.signalDetailed(conversation, {
        kind: "presence",
        state: "online",
      }),
    ).toBe("published");
    expect(
      await adapter.signalDetailed(conversation, {
        kind: "presence",
        state: "online",
      }),
    ).toBe("suppressed");
    // `signal()` keeps its boolean contract: suppressed is not published.
    expect(
      await adapter.signal(conversation, { kind: "presence", state: "online" }),
    ).toBe(false);
    expect(published).toHaveLength(1);

    // A lifecycle refresh is not blocked by the conversation-driven publish
    // that just consumed the window — this is the interleaving that produced
    // the ~60 s effective cadence.
    expect(
      await adapter.signalDetailed(conversation, {
        kind: "presence",
        state: "online",
        lifecycle: true,
      }),
    ).toBe("published");
    expect(published).toHaveLength(2);
  });

  test("offline bypasses the limit and typing does not", async () => {
    const relay = createPresenceRelay();
    const loaded = makeLoaded(relay.url);
    const adapter = adapterFor(loaded);
    const published: Event[] = [];
    adapter.setRateLimits({ presence: 30_000, typing: 30_000 });
    adapter.setPublisher(async (event) => {
      published.push(event);
      return { ok: true, externalMessageId: event.id };
    });

    await adapter.signalDetailed(conversation, {
      kind: "presence",
      state: "online",
    });
    expect(
      await adapter.signalDetailed(conversation, {
        kind: "presence",
        state: "offline",
      }),
    ).toBe("published");
    expect(published.at(-1)!.content).toBe("offline");

    expect(
      await adapter.signalDetailed(conversation, {
        kind: "typing",
        active: true,
      }),
    ).toBe("published");
    expect(
      await adapter.signalDetailed(conversation, {
        kind: "typing",
        active: true,
      }),
    ).toBe("suppressed");
  });

  test("a rejected publish is reported as failed, not suppressed", async () => {
    const relay = createPresenceRelay();
    const loaded = makeLoaded(relay.url);
    const adapter = adapterFor(loaded);
    adapter.setPublisher(async () => ({
      ok: false,
      retriable: true,
      description: "relay refused",
    }));
    expect(
      await adapter.signalDetailed(conversation, {
        kind: "presence",
        state: "online",
        lifecycle: true,
      }),
    ).toBe("failed");

    // A throwing publisher is a failure too, not a silent success.
    adapter.setPublisher(async () => {
      throw new Error("socket closed");
    });
    expect(
      await adapter.signalDetailed(conversation, {
        kind: "presence",
        state: "online",
        lifecycle: true,
      }),
    ).toBe("failed");

    // With no publisher at all there is nothing to rate-limit and nothing
    // landed: that is a failure, and it must not reset the failure counter.
    adapter.setPublisher(null);
    expect(
      await adapter.signalDetailed(conversation, {
        kind: "presence",
        state: "online",
        lifecycle: true,
      }),
    ).toBe("failed");
  });
});

describe("Buzz presence supervisor health", () => {
  test(
    "the heartbeat keeps refreshing inside the rate-limit window",
    async () => {
      // The shipped shape of the defect: a presence rate limit an order of
      // magnitude longer than the heartbeat. Every refresh after the first
      // would have been dropped.
      const relay = createPresenceRelay();
      const loaded = makeLoaded(relay.url, {
        heartbeatSecs: 5,
        presenceMinIntervalMs: 300_000,
      });
      const db = openDb(loaded);
      const transport = trackTransport(
        new BuzzTransport({
          db,
          normalized: loaded.normalized,
          endpoints: loaded.normalized.endpoints,
          lifecyclePollMs: 10,
        }),
      );
      await transport.start(async () => {});
      await waitFor(
        () => transport.snapshots()[0]?.state === "healthy",
        "endpoint connected",
      );
      await waitFor(
        () => relay.presence().length >= 3,
        "three presence refreshes",
      );

      const timestamps = relay.presence().map((e) => e.created_at);
      for (let i = 1; i < timestamps.length; i++) {
        // Each gap must stay well inside the relay's TTL; the heartbeat is
        // 5 s here, and the assertion is the property that matters — never a
        // gap that could expire presence.
        expect(timestamps[i]! - timestamps[i - 1]!).toBeLessThan(
          BUZZ_PRESENCE_TTL_SECS,
        );
      }

      const snapshot = transport.snapshots()[0]!;
      expect(snapshot.presence.suppressed).toBe(0);
      expect(snapshot.presence.failed).toBe(0);
      expect(snapshot.presence.stale).toBe(false);
      expect(snapshot.presence.attempted).toBeGreaterThanOrEqual(3);
      expect(snapshot.presence.lastPublishedAt).not.toBeNull();
      db.close();
    },
    { timeout: 40_000 },
  );

  test(
    "two consecutive failures mark the endpoint stale, alert once, and recover",
    async () => {
      const relay = createPresenceRelay();
      relay.setRejectPresence(true);
      const loaded = makeLoaded(relay.url, {
        heartbeatSecs: 5,
        presenceMinIntervalMs: 300_000,
      });
      const db = openDb(loaded);
      const { alerts, degraded } = recordingAlerts();
      const transport = trackTransport(
        new BuzzTransport({
          db,
          normalized: loaded.normalized,
          endpoints: loaded.normalized.endpoints,
          alerts,
          lifecyclePollMs: 10,
        }),
      );
      await transport.start(async () => {});

      // One failure is not yet a health problem: the relay's TTL still has
      // room for the next heartbeat to land.
      await waitFor(
        () => transport.snapshots()[0]!.presence.failed >= 1,
        "first presence rejection",
      );
      expect(transport.snapshots()[0]!.presence.stale).toBe(false);
      expect(degraded).toHaveLength(0);

      await waitFor(
        () => transport.snapshots()[0]!.presence.stale,
        "presence marked stale",
      );
      const stale = transport.snapshots()[0]!;
      expect(stale.state).toBe("unhealthy");
      expect(stale.lastError).toBe(PRESENCE_STALE);
      expect(stale.presence.consecutiveFailures).toBeGreaterThanOrEqual(2);
      expect(degraded).toHaveLength(1);
      expect(degraded[0]!.botId).toBe("alpha");
      expect(degraded[0]!.reason).toContain("alpha-buzz");

      // Still failing is still one alert — the operator is told once per
      // episode, not once per heartbeat.
      const failedAtAlert = stale.presence.failed;
      await waitFor(
        () => transport.snapshots()[0]!.presence.failed > failedAtAlert,
        "another rejection after the alert",
      );
      expect(degraded).toHaveLength(1);

      relay.setRejectPresence(false);
      await waitFor(
        () => transport.snapshots()[0]!.presence.stale === false,
        "presence recovered",
      );
      const recovered = transport.snapshots()[0]!;
      expect(recovered.state).toBe("healthy");
      expect(recovered.lastError).toBeNull();
      expect(recovered.presence.consecutiveFailures).toBe(0);
      expect(recovered.presence.lastPublishedAt).not.toBeNull();
      expect(relay.presenceRejections()).toBeGreaterThanOrEqual(2);

      // A second episode re-arms the alert rather than staying silent.
      relay.setRejectPresence(true);
      await waitFor(
        () => transport.snapshots()[0]!.presence.stale,
        "second stale episode",
      );
      expect(degraded).toHaveLength(2);
      db.close();
    },
    { timeout: 60_000 },
  );

  test(
    "a clean stop publishes offline even with the limiter wide open",
    async () => {
      const relay = createPresenceRelay();
      const loaded = makeLoaded(relay.url, {
        heartbeatSecs: 60,
        presenceMinIntervalMs: 300_000,
      });
      const db = openDb(loaded);
      const transport = trackTransport(
        new BuzzTransport({
          db,
          normalized: loaded.normalized,
          endpoints: loaded.normalized.endpoints,
          lifecyclePollMs: 10,
        }),
      );
      await transport.start(async () => {});
      await waitFor(
        () => relay.presence().length >= 1,
        "connect presence published",
      );
      await transport.stop();
      transports.length = 0;
      await waitFor(
        () => relay.presence().some((e) => e.content === "offline"),
        "offline presence published on stop",
      );
      db.close();
    },
    { timeout: 30_000 },
  );
});

describe("presence configuration", () => {
  function parse(mutate: (config: any) => void) {
    const upgraded = upgradeV1Object(
      makeTestConfig([makeTestBotConfig("alpha")]),
    ) as any;
    upgraded.platforms.buzz = {
      enabled: true,
      subscription: { heartbeat_secs: 30 },
    };
    mutate(upgraded);
    return ConfigV2Schema.safeParse(upgraded);
  }

  test("the shipped defaults are accepted", () => {
    const result = parse(() => {});
    expect(result.success).toBe(true);
    expect(result.data!.limits.presence_min_interval_ms).toBe(30_000);
    expect(result.data!.limits.presence_failure_threshold).toBe(2);
    expect(result.data!.platforms.buzz!.subscription.heartbeat_secs).toBe(30);
  });

  test("a presence limit at or above the heartbeat is allowed, because lifecycle presence bypasses it", () => {
    const equal = parse((config) => {
      config.limits.presence_min_interval_ms = 30_000;
      config.platforms.buzz.subscription.heartbeat_secs = 30;
    });
    expect(equal.success).toBe(true);
    const longer = parse((config) => {
      config.limits.presence_min_interval_ms = 600_000;
      config.platforms.buzz.subscription.heartbeat_secs = 10;
    });
    expect(longer.success).toBe(true);
  });

  test("a heartbeat that cannot survive one failed publish is rejected", () => {
    const half = BUZZ_PRESENCE_TTL_SECS / 2;
    const rejected = parse((config) => {
      config.platforms.buzz.subscription.heartbeat_secs = half;
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error!.issues[0]!.path).toEqual([
      "platforms",
      "buzz",
      "subscription",
      "heartbeat_secs",
    ]);
    expect(rejected.error!.issues[0]!.message).toContain(
      String(BUZZ_PRESENCE_TTL_SECS),
    );

    // The boundary itself: one second under survives.
    expect(
      parse((config) => {
        config.platforms.buzz.subscription.heartbeat_secs = half - 1;
      }).success,
    ).toBe(true);

    // Disabled Buzz is not constrained — the heartbeat never runs.
    expect(
      parse((config) => {
        config.platforms.buzz.enabled = false;
        config.platforms.buzz.subscription.heartbeat_secs = 300;
      }).success,
    ).toBe(true);
  });

  test("the failure threshold must be at least one", () => {
    expect(
      parse((config) => (config.limits.presence_failure_threshold = 0)),
    ).toMatchObject({ success: false });
    expect(
      parse((config) => (config.limits.presence_failure_threshold = 1)).success,
    ).toBe(true);
  });
});

describe("outbound-only publishers", () => {
  test(
    "a publisher announces presence on connect, on every heartbeat, and offline on stop",
    async () => {
      // Publishers are on the presence feed on the same terms as conversational
      // endpoints: the dot reports that the identity's connection is live and
      // its feed is flowing, not that it will answer a message. The three
      // publish sites have to agree — announcing only on the heartbeat would
      // leave the endpoint dark for a full interval after every reconnect, and
      // skipping the stop announcement would leave a stopped publisher showing
      // online until the relay's 180 s TTL lapsed.
      const relay = createPresenceRelay();
      const loaded = makeLoaded(relay.url, { heartbeatSecs: 5 });
      const db = openDb(loaded);

      // Re-label the endpoint as a publisher principal, which is what a
      // `publishers:` block produces.
      const endpoints = loaded.normalized.endpoints.map((endpoint) =>
        endpoint.id === "alpha-buzz"
          ? { ...endpoint, principalKind: "publisher" as const }
          : endpoint,
      );
      // A publisher supervisor also requires its destination channel to be a
      // channel it is actually a member of, or it refuses to come up.
      const normalized = {
        ...loaded.normalized,
        endpoints,
        publishers: [
          {
            id: "alpha",
            enabled: true,
            endpointId: "alpha-buzz",
            destinationConversationId: CHANNEL,
          },
        ],
      };
      const transport = new BuzzTransport({
        db,
        normalized,
        endpoints,
        lifecyclePollMs: 10,
      });
      transports.push(transport);
      await transport.start(async () => {});
      await waitFor(
        () => transport.snapshots()[0]?.state === "healthy",
        "publisher connected",
      );

      // Online before the first heartbeat can have fired, not one interval
      // later. The 5 s heartbeat gives this assertion real room.
      await waitFor(
        () => relay.presence().length >= 1,
        "publisher announced presence on connect",
      );
      expect(relay.presence()[0]!.content).toBe("online");
      expect(transport.snapshots()[0]!.presence.lastPublishedAt).not.toBeNull();

      // Long enough for several heartbeats at a 5 s interval.
      await waitFor(
        () => relay.presence().length >= 3,
        "publisher refreshed presence on the heartbeat",
        20_000,
      );
      const online = relay.presence();
      expect(online.every((e) => e.content === "online")).toBe(true);
      // Refreshes are heartbeat-paced, not rate-limiter-suppressed: lifecycle
      // presence is exempt from `presence_min_interval_ms` for publishers on
      // exactly the same terms as for conversational endpoints.
      const snapshot = transport.snapshots()[0]!;
      expect(snapshot.presence.attempted).toBeGreaterThanOrEqual(3);
      expect(snapshot.presence.suppressed).toBe(0);
      expect(snapshot.presence.failed).toBe(0);
      expect(snapshot.state).toBe("healthy");
      expect(snapshot.presence.stale).toBe(false);
      expect(snapshot.connected).toBe(true);

      await transport.stop();
      transports.length = 0;
      await waitFor(
        () => relay.presence().some((e) => e.content === "offline"),
        "publisher announced offline on stop",
      );
      db.close();
    },
    { timeout: 60_000 },
  );
});
