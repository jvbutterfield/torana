import { afterEach, describe, expect, test } from "bun:test";
import {
  finalizeEvent,
  verifyEvent,
  type Event,
  type Filter,
} from "nostr-tools";
import { BuzzSpikeClient, proveReconnectAndDedup } from "./relay-client";
import {
  BUZZ_KINDS,
  EventDeduper,
  buildAuthEvent,
  buildThreadedReply,
  channelFilter,
  createOwnerAuthTag,
  decodeSecret,
  membershipFilter,
  ownerAuthTagAllowsEvent,
  parseOwnerAuthTag,
  publicKey,
  type OwnerAuthTag,
  verifyOwnerAuthTag,
} from "./protocol";

const AGENT_SECRET = decodeSecret("01".padStart(64, "0"));
const RELAY_SECRET = decodeSecret("02".padStart(64, "0"));
const OWNER_SECRET = decodeSecret("04".padStart(64, "0"));
const CHANNEL_ID = "11111111-2222-4333-8444-555555555555";
const RELAY_PUBKEY = publicKey(RELAY_SECRET);
const AGENT_PUBKEY = publicKey(AGENT_SECRET);
const OWNER_AUTH_TAG = createOwnerAuthTag(OWNER_SECRET, AGENT_PUBKEY, "kind=9");
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function signed(
  template: Parameters<typeof finalizeEvent>[0],
  secret = RELAY_SECRET,
): Event {
  return finalizeEvent(template, secret);
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
    )
      return false;
  }
  return true;
}

function fakeRelay(options: { requireOwnerAuthTag: boolean }) {
  const challenge = "phase0-fixed-challenge";
  const accepted = new Set<string>();
  const membership = signed({
    kind: BUZZ_KINDS.groupMembers,
    created_at: 1_700_000_000,
    content: "",
    tags: [
      ["d", CHANNEL_ID],
      ["p", AGENT_PUBKEY],
    ],
  });
  const mention = signed({
    kind: BUZZ_KINDS.streamMessageV1,
    created_at: 1_700_000_100,
    content: "@agent phase zero",
    tags: [
      ["h", CHANNEL_ID],
      ["p", AGENT_PUBKEY],
    ],
  });

  const server = Bun.serve<{ authenticated: boolean }>({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: { authenticated: false } }))
        return undefined;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify(["AUTH", challenge]));
      },
      message(socket, raw) {
        const frame = JSON.parse(String(raw)) as [string, ...unknown[]];
        if (frame[0] === "AUTH") {
          const auth = frame[1] as Event;
          const relayBound = auth.tags.some(
            (tag) =>
              tag[0] === "relay" && tag[1] === `ws://127.0.0.1:${server.port}`,
          );
          const challengeBound = auth.tags.some(
            (tag) => tag[0] === "challenge" && tag[1] === challenge,
          );
          const ownerTag = auth.tags.find((tag) => tag[0] === "auth");
          const ownerBound = ownerTag
            ? verifyOwnerAuthTag(ownerTag as typeof OWNER_AUTH_TAG, auth.pubkey)
            : false;
          const ok =
            verifyEvent(auth) &&
            relayBound &&
            challengeBound &&
            (!options.requireOwnerAuthTag || ownerBound);
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
        if (!socket.data.authenticated) {
          socket.send(JSON.stringify(["NOTICE", "auth-required"]));
          return;
        }
        if (frame[0] === "REQ") {
          const subscriptionId = frame[1] as string;
          const filters = frame.slice(2) as Filter[];
          for (const event of [membership, mention]) {
            if (filters.some((filter) => matches(event, filter)))
              socket.send(JSON.stringify(["EVENT", subscriptionId, event]));
          }
          socket.send(JSON.stringify(["EOSE", subscriptionId]));
          return;
        }
        if (frame[0] === "EVENT") {
          const event = frame[1] as Event;
          const isDuplicate = accepted.has(event.id);
          const authTag = event.tags.find((tag) => tag[0] === "auth");
          const ownerAuthorized = authTag
            ? verifyOwnerAuthTag(
                authTag as typeof OWNER_AUTH_TAG,
                event.pubkey,
              ) &&
              ownerAuthTagAllowsEvent(authTag as typeof OWNER_AUTH_TAG, event)
            : false;
          const ok =
            verifyEvent(event) &&
            (!options.requireOwnerAuthTag || ownerAuthorized);
          if (ok) accepted.add(event.id);
          socket.send(
            JSON.stringify([
              "OK",
              event.id,
              ok,
              isDuplicate ? "duplicate: already accepted" : "stored",
            ]),
          );
        }
      },
    },
  });
  servers.push(server);
  return { url: `ws://127.0.0.1:${server.port}`, membership, mention };
}

