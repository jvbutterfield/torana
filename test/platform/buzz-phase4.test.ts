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
import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { runDoctor } from "../../src/doctor.js";
import { Metrics } from "../../src/metrics.js";
import { OutboxProcessor } from "../../src/outbox.js";
import {
  logger,
  resetLoggerState,
  setLogFormat,
  setSecrets,
} from "../../src/log.js";
import { BuzzAdapter } from "../../src/platform/buzz/adapter.js";
import { BuzzTransport } from "../../src/platform/buzz/transport.js";
import {
  BUZZ_KINDS,
  createOwnerAuthTag,
  decodeSecret,
  ownerAuthTagAllowsEvent,
  publicKey,
  verifyOwnerAuthTag,
} from "../../src/platform/buzz/protocol.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const ENDPOINT_SECRET = decodeSecret("01".padStart(64, "0"));
const RELAY_SECRET = decodeSecret("02".padStart(64, "0"));
const OWNER_SECRET = decodeSecret("04".padStart(64, "0"));
const OUTSIDER_SECRET = decodeSecret("05".padStart(64, "0"));
const ENDPOINT_PUBKEY = publicKey(ENDPOINT_SECRET);
const OWNER_PUBKEY = publicKey(OWNER_SECRET);
const CHANNEL_A = "11111111-2222-4333-8444-555555555555";
const CHANNEL_B = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const AUTH_TAG = createOwnerAuthTag(OWNER_SECRET, ENDPOINT_PUBKEY, "kind=9");
const ENDPOINT_KEY = "01".padStart(64, "0");
const OUTSIDER_KEY = "05".padStart(64, "0");

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

function trackTransport(transport: BuzzTransport): BuzzTransport {
  transports.push(transport);
  return transport;
}

function signed(
  template: Parameters<typeof finalizeEvent>[0],
  secret = OWNER_SECRET,
): Event {
  return finalizeEvent(template, secret);
}

function mention(
  channelId: string,
  createdAt: number,
  secret = OWNER_SECRET,
): Event {
  return signed(
    {
      kind: BUZZ_KINDS.streamMessageV1,
      created_at: createdAt,
      content: `mention-${createdAt}`,
      tags: [
        ["h", channelId],
        ["p", ENDPOINT_PUBKEY],
      ],
    },
    secret,
  );
}

function makeLoaded(
  relayUrl: string,
  options: {
    authTag?: string;
    enabled?: boolean;
    privateKey?: string;
    historicalLimit?: number;
    invalidHeartbeat?: boolean;
    toolsEndpointId?: string;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "torana-buzz-p4-"));
  tempDirs.push(dir);
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
  upgraded.platforms.buzz = {
    enabled: options.enabled ?? true,
    reconnect: { base_ms: 100, cap_ms: 100 },
    subscription: {
      historical_limit: options.historicalLimit ?? 100,
      replay_overlap_secs: 5,
      heartbeat_secs: 5,
    },
    message_max_bytes: 65_536,
  };
  upgraded.limits.relay_ok_wait_ms = 1000;
  upgraded.limits.reconnect_alert_after_secs = 1;
  upgraded.agents[0].endpoints.push({
    id: "alpha-buzz",
    platform: "buzz",
    enabled: true,
    community_id: "primary",
    relay_url: relayUrl,
    private_key: options.privateKey ?? ENDPOINT_KEY,
    ...(options.authTag ? { auth_tag: options.authTag } : {}),
    respond_to: "owner_only",
    owner_pubkey: OWNER_PUBKEY,
    allowed_pubkeys: [],
    subscribe: "mentions_and_dms",
    ...(options.invalidHeartbeat
      ? { triggers: { heartbeat: { enabled: true } } }
      : {}),
    channel_overrides: {},
  });
  upgraded.agents[0].tools = {
    buzz: {
      policy: "collaborate",
      default_endpoint_id: options.toolsEndpointId ?? "alpha-buzz",
      allowed_endpoint_ids: [options.toolsEndpointId ?? "alpha-buzz"],
      expose_private_key_to_runner: false,
      acknowledge_dangerous: false,
    },
  };
  return loadConfigFromString(yaml.dump(upgraded), {
    skipInterpolation: true,
  });
}

