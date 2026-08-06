// US-023 — owner `!shutdown` conformance (remote-agents invariant I5).
//
// The wire shape under test is pinned in
// `spike/buzz-transport/owner-shutdown-contract.json`, read from the Buzz
// source at `desktop-v0.5.5`: a stream message whose trimmed content is
// exactly `!shutdown`, p-tagging the agent, authored by the endpoint's owner.
// Everything else — a near-miss content, a non-owner author, a missing
// mention — must stay an ordinary message.

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
import contract from "../../spike/buzz-transport/owner-shutdown-contract.json" with { type: "json" };
import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { resetLoggerState } from "../../src/log.js";
import { BuzzAdapter } from "../../src/platform/buzz/adapter.js";
import {
  BuzzTransport,
  OWNER_SHUTDOWN,
} from "../../src/platform/buzz/transport.js";
import {
  BUZZ_KINDS,
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
const OUTSIDER_SECRET = decodeSecret("05".padStart(64, "0"));
const ENDPOINT_PUBKEY = publicKey(ENDPOINT_SECRET);
const OWNER_PUBKEY = publicKey(OWNER_SECRET);
const OUTSIDER_PUBKEY = publicKey(OUTSIDER_SECRET);
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

function shutdownEvent(
  overrides: {
    content?: string;
    kind?: number;
    secret?: Uint8Array;
    mention?: string | null;
    createdAt?: number;
    extraTags?: string[][];
  } = {},
): Event {
  const mention = overrides.mention === undefined ? ENDPOINT_PUBKEY : null;
  const target = overrides.mention === undefined ? mention : overrides.mention;
  return finalizeEvent(
    {
      kind: overrides.kind ?? BUZZ_KINDS.streamMessageV1,
      created_at: overrides.createdAt ?? Math.floor(Date.now() / 1000),
      content: overrides.content ?? "!shutdown",
      tags: [
        ["h", CHANNEL],
        ...(target ? [["p", target]] : []),
        ...(overrides.extraTags ?? []),
      ],
    },
    overrides.secret ?? OWNER_SECRET,
  );
}

function makeLoaded(
  relayUrl: string,
  options: {
    respondTo?: "owner_only" | "allowlist" | "anyone" | "nobody";
    ownerShutdown?: "enabled" | "disabled";
    drainMs?: number;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "torana-buzz-shutdown-"));
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
      heartbeat_secs: 30,
    },
    message_max_bytes: 65_536,
  };
  upgraded.limits.relay_ok_wait_ms = 1000;
  upgraded.limits.reconnect_alert_after_secs = 3600;
  if (options.drainMs !== undefined) {
    upgraded.limits.owner_shutdown_drain_ms = options.drainMs;
  }
  upgraded.agents[0].endpoints.push({
    id: "alpha-buzz",
    platform: "buzz",
    enabled: true,
    community_id: "primary",
    relay_url: relayUrl,
    private_key: ENDPOINT_KEY,
    auth_tag: JSON.stringify(AUTH_TAG),
    respond_to: options.respondTo ?? "owner_only",
    owner_pubkey: OWNER_PUBKEY,
    allowed_pubkeys: [],
    subscribe: "mentions_and_dms",
    ...(options.ownerShutdown ? { owner_shutdown: options.ownerShutdown } : {}),
    channel_overrides: {},
  });
  return loadConfigFromString(yaml.dump(upgraded), { skipInterpolation: true });
}

function adapterFor(loaded: ReturnType<typeof makeLoaded>): BuzzAdapter {
  return new BuzzAdapter(
    loaded.normalized.endpoints.find((item) => item.id === "alpha-buzz")!,
  );
}

function openDb(loaded: ReturnType<typeof makeLoaded>): GatewayDB {
  applyMigrations(loaded.config.gateway.db_path!);
  const db = new GatewayDB(loaded.config.gateway.db_path!);
  db.syncNormalizedConfig(loaded.normalized);
  return db;
}

const CHANNELS = new Set([CHANNEL]);

interface SocketData {
  authenticated: boolean;
  subscriptions: Map<string, Filter[]>;
}