describe("Buzz signing and filters", () => {
  test("signs NIP-42 auth bound to relay and challenge, with optional owner auth", () => {
    const event = buildAuthEvent({
      relayUrl: "wss://relay.example.test",
      challenge: "challenge-1",
      secret: AGENT_SECRET,
      ownerAuthTag: OWNER_AUTH_TAG,
      createdAt: 1_700_000_000,
    });
    expect(event.kind).toBe(22242);
    expect(event.pubkey).toBe(AGENT_PUBKEY);
    expect(event.tags).toContainEqual(["relay", "wss://relay.example.test"]);
    expect(event.tags).toContainEqual(["challenge", "challenge-1"]);
    expect(event.tags).toContainEqual(OWNER_AUTH_TAG);
    expect(verifyEvent(event)).toBe(true);
  });

  test("signs Buzz-compatible direct and nested threaded replies", () => {
    const direct = buildThreadedReply({
      channelId: CHANNEL_ID,
      content: "reply",
      replyTo: "c".repeat(64),
      mentionPubkey: "d".repeat(64),
      secret: AGENT_SECRET,
      createdAt: 1_700_000_001,
    });
    expect(direct.tags).toContainEqual(["h", CHANNEL_ID]);
    expect(direct.tags).toContainEqual(["e", "c".repeat(64), "", "reply"]);
    expect(direct.tags).toContainEqual(["p", "d".repeat(64)]);
    expect(verifyEvent(direct)).toBe(true);

    const nested = buildThreadedReply({
      channelId: CHANNEL_ID,
      content: "nested",
      rootId: "e".repeat(64),
      replyTo: "f".repeat(64),
      secret: AGENT_SECRET,
      createdAt: 1_700_000_002,
    });
    expect(nested.tags).toContainEqual(["e", "e".repeat(64), "", "root"]);
    expect(nested.tags).toContainEqual(["e", "f".repeat(64), "", "reply"]);
  });

  test("builds scoped message and membership filters", () => {
    expect(
      channelFilter({
        channelId: CHANNEL_ID,
        pubkey: AGENT_PUBKEY,
        kinds: [9],
        since: 10,
      }),
    ).toEqual({
      kinds: [9],
      "#h": [CHANNEL_ID],
      "#p": [AGENT_PUBKEY],
      since: 10,
    });
    expect(membershipFilter(AGENT_PUBKEY, 20)).toEqual({
      kinds: [44100, 44101],
      "#p": [AGENT_PUBKEY],
      since: 20,
    });
  });

  test("rejects malformed owner auth and duplicate events", () => {
    expect(() => parseOwnerAuthTag('["auth","BAD","kind=9","sig"]')).toThrow();
    const deduper = new EventDeduper();
    const event = signed({
      kind: 9,
      created_at: 1,
      content: "x",
      tags: [["h", CHANNEL_ID]],
    });
    expect(deduper.accept(event)).toBe(true);
    expect(deduper.accept(event)).toBe(false);
  });

  test("creates and verifies the upstream NIP-OA preimage and condition grammar", () => {
    expect(verifyOwnerAuthTag(OWNER_AUTH_TAG, AGENT_PUBKEY)).toBe(true);
    expect(parseOwnerAuthTag(JSON.stringify(OWNER_AUTH_TAG))).toEqual(
      OWNER_AUTH_TAG,
    );
    expect(() =>
      parseOwnerAuthTag(
        JSON.stringify([
          "auth",
          OWNER_AUTH_TAG[1],
          "kind=09",
          OWNER_AUTH_TAG[3],
        ]),
      ),
    ).toThrow();
    expect(
      verifyOwnerAuthTag(
        [
          ...OWNER_AUTH_TAG.slice(0, 3),
          "0".repeat(128),
        ] as typeof OWNER_AUTH_TAG,
        AGENT_PUBKEY,
      ),
    ).toBe(false);
    expect(
      ownerAuthTagAllowsEvent(OWNER_AUTH_TAG, { kind: 9, created_at: 1 }),
    ).toBe(true);
    expect(
      ownerAuthTagAllowsEvent(OWNER_AUTH_TAG, {
        kind: 40003,
        created_at: 1,
      }),
    ).toBe(false);
  });

  test("pins the Buzz capability kind registry", () => {
    expect(BUZZ_KINDS).toMatchObject({
      deletion: 5,
      reaction: 7,
      streamMessageV1: 9,
      fileMetadata: 1063,
      nativeDelete: 9005,
      presence: 20001,
      typing: 20002,
      auth: 22242,
      workflowDefinition: 30620,
      groupMetadata: 39000,
      groupMembers: 39002,
      streamMessageV2: 40002,
      streamEdit: 40003,
      streamDiff: 40008,
      canvas: 40100,
      memberAdded: 44100,
      memberRemoved: 44101,
      forumPost: 45001,
      forumVote: 45002,
      forumComment: 45003,
      workflowTrigger: 46020,
      approvalGrant: 46030,
      approvalDeny: 46031,
    });
  });

  test("verifies the pinned buzz-sdk NIP-OA golden vector", () => {
    const vector = [
      "auth",
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      "kind=1&created_at<1713957000",
      "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369",
    ] as OwnerAuthTag;
    const agent =
      "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    expect(verifyOwnerAuthTag(vector, agent)).toBe(true);
  });
});

describe("fake relay integration", () => {
  test("authenticates, discovers, receives, replies, and accepts exact replay on an open relay", async () => {
    const relay = fakeRelay({ requireOwnerAuthTag: false });
    const client = new BuzzSpikeClient(relay.url, AGENT_SECRET);
    await client.connect();
    expect(await client.discoverChannels()).toEqual([CHANNEL_ID]);
    const mention = await client.receiveMention(CHANNEL_ID);
    const reply = client.buildReply(CHANNEL_ID, mention, "phase zero reply");
    expect(await client.publish(reply)).toEqual({
      accepted: true,
      message: "stored",
    });
    expect(await client.publish(reply)).toEqual({
      accepted: true,
      message: "duplicate: already accepted",
    });
    client.close();
  });

  test("requires owner auth on a closed relay and deduplicates reconnect overlap", async () => {
    const relay = fakeRelay({ requireOwnerAuthTag: true });
    const rejected = new BuzzSpikeClient(relay.url, AGENT_SECRET);
    await expect(rejected.connect()).rejects.toThrow("auth-required");
    rejected.close();

    const result = await proveReconnectAndDedup({
      relayUrl: relay.url,
      secret: AGENT_SECRET,
      ownerAuthTag: OWNER_AUTH_TAG,
      channelId: CHANNEL_ID,
    });
    expect(result.first.id).toBe(relay.mention.id);
    expect(result.replay.id).toBe(relay.mention.id);
    expect(result.duplicateRejected).toBe(true);
  });
});