function openDb(loaded: ReturnType<typeof makeLoaded>): GatewayDB {
  applyMigrations(loaded.config.gateway.db_path!);
  const db = new GatewayDB(loaded.config.gateway.db_path!);
  db.syncNormalizedConfig(loaded.normalized);
  return db;
}

interface SocketData {
  authenticated: boolean;
  subscriptions: Map<string, Filter[]>;
}

function createFakeRelay(options: { requireOwnerAuth?: boolean } = {}) {
  const challenge = "phase4-fixed-challenge";
  const memberships = new Set([CHANNEL_A]);
  const messages: Event[] = [];
  const membershipEvents: Event[] = [];
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>();

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
          const ownerOk = ownerTag
            ? verifyOwnerAuthTag(ownerTag as typeof AUTH_TAG, auth.pubkey)
            : false;
          const ok =
            verifyEvent(auth) &&
            auth.pubkey === ENDPOINT_PUBKEY &&
            auth.tags.some(
              (tag) =>
                tag[0] === "relay" &&
                tag[1] === `ws://127.0.0.1:${server.port}`,
            ) &&
            auth.tags.some(
              (tag) => tag[0] === "challenge" && tag[1] === challenge,
            ) &&
            (!options.requireOwnerAuth || ownerOk);
          socket.data.authenticated = ok;
          socket.send(
            JSON.stringify([
              "OK",
              auth.id,
              ok,
              ok ? "authenticated" : "auth-required",
            ]),
          );
          return;
        }
        if (!socket.data.authenticated) return;
        if (frame[0] === "EVENT") {
          const event = frame[1] as Event;
          const ok = verifyEvent(event) && event.pubkey === ENDPOINT_PUBKEY;
          const duplicate = messages.some((item) => item.id === event.id);
          if (ok && !duplicate) messages.push(event);
          socket.send(
            JSON.stringify([
              "OK",
              event.id,
              ok,
              ok ? (duplicate ? "duplicate" : "saved") : "invalid",
            ]),
          );
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
        const discovery = [...memberships].map((channelId, index) =>
          signed(
            {
              kind: BUZZ_KINDS.groupMembers,
              created_at: 1_700_000_000 + index,
              content: "",
              tags: [
                ["d", channelId],
                ["p", ENDPOINT_PUBKEY],
              ],
            },
            RELAY_SECRET,
          ),
        );
        const metadata = [...memberships].map((channelId, index) =>
          signed(
            {
              kind: BUZZ_KINDS.groupMetadata,
              created_at: 1_700_000_100 + index,
              content: "",
              tags: [
                ["d", channelId],
                ["name", "Jason"],
                ["t", "dm"],
              ],
            },
            RELAY_SECRET,
          ),
        );
        for (const event of [
          ...discovery,
          ...metadata,
          ...membershipEvents,
          ...messages,
        ]) {
          if (filters.some((filter) => matches(event, filter))) {
            socket.send(JSON.stringify(["EVENT", id, event]));
          }
        }
        socket.send(JSON.stringify(["EOSE", id]));
      },
    },
  });
  servers.push(server);

  function emit(event: Event): void {
    if (
      event.kind === BUZZ_KINDS.memberAdded ||
      event.kind === BUZZ_KINDS.memberRemoved
    ) {
      membershipEvents.push(event);
    } else {
      messages.push(event);
    }
    for (const socket of sockets) {
      if (!socket.data.authenticated) continue;
      for (const [id, filters] of socket.data.subscriptions) {
        if (filters.some((filter) => matches(event, filter))) {
          socket.send(JSON.stringify(["EVENT", id, event]));
        }
      }
    }
  }

  function addMembership(channelId: string): void {
    memberships.add(channelId);
    emit(
      signed(
        {
          kind: BUZZ_KINDS.memberAdded,
          created_at: Math.floor(Date.now() / 1000),
          content: "",
          tags: [
            ["h", channelId],
            ["p", ENDPOINT_PUBKEY],
          ],
        },
        RELAY_SECRET,
      ),
    );
  }

  function removeMembership(channelId: string): void {
    memberships.delete(channelId);
    emit(
      signed(
        {
          kind: BUZZ_KINDS.memberRemoved,
          created_at: Math.floor(Date.now() / 1000) + 1,
          content: "",
          tags: [
            ["h", channelId],
            ["p", ENDPOINT_PUBKEY],
          ],
        },
        RELAY_SECRET,
      ),
    );
  }

  return {
    server,
    url: `ws://127.0.0.1:${server.port}`,
    emit,
    addMembership,
    removeMembership,
    messages,
  };
}