function createRelay() {
  const challenge = "shutdown-fixed-challenge";
  const stored: Event[] = [];
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>();
  const pending: Event[] = [];

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
          stored.push(event);
          socket.send(JSON.stringify(["OK", event.id, true, "saved"]));
          return;
        }
        if (frame[0] === "CLOSE") {
          socket.data.subscriptions.delete(String(frame[1]));
          return;
        }
        if (frame[0] !== "REQ") return;
        const id = String(frame[1]);
        const filters = frame.slice(2) as Filter[];
        socket.data.subscriptions.set(id, filters);
        const membership = finalizeEvent(
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
        );
        for (const event of [membership, ...pending]) {
          if (filters.some((filter) => matches(event, filter))) {
            socket.send(JSON.stringify(["EVENT", id, event]));
          }
        }
        socket.send(JSON.stringify(["EOSE", id]));
      },
    },
  });
  servers.push(server);

  return {
    url: `ws://127.0.0.1:${server.port}`,
    stored,
    presence: () =>
      stored.filter((event) => event.kind === BUZZ_KINDS.presence),
    published: () =>
      stored.filter(
        (event) =>
          event.kind === BUZZ_KINDS.streamMessageV1 ||
          event.kind === BUZZ_KINDS.streamMessageV2,
      ),
    emit(event: Event) {
      pending.push(event);
      for (const socket of sockets) {
        if (!socket.data.authenticated) continue;
        for (const [id, filters] of socket.data.subscriptions) {
          if (filters.some((filter) => matches(event, filter))) {
            socket.send(JSON.stringify(["EVENT", id, event]));
          }
        }
      }
    },
  };
}

function matches(event: Event, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since)
    return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !values) continue;
    const tagName = key.slice(1);
    if (
      !(values as string[]).some((value) =>
        event.tags.some((tag) => tag[0] === tagName && tag[1] === value),
      )
    ) {
      return false;
    }
  }
  return true;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out: ${message}`);
}

describe("owner !shutdown matching", () => {
  test("the pinned contract is the one the matcher implements", () => {
    // Guards against the fixture and the code drifting apart: if someone
    // relaxes the matcher, this documents what upstream actually does.
    expect(contract.contract.kind).toBe(BUZZ_KINDS.streamMessageV1);
    expect(contract.contract.contentMatch).toContain("exactly");
    expect(contract.source.commit).toBe(
      "8342dfcc5890b81a269a8ec3db73a8a56f76ce79",
    );
  });

  test("owner + exact content + mention is a control command", () => {
    const loaded = makeLoaded("ws://127.0.0.1:1");
    const adapter = adapterFor(loaded);
    const decision = adapter.evaluateInbound(shutdownEvent(), CHANNELS);
    expect(decision.kind).toBe("control");
    expect(decision.kind === "control" && decision.reason).toBe(
      "owner_shutdown",
    );

    // Surrounding whitespace is trimmed, exactly as upstream does.
    for (const content of ["  !shutdown", "!shutdown\n", " \t!shutdown \n"]) {
      const padded = adapter.evaluateInbound(
        shutdownEvent({ content }),
        CHANNELS,
      );
      expect(padded.kind).toBe("control");
    }

    // V2 stream messages carry the same meaning inside Torana.
    expect(
      adapter.evaluateInbound(
        shutdownEvent({ kind: BUZZ_KINDS.streamMessageV2 }),
        CHANNELS,
      ).kind,
    ).toBe("control");
  });

  test("a message that merely contains !shutdown is an ordinary turn", () => {
    const loaded = makeLoaded("ws://127.0.0.1:1");
    const adapter = adapterFor(loaded);
    for (const content of [
      "!shutdown please",
      "can you run !shutdown?",
      "!shutdown!",
      "!shutdownnow",
      "```\n!shutdown\n```",
      "!Shutdown",
    ]) {
      const decision = adapter.evaluateInbound(
        shutdownEvent({ content }),
        CHANNELS,
      );
      expect({ content, kind: decision.kind }).toEqual({
        content,
        kind: "accepted",
      });
    }
  });

  test("a non-owner cannot stop the endpoint, on any respond_to setting", () => {
    // owner_only: the outsider is not even an eligible author.
    const strict = adapterFor(makeLoaded("ws://127.0.0.1:1"));
    const rejected = strict.evaluateInbound(
      shutdownEvent({ secret: OUTSIDER_SECRET }),
      CHANNELS,
    );
    expect(rejected.kind).toBe("rejected");
    expect(rejected.kind === "rejected" && rejected.reason).toBe(
      "unauthorized_author",
    );

    // respond_to: anyone — the outsider's message is a perfectly ordinary
    // prompt, and specifically not a stop command. This is the case where a
    // permissive endpoint could otherwise be shut down by a stranger.
    const open = adapterFor(
      makeLoaded("ws://127.0.0.1:1", { respondTo: "anyone" }),
    );
    const decision = open.evaluateInbound(
      shutdownEvent({ secret: OUTSIDER_SECRET }),
      CHANNELS,
    );
    expect(decision.kind).toBe("accepted");
    expect(
      open.evaluateInbound(shutdownEvent(), CHANNELS).kind === "control",
    ).toBe(true);
  });

  test("an unmentioned !shutdown is not a stop command", () => {
    const loaded = makeLoaded("ws://127.0.0.1:1");
    const adapter = adapterFor(loaded);
    const decision = adapter.evaluateInbound(
      shutdownEvent({ mention: null }),
      CHANNELS,
    );
    expect(decision.kind).toBe("rejected");
    expect(decision.kind === "rejected" && decision.reason).toBe(
      "mention_required",
    );

    // A p-tag naming somebody else is not a mention of this agent.
    const other = adapter.evaluateInbound(
      shutdownEvent({ mention: OUTSIDER_PUBKEY }),
      CHANNELS,
    );
    expect(other.kind).toBe("rejected");
  });

  test("owner_shutdown: disabled restores the old behaviour", () => {
    const adapter = adapterFor(
      makeLoaded("ws://127.0.0.1:1", { ownerShutdown: "disabled" }),
    );
    const decision = adapter.evaluateInbound(shutdownEvent(), CHANNELS);
    expect(decision.kind).toBe("accepted");
  });

  test("a shutdown in an inaccessible channel is rejected before matching", () => {
    const adapter = adapterFor(makeLoaded("ws://127.0.0.1:1"));
    const decision = adapter.evaluateInbound(shutdownEvent(), new Set());
    expect(decision.kind).toBe("rejected");
    expect(decision.kind === "rejected" && decision.reason).toBe(
      "channel_not_accessible",
    );
  });

  test("the agent's own !shutdown echo is not a stop command", () => {
    const adapter = adapterFor(makeLoaded("ws://127.0.0.1:1"));
    const decision = adapter.evaluateInbound(
      shutdownEvent({ secret: ENDPOINT_SECRET }),
      CHANNELS,
    );
    expect(decision.kind).toBe("irrelevant");
  });
});

describe("owner !shutdown lifecycle", () => {
  test(
    "drains, publishes offline, disables, and never replies",
    async () => {
      const relay = createRelay();
      const loaded = makeLoaded(relay.url, { drainMs: 5000 });
      const db = openDb(loaded);
      const dispatched: number[] = [];
      const transport = new BuzzTransport({
        db,
        normalized: loaded.normalized,
        endpoints: loaded.normalized.endpoints,
        lifecyclePollMs: 20,
        onAccepted: ({ inboundEventId }) => {
          dispatched.push(inboundEventId);
        },
      });
      transports.push(transport);
      await transport.start(async () => {});
      await waitFor(
        () => transport.snapshots()[0]?.state === "healthy",
        "connected",
      );

      relay.emit(shutdownEvent());

      await waitFor(
        () => db.getEndpointState("alpha-buzz")?.lifecycleState === "disabled",
        "endpoint disabled by owner",
      );
      const state = db.getEndpointState("alpha-buzz")!;
      expect(state.lifecycleState).toBe("disabled");
      expect(state.stateReason).toBe(OWNER_SHUTDOWN);

      // It answered nothing: the stop command never became a turn.
      expect(dispatched).toEqual([]);
      expect(relay.published()).toHaveLength(0);

      // And it said goodbye rather than waiting out the relay's TTL.
      await waitFor(
        () => relay.presence().some((event) => event.content === "offline"),
        "offline presence published",
      );
      await waitFor(
        () => transport.snapshots()[0]?.state === "disabled",
        "supervisor reports disabled",
      );
      expect(transport.snapshots()[0]!.connected).toBe(false);
      await transport.stop();
      transports.splice(transports.indexOf(transport), 1);
      db.close();
    },
    { timeout: 30_000 },
  );

  test(
    "a replayed shutdown event does not transition twice",
    async () => {
      const relay = createRelay();
      const loaded = makeLoaded(relay.url, { drainMs: 1000 });
      const db = openDb(loaded);
      const transport = new BuzzTransport({
        db,
        normalized: loaded.normalized,
        endpoints: loaded.normalized.endpoints,
        lifecyclePollMs: 20,
      });
      transports.push(transport);
      await transport.start(async () => {});
      await waitFor(
        () => transport.snapshots()[0]?.state === "healthy",
        "connected",
      );

      const event = shutdownEvent();
      relay.emit(event);
      relay.emit(event);
      await waitFor(
        () => db.getEndpointState("alpha-buzz")?.lifecycleState === "disabled",
        "endpoint disabled",
      );
      relay.emit(event);
      await Bun.sleep(200);

      // Event-ID dedup is terminal, so the duplicate never reaches the
      // transition at all — and one shutdown means one goodbye.
      expect(
        relay.presence().filter((e) => e.content === "offline"),
      ).toHaveLength(1);
      expect(db.getEndpointState("alpha-buzz")!.stateReason).toBe(
        OWNER_SHUTDOWN,
      );
      await transport.stop();
      transports.splice(transports.indexOf(transport), 1);
      db.close();
    },
    { timeout: 30_000 },
  );

  test(
    "the endpoint stays down across a full restart",
    async () => {
      const relay = createRelay();
      const loaded = makeLoaded(relay.url, { drainMs: 500 });
      const db = openDb(loaded);
      const first = new BuzzTransport({
        db,
        normalized: loaded.normalized,
        endpoints: loaded.normalized.endpoints,
        lifecyclePollMs: 20,
      });
      transports.push(first);
      await first.start(async () => {});
      await waitFor(
        () => first.snapshots()[0]?.state === "healthy",
        "connected",
      );
      relay.emit(shutdownEvent());
      await waitFor(
        () => db.getEndpointState("alpha-buzz")?.lifecycleState === "disabled",
        "endpoint disabled",
      );
      await first.stop();
      transports.splice(transports.indexOf(first), 1);
      db.close();

      // Restart the whole process: reopen the database and re-sync the same
      // config, which is what startup does.
      const restarted = new GatewayDB(loaded.config.gateway.db_path!);
      restarted.syncNormalizedConfig(loaded.normalized);
      expect(restarted.getEndpointState("alpha-buzz")!.lifecycleState).toBe(
        "disabled",
      );

      const presenceBefore = relay.presence().length;
      const second = new BuzzTransport({
        db: restarted,
        normalized: loaded.normalized,
        endpoints: loaded.normalized.endpoints,
        lifecyclePollMs: 20,
      });
      transports.push(second);
      await second.start(async () => {});
      await Bun.sleep(500);
      expect(second.snapshots()[0]!.state).toBe("disabled");
      expect(second.snapshots()[0]!.connected).toBe(false);
      expect(relay.presence().length).toBe(presenceBefore);

      // An explicit operator resume is what brings it back.
      restarted.setEndpointLifecycle("alpha-buzz", "active", null);
      await waitFor(
        () => second.snapshots()[0]?.state === "healthy",
        "resumed after operator action",
      );
      restarted.close();
    },
    { timeout: 30_000 },
  );

  test(
    "an in-flight turn finishes before the endpoint disconnects",
    async () => {
      const relay = createRelay();
      const loaded = makeLoaded(relay.url, { drainMs: 10_000 });
      const db = openDb(loaded);
      let turnId: number | null = null;
      const transport = new BuzzTransport({
        db,
        normalized: loaded.normalized,
        endpoints: loaded.normalized.endpoints,
        lifecyclePollMs: 20,
        onAccepted: ({ inboundEventId }) => {
          turnId = db.enqueueRecordedBuzzTurn(
            inboundEventId,
            "alpha",
            "owner mention",
          );
          return "enqueued";
        },
      });
      transports.push(transport);
      await transport.start(async () => {});
      await waitFor(
        () => transport.snapshots()[0]?.state === "healthy",
        "connected",
      );

      // A real prompt first, moved to `running` so the drain has something to
      // wait for.
      relay.emit(
        finalizeEvent(
          {
            kind: BUZZ_KINDS.streamMessageV1,
            created_at: Math.floor(Date.now() / 1000),
            content: "hello there",
            tags: [
              ["h", CHANNEL],
              ["p", ENDPOINT_PUBKEY],
            ],
          },
          OWNER_SECRET,
        ),
      );
      await waitFor(() => turnId !== null, "turn queued");
      db.startTurn(turnId!, 4242);
      expect(db.endpointBacklog("alpha-buzz").running).toBe(1);

      relay.emit(shutdownEvent());
      await waitFor(
        () => db.getEndpointState("alpha-buzz")?.lifecycleState === "draining",
        "endpoint draining",
      );
      // Still draining, still connected: the drain is not a disconnect.
      expect(db.getEndpointState("alpha-buzz")!.lifecycleState).toBe(
        "draining",
      );
      expect(relay.presence().some((e) => e.content === "offline")).toBe(false);

      db.completeTurn(turnId!);
      await waitFor(
        () => db.getEndpointState("alpha-buzz")?.lifecycleState === "disabled",
        "endpoint disabled after the turn finished",
      );
      await waitFor(
        () => relay.presence().some((e) => e.content === "offline"),
        "offline presence after drain",
      );
      await transport.stop();
      transports.splice(transports.indexOf(transport), 1);
      db.close();
    },
    { timeout: 40_000 },
  );

  test(
    "a drain that overruns its budget still shuts the endpoint down",
    async () => {
      const relay = createRelay();
      const loaded = makeLoaded(relay.url, { drainMs: 300 });
      const db = openDb(loaded);
      let turnId: number | null = null;
      const transport = new BuzzTransport({
        db,
        normalized: loaded.normalized,
        endpoints: loaded.normalized.endpoints,
        lifecyclePollMs: 20,
        onAccepted: ({ inboundEventId }) => {
          turnId = db.enqueueRecordedBuzzTurn(
            inboundEventId,
            "alpha",
            "owner mention",
          );
          return "enqueued";
        },
      });
      transports.push(transport);
      await transport.start(async () => {});
      await waitFor(
        () => transport.snapshots()[0]?.state === "healthy",
        "connected",
      );
      relay.emit(
        finalizeEvent(
          {
            kind: BUZZ_KINDS.streamMessageV1,
            created_at: Math.floor(Date.now() / 1000),
            content: "a long one",
            tags: [
              ["h", CHANNEL],
              ["p", ENDPOINT_PUBKEY],
            ],
          },
          OWNER_SECRET,
        ),
      );
      await waitFor(() => turnId !== null, "turn queued");
      db.startTurn(turnId!, 4243);

      relay.emit(shutdownEvent());
      // The turn never finishes. I5 is "stay down", not "stay up until the
      // work is done", so the budget expires and the endpoint stops anyway.
      await waitFor(
        () => db.getEndpointState("alpha-buzz")?.lifecycleState === "disabled",
        "endpoint disabled after the drain budget expired",
      );
      expect(db.endpointBacklog("alpha-buzz").running).toBe(1);
      await transport.stop();
      transports.splice(transports.indexOf(transport), 1);
      db.close();
    },
    { timeout: 30_000 },
  );
});