function matches(event: Event, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since)
    return false;
  if (filter.until !== undefined && event.created_at > filter.until)
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
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out: ${message}`);
}

describe("Phase 4 Buzz config and policy", () => {
  test("validates keys, owner policy, auth tag, and master kill switch", () => {
    const relay = createFakeRelay();
    const loaded = makeLoaded(relay.url, {
      authTag: JSON.stringify(AUTH_TAG),
      enabled: false,
    });
    const endpoint = loaded.normalized.endpoints.find(
      (item) => item.id === "alpha-buzz",
    )!;
    expect(endpoint.enabled).toBe(false);
    expect(endpoint.externalIdentity).toBe(ENDPOINT_PUBKEY);
    expect(loaded.secrets).toContain(ENDPOINT_KEY);
    expect(loaded.secrets).toContain(JSON.stringify(AUTH_TAG));

    const raw = yaml.load(
      yaml.dump(upgradeV1Object(makeTestConfig([makeTestBotConfig("alpha")]))),
    ) as any;
    raw.platforms.buzz.enabled = true;
    raw.agents[0].endpoints.push({
      id: "alpha-buzz",
      platform: "buzz",
      enabled: true,
      community_id: "primary",
      relay_url: relay.url,
      private_key: "bad-key",
      respond_to: "owner_only",
    });
    expect(() =>
      loadConfigFromString(yaml.dump(raw), { skipInterpolation: true }),
    ).toThrow(/private key|owner_only/);

    const wrongAuthTag = createOwnerAuthTag(
      OWNER_SECRET,
      publicKey(OUTSIDER_SECRET),
      "kind=9",
    );
    expect(() =>
      makeLoaded(relay.url, { authTag: JSON.stringify(wrongAuthTag) }),
    ).toThrow(/auth tag signature does not authorize/);
    expect(() => makeLoaded(relay.url, { invalidHeartbeat: true })).toThrow(
      /enabled heartbeat trigger requires/,
    );
    expect(() =>
      makeLoaded(relay.url, { toolsEndpointId: "other-buzz" }),
    ).toThrow(/not owned by agent/);
  });

  test("redacts the private key and raw owner auth tag from structured logs", () => {
    const relay = createFakeRelay();
    const loaded = makeLoaded(relay.url, { authTag: JSON.stringify(AUTH_TAG) });
    const lines: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (...values: unknown[]) => {
        lines.push(values.join(" "));
      };
      setLogFormat("json");
      setSecrets(loaded.secrets);
      logger("test.buzz").warn("redaction probe", {
        private_key: ENDPOINT_KEY,
        auth_tag: JSON.stringify(AUTH_TAG),
      });
    } finally {
      console.log = originalLog;
    }
    const output = lines.join("\n");
    expect(output).not.toContain(ENDPOINT_KEY);
    expect(output).not.toContain(JSON.stringify(AUTH_TAG));
    expect(output).toContain("<redacted>");
  });

  test("doctor reports lock, identity, auth, owner, discovery, and publish policy", async () => {
    const relay = createFakeRelay();
    const loaded = makeLoaded(relay.url, { authTag: JSON.stringify(AUTH_TAG) });
    const db = openDb(loaded);
    const result = await runDoctor({
      config: loaded.config,
      normalized: loaded.normalized,
      sourceConfigVersion: 2,
      configPath: join(loaded.config.gateway.data_dir, "torana.yaml"),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 1,
              is_bot: true,
              first_name: "Alpha",
              username: "alpha_bot",
            },
          }),
          { headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
      buzzProbe: async () => ({
        channels: [CHANNEL_A],
        authenticated: true as const,
      }),
      buzzCliProbe: () => ({
        path: "/test/buzz",
        sha256: loaded.normalized.buzzPlatform!.cli_sha256,
      }),
    });
    const phase4 = Object.fromEntries(
      result.checks
        .filter((check) => /^C0(1[6-9]|2[0-4])$/.test(check.id))
        .map((check) => [check.id, check.status]),
    );
    expect(phase4).toMatchObject({
      C016: "ok",
      C017: "ok",
      C018: "ok",
      C019: "ok",
      C020: "ok",
      C021: "ok",
      C023: "ok",
      C024: "ok",
    });
    db.close();
  });

  test("fails closed for unauthorized authors and missing mentions", () => {
    const relay = createFakeRelay();
    const loaded = makeLoaded(relay.url);
    const endpoint = loaded.normalized.endpoints.find(
      (item) => item.id === "alpha-buzz",
    )!;
    const adapter = new BuzzAdapter(endpoint);
    const channels = new Set([CHANNEL_A]);
    expect(adapter.evaluateInbound(mention(CHANNEL_A, 10), channels).kind).toBe(
      "accepted",
    );
    expect(
      adapter.evaluateInbound(
        mention(CHANNEL_A, 11, OUTSIDER_SECRET),
        channels,
      ),
    ).toMatchObject({ kind: "rejected", reason: "unauthorized_author" });
    const missingMention = signed({
      kind: 9,
      created_at: 12,
      content: "no mention",
      tags: [["h", CHANNEL_A]],
    });
    expect(adapter.evaluateInbound(missingMention, channels)).toMatchObject({
      kind: "rejected",
      reason: "mention_required",
    });
    expect(
      adapter.evaluateInbound(
        {
          ...JSON.parse(JSON.stringify(missingMention)),
          sig: "0".repeat(128),
        },
        channels,
      ),
    ).toMatchObject({ kind: "malformed" });
  });
});

describe("Phase 4 Buzz relay integration", () => {
  test("publishes a transport-owned threaded reply for an authenticated owner DM", async () => {
    const relay = createFakeRelay();
    const inbound = mention(CHANNEL_A, 1_700_000_050);
    relay.emit(inbound);
    const loaded = makeLoaded(relay.url);
    const db = openDb(loaded);
    const endpoint = loaded.normalized.endpoints.find(
      (item) => item.id === "alpha-buzz",
    )!;
    const adapter = new BuzzAdapter(endpoint);
    const adapters = new Map([["alpha-buzz", adapter]]);
    const outbox = new OutboxProcessor(
      loaded.config,
      db,
      adapters,
      new Metrics(loaded.config),
      null,
      { normalized: loaded.normalized },
    );
    let turnId: number | null = null;
    const transport = trackTransport(
      new BuzzTransport({
        db,
        normalized: loaded.normalized,
        endpoints: loaded.normalized.endpoints,
        adapters,
        lifecyclePollMs: 10,
        onAccepted: ({ inboundEventId }) => {
          turnId = db.enqueueRecordedBuzzTurn(
            inboundEventId,
            "alpha",
            "owner DM",
          );
          if (turnId === null) return;
          outbox.queueFinalResponse(turnId, "authenticated DM reply");
          return "enqueued";
        },
      }),
    );
    await transport.start(async () => {});
    await waitFor(
      () =>
        transport.snapshots()[0]?.state === "healthy" &&
        turnId !== null &&
        adapter.channelMetadata(CHANNEL_A)?.type === "dm",
      "owner DM queued",
    );
    await outbox.drain(1_000);
    await waitFor(
      () =>
        relay.messages.some(
          (event) => event.content === "authenticated DM reply",
        ),
      "threaded reply published",
    );
    const reply = relay.messages.find(
      (event) => event.content === "authenticated DM reply",
    )!;
    expect(verifyEvent(reply)).toBe(true);
    expect(reply.content).toBe("authenticated DM reply");
    expect(reply.tags).toContainEqual(["h", CHANNEL_A]);
    expect(reply.tags).toContainEqual(["e", inbound.id, "", "reply"]);
    expect(reply.tags).toContainEqual(["p", OWNER_PUBKEY]);
    expect(db.getOutboxRow(1)?.status).toBe("sent");
    await transport.stop();
    db.close();
  });

  test("authenticates, discovers, persists a composite cursor, and deduplicates restart replay", async () => {
    const relay = createFakeRelay();
    const firstMention = mention(CHANNEL_A, 1_700_000_100);
    relay.emit(firstMention);
    const loaded = makeLoaded(relay.url);
    const db = openDb(loaded);
    let dispatches = 0;
    const startTransport = () =>
      trackTransport(
        new BuzzTransport({
          db,
          normalized: loaded.normalized,
          endpoints: loaded.normalized.endpoints,
          lifecyclePollMs: 10,
          random: () => 0.5,
          onAccepted: () => {
            dispatches += 1;
          },
        }),
      );
    const first = startTransport();
    await first.start(async () => {});
    await waitFor(
      () => first.snapshots()[0]?.state === "healthy" && dispatches === 1,
      "initial mention dispatch",
    );
    const cursor = db.getEndpointState("alpha-buzz")!.cursor;
    expect(cursor.channels).toEqual([CHANNEL_A]);
    expect(cursor.subscriptions[`channel:${CHANNEL_A}:messages`]).toEqual({
      created_at: firstMention.created_at,
      event_id: firstMention.id,
    });
    await first.stop();

    const second = startTransport();
    await second.start(async () => {});
    await waitFor(
      () => second.snapshots()[0]?.state === "healthy",
      "restart connection",
    );
    await Bun.sleep(50);
    expect(dispatches).toBe(1);
    expect(
      db
        ._unsafeQuery(
          "SELECT COUNT(*) AS count FROM inbound_events WHERE endpoint_id='alpha-buzz'",
        )
        .get(),
    ).toEqual({ count: 1 });
    await second.stop();
    db.close();
  });

  test("cursor-checkpoints audit-suppressed self events without enqueueing them", async () => {
    const relay = createFakeRelay();
    const selfEvent = mention(CHANNEL_A, 1_700_000_150, ENDPOINT_SECRET);
    relay.emit(selfEvent);
    const loaded = makeLoaded(relay.url);
    const db = openDb(loaded);
    let dispatches = 0;
    const transport = trackTransport(
      new BuzzTransport({
        db,
        normalized: loaded.normalized,
        endpoints: loaded.normalized.endpoints,
        lifecyclePollMs: 10,
        onAccepted: () => {
          dispatches += 1;
        },
      }),
    );
    await transport.start(async () => {});
    await waitFor(
      () => transport.snapshots()[0]?.state === "healthy",
      "self-event checkpoint",
    );
    expect(dispatches).toBe(0);
    expect(db.getInboundEventStatus("alpha-buzz", selfEvent.id)).toBeNull();
    expect(
      db.getEndpointState("alpha-buzz")?.cursor.subscriptions[
        `channel:${CHANNEL_A}:messages`
      ],
    ).toEqual({
      created_at: selfEvent.created_at,
      event_id: selfEvent.id,
    });
    await transport.stop();
    db.close();
  });

  test("recovers a durably received pre-dispatch event exactly once", async () => {
    const relay = createFakeRelay();
    const loaded = makeLoaded(relay.url);
    const db = openDb(loaded);
    const endpoint = loaded.normalized.endpoints.find(
      (item) => item.id === "alpha-buzz",
    )!;
    const adapter = new BuzzAdapter(endpoint);
    const raw = mention(CHANNEL_A, 1_700_000_200);
    const decision = adapter.evaluateInbound(raw, new Set([CHANNEL_A]));
    if (decision.kind !== "accepted")
      throw new Error("fixture was not accepted");
    db.recordBuzzInbound({
      event: decision.event,
      status: "received",
      cursorScope: decision.cursorScope,
    });

    let dispatches = 0;
    const transport = trackTransport(
      new BuzzTransport({
        db,
        normalized: loaded.normalized,
        endpoints: loaded.normalized.endpoints,
        lifecyclePollMs: 10,
        onAccepted: () => {
          dispatches += 1;
        },
      }),
    );
    await transport.start(async () => {});
    await waitFor(() => dispatches === 1, "recovered dispatch");
    expect(db.getInboundEventStatus("alpha-buzz", raw.id)?.status).toBe(
      "processed",
    );
    await transport.stop();

    const again = trackTransport(
      new BuzzTransport({
        db,
        normalized: loaded.normalized,
        endpoints: loaded.normalized.endpoints,
        lifecyclePollMs: 10,
        onAccepted: () => {
          dispatches += 1;
        },
      }),
    );
    await again.start(async () => {});
    await waitFor(() => again.snapshots()[0]?.state === "healthy", "restart");
    await Bun.sleep(30);
    expect(dispatches).toBe(1);
    await again.stop();
    db.close();
  });

  test("marks a post-dispatch restart as interrupted without executing it again", async () => {
    const relay = createFakeRelay();
    const loaded = makeLoaded(relay.url);
    const db = openDb(loaded);
    const endpoint = loaded.normalized.endpoints.find(
      (item) => item.id === "alpha-buzz",
    )!;
    const raw = mention(CHANNEL_A, 1_700_000_250);
    const decision = new BuzzAdapter(endpoint).evaluateInbound(
      raw,
      new Set([CHANNEL_A]),
    );
    if (decision.kind !== "accepted")
      throw new Error("fixture was not accepted");
    const recorded = db.recordBuzzInbound({
      event: decision.event,
      status: "received",
      cursorScope: decision.cursorScope,
    });
    if (recorded.kind !== "inserted") throw new Error("fixture was duplicated");
    expect(
      db.transitionInboundEvent(recorded.id, "received", "dispatched"),
    ).toBe(true);

    let dispatches = 0;
    const transport = trackTransport(
      new BuzzTransport({
        db,
        normalized: loaded.normalized,
        endpoints: loaded.normalized.endpoints,
        lifecyclePollMs: 10,
        onAccepted: () => {
          dispatches += 1;
        },
      }),
    );
    await transport.start(async () => {});
    await waitFor(
      () => transport.snapshots()[0]?.state === "healthy",
      "post-dispatch recovery",
    );
    expect(dispatches).toBe(0);
    expect(db.getInboundEventStatus("alpha-buzz", raw.id)?.status).toBe(
      "interrupted",
    );
    await transport.stop();
    db.close();
  });

  test("adds and removes channel subscriptions live, then draining stops intake", async () => {
    const relay = createFakeRelay();
    const loaded = makeLoaded(relay.url);
    const db = openDb(loaded);
    const seen: string[] = [];
    const transport = trackTransport(
      new BuzzTransport({
        db,
        normalized: loaded.normalized,
        endpoints: loaded.normalized.endpoints,
        lifecyclePollMs: 10,
        onAccepted: ({ event }) => {
          seen.push(event.id);
        },
      }),
    );
    await transport.start(async () => {});
    await waitFor(
      () => transport.snapshots()[0]?.state === "healthy",
      "healthy",
    );

    relay.addMembership(CHANNEL_B);
    await waitFor(
      () => transport.snapshots()[0]?.channels === 2,
      "new membership subscription",
    );
    const inB = mention(CHANNEL_B, Math.floor(Date.now() / 1000) + 2);
    relay.emit(inB);
    await waitFor(() => seen.includes(inB.id), "message from added channel");

    relay.removeMembership(CHANNEL_B);
    await waitFor(
      () => transport.snapshots()[0]?.channels === 1,
      "removed membership unsubscribe",
    );
    const afterRemoval = mention(CHANNEL_B, Math.floor(Date.now() / 1000) + 4);
    relay.emit(afterRemoval);
    await Bun.sleep(50);
    expect(seen).not.toContain(afterRemoval.id);

    db.setEndpointLifecycle("alpha-buzz", "draining", "test drain");
    await waitFor(
      () => transport.snapshots()[0]?.state === "draining",
      "draining state",
    );
    const afterDrain = mention(CHANNEL_A, Math.floor(Date.now() / 1000) + 5);
    relay.emit(afterDrain);
    await Bun.sleep(30);
    expect(seen).not.toContain(afterDrain.id);
    await transport.stop();
    db.close();
  });

  test("closed relay accepts the verified owner tag and wrong auth fails closed", async () => {
    const relay = createFakeRelay({ requireOwnerAuth: true });
    const loaded = makeLoaded(relay.url, { authTag: JSON.stringify(AUTH_TAG) });
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
      "closed relay auth",
    );
    await transport.stop();
    db.close();

    const rejected = makeLoaded(relay.url);
    const rejectedDb = openDb(rejected);
    const wrong = trackTransport(
      new BuzzTransport({
        db: rejectedDb,
        normalized: rejected.normalized,
        endpoints: rejected.normalized.endpoints,
        lifecyclePollMs: 10,
        random: () => 0.5,
      }),
    );
    await wrong.start(async () => {});
    await waitFor(
      () => wrong.snapshots()[0]?.state === "unhealthy",
      "wrong auth rejection",
    );
    expect(wrong.snapshots()[0]?.lastError).toContain("auth-required");
    await wrong.stop();
    rejectedDb.close();

    const outsiderAuthTag = createOwnerAuthTag(
      OWNER_SECRET,
      publicKey(OUTSIDER_SECRET),
      "kind=9",
    );
    const wrongKeyLoaded = makeLoaded(relay.url, {
      privateKey: OUTSIDER_KEY,
      authTag: JSON.stringify(outsiderAuthTag),
    });
    const wrongKeyDb = openDb(wrongKeyLoaded);
    const wrongKey = trackTransport(
      new BuzzTransport({
        db: wrongKeyDb,
        normalized: wrongKeyLoaded.normalized,
        endpoints: wrongKeyLoaded.normalized.endpoints,
        lifecyclePollMs: 10,
        random: () => 0.5,
      }),
    );
    await wrongKey.start(async () => {});
    await waitFor(
      () => wrongKey.snapshots()[0]?.state === "unhealthy",
      "wrong key rejection",
    );
    expect(wrongKey.snapshots()[0]?.lastError).toContain("auth-required");
    await wrongKey.stop();
    wrongKeyDb.close();
  });

  test("fails replay closed when a historical page cannot prove it drained", async () => {
    const relay = createFakeRelay();
    const raw = mention(CHANNEL_A, 1_700_000_300);
    relay.emit(raw);
    const loaded = makeLoaded(relay.url, { historicalLimit: 1 });
    const db = openDb(loaded);
    const transport = trackTransport(
      new BuzzTransport({
        db,
        normalized: loaded.normalized,
        endpoints: loaded.normalized.endpoints,
        lifecyclePollMs: 10,
        random: () => 0.5,
      }),
    );
    await transport.start(async () => {});
    await waitFor(
      () => transport.snapshots()[0]?.state === "unhealthy",
      "replay gap health transition",
    );
    expect(transport.snapshots()[0]?.lastError).toContain("replay_gap");
    expect(
      db.getEndpointState("alpha-buzz")?.cursor.subscriptions[
        `channel:${CHANNEL_A}:messages`
      ],
    ).toBeUndefined();
    expect(db.getInboundEventStatus("alpha-buzz", raw.id)).toBeNull();
    await transport.stop();
    db.close();
  });

  test("draining continues outbox delivery eligibility while disabled does not", () => {
    const relay = createFakeRelay();
    const loaded = makeLoaded(relay.url);
    const db = openDb(loaded);
    const id = db.insertOutboundOperation({
      turnId: null,
      agentId: "alpha",
      conversation: {
        platform: "buzz",
        communityId: "primary",
        endpointId: "alpha-buzz",
        channelId: CHANNEL_A,
        threadRootId: null,
        workflowRunId: null,
        type: "stream",
      },
      operation: { kind: "send", text: "pending", files: [] },
    });
    expect(db.getPendingOutbox().map((row) => row.id)).toContain(id);
    const operator = new GatewayDB(loaded.config.gateway.db_path!);
    operator.setEndpointLifecycle("alpha-buzz", "draining", "test");
    expect(db.getPendingOutbox().map((row) => row.id)).toContain(id);
    operator.setEndpointLifecycle("alpha-buzz", "disabled", "test");
    expect(db.getPendingOutbox().map((row) => row.id)).not.toContain(id);
    operator.setEndpointLifecycle("alpha-buzz", "active", null);
    expect(db.getPendingOutbox().map((row) => row.id)).toContain(id);
    operator.close();
    db.close();
  });
});

test("owner auth fixture authorizes kind 9 but not mutation kinds", () => {
  expect(ownerAuthTagAllowsEvent(AUTH_TAG, { kind: 9, created_at: 1 })).toBe(
    true,
  );
  expect(
    ownerAuthTagAllowsEvent(AUTH_TAG, { kind: 40003, created_at: 1 }),
  ).toBe(false);
});
