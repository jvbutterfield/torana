/**
 * Phase 0 (US-029) fixture 2 — relay delivery semantics for managed-agent
 * tombstones.
 *
 * The Desktop-managed-agents plan puts a gateway-level `TombstoneWatcher` on
 * one connection per relay, subscribed `{kinds:[5], authors:[<owner pubkeys>]}`
 * and NIP-42-authenticated as *a provisioned agent key* — never as the owner.
 * That design only works if a Buzz relay will deliver an owner-signed `kind:5`
 * to a subscriber authenticated as a different key, both live and through a
 * `since` backfill. This probe answers exactly that, before any delete code
 * exists.
 *
 * The tombstone is built wire-identical to upstream `build_agent_delete`
 * (`desktop/src-tauri/src/managed_agents/agent_events.rs`, verified
 * byte-identical at `desktop-v0.5.8`): kind 5, empty content, exactly one `a`
 * tag `30177:<owner>:<agent>`, and no `e` tag. Identities are generated fresh
 * per run, so the coordinate names an agent that has never existed and the
 * probe cannot affect a real managed-agent record.
 *
 * Credentials. Buzz relays gate NIP-42 on relay membership, with a NIP-OA
 * fallback (`handlers/auth.rs` -> `enforce_relay_membership`), so freshly
 * generated keys are refused with `restricted: not a relay member`. Supply two
 * *distinct* identities that the relay will admit, using the same env-var
 * convention as the other hosted probes in this directory:
 *
 *   BUZZ_PRIVATE_KEY / BUZZ_AUTH_TAG              — publisher ("owner")
 *   BUZZ_WATCHER_PRIVATE_KEY / BUZZ_WATCHER_AUTH_TAG — subscriber
 *
 * The publisher signs the tombstone and the coordinate is built as
 * `30177:<publisher>:<synthetic agent>`, which is what the relay's a-tag
 * deletion check authorizes (`side_effects.rs` requires the actor to own the
 * coordinate). The synthetic agent pubkey is generated per run and has never
 * existed, so nothing real can be deleted. Without credentials the probe still
 * runs with generated keys and will report the membership refusal rather than
 * a false negative.
 *
 * Usage:
 *   bun run tombstone-delivery-probe.ts --relay wss://<host> [--out <path>]
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { Event, Filter } from "nostr-tools";
import { decodeSecret, parseOwnerAuthTag, type OwnerAuthTag } from "./protocol";

const KIND_MANAGED_AGENT = 30177;
const KIND_DELETE = 5;
const KIND_AUTH = 22242;

type Frame = [string, ...unknown[]];

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

/** A relay connection that keeps unmatched frames so nothing is dropped. */
class Conn {
  readonly #url: string;
  readonly #secret: Uint8Array;
  readonly #ownerAuthTag?: OwnerAuthTag;
  #socket?: WebSocket;
  #queue: Frame[] = [];
  #waiters: Array<(frame: Frame) => void> = [];

  constructor(url: string, secret: Uint8Array, ownerAuthTag?: OwnerAuthTag) {
    this.#url = url;
    this.#secret = secret;
    this.#ownerAuthTag = ownerAuthTag;
  }

  get pubkey(): string {
    return getPublicKey(this.#secret);
  }

  async connect(): Promise<void> {
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data)) as Frame;
      const waiter = this.#waiters.shift();
      if (waiter) waiter(frame);
      else this.#queue.push(frame);
    };
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () =>
        reject(new Error(`cannot connect to ${this.#url}`));
    });
  }

  /** NIP-42. Returns null when the relay never challenges (open relay). */
  async authenticate(timeoutMs = 4000): Promise<string | null> {
    let challenge: Frame;
    try {
      challenge = await this.next((f) => f[0] === "AUTH", timeoutMs);
    } catch {
      return null;
    }
    const tags: string[][] = [
      ["relay", this.#url],
      ["challenge", String(challenge[1])],
    ];
    if (this.#ownerAuthTag) tags.push([...this.#ownerAuthTag]);
    const auth = finalizeEvent(
      {
        kind: KIND_AUTH,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags,
      },
      this.#secret,
    );
    this.send(["AUTH", auth]);
    const ok = await this.next(
      (f) => f[0] === "OK" && f[1] === auth.id,
      timeoutMs,
    );
    if (ok[2] !== true) throw new Error(`NIP-42 rejected: ${String(ok[3])}`);
    return auth.id;
  }

  send(frame: Frame): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN)
      throw new Error("not connected");
    this.#socket.send(JSON.stringify(frame));
  }

  async publish(
    event: Event,
    timeoutMs = 8000,
  ): Promise<{ accepted: boolean; message: string }> {
    this.send(["EVENT", event]);
    const ok = await this.next(
      (f) => f[0] === "OK" && f[1] === event.id,
      timeoutMs,
    );
    return { accepted: ok[2] === true, message: String(ok[3] ?? "") };
  }

  /** Open a subscription and drain to EOSE, returning what was stored. */
  async querySync(
    id: string,
    filters: Filter[],
    timeoutMs = 8000,
  ): Promise<Event[]> {
    this.send(["REQ", id, ...filters]);
    const events: Event[] = [];
    while (true) {
      const frame = await this.next(
        (f) =>
          (f[0] === "EVENT" && f[1] === id) ||
          (f[0] === "EOSE" && f[1] === id) ||
          (f[0] === "CLOSED" && f[1] === id),
        timeoutMs,
      );
      if (frame[0] === "EOSE") return events;
      if (frame[0] === "CLOSED")
        throw new Error(`subscription closed: ${String(frame[2])}`);
      events.push(frame[2] as Event);
    }
  }

  /** Wait for a live EVENT on an already-open subscription. */
  async awaitLive(id: string, timeoutMs: number): Promise<Event | null> {
    try {
      const frame = await this.next(
        (f) => f[0] === "EVENT" && f[1] === id,
        timeoutMs,
      );
      return frame[2] as Event;
    } catch {
      return null;
    }
  }

  async next(
    predicate: (frame: Frame) => boolean,
    timeoutMs: number,
  ): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.#queue.findIndex(predicate);
      if (index >= 0) return this.#queue.splice(index, 1)[0];
      const frame = await Promise.race([
        new Promise<Frame>((resolve) => this.#waiters.push(resolve)),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), deadline - Date.now()),
        ),
      ]);
      if (!frame) break;
      if (predicate(frame)) return frame;
      this.#queue.push(frame);
    }
    throw new Error("timed out waiting for relay frame");
  }

  close(): void {
    this.#socket?.close();
    this.#socket = undefined;
  }
}

const relayUrl = arg("relay");
const outPath = arg("out", "");

// The publisher and the watcher must be two identities the relay will admit;
// the tombstoned agent is always synthetic so nothing real can be destroyed.
const ownerSecret = process.env.BUZZ_PRIVATE_KEY
  ? decodeSecret(process.env.BUZZ_PRIVATE_KEY)
  : generateSecretKey();
const ownerAuthTag = parseOwnerAuthTag(process.env.BUZZ_AUTH_TAG);
const memberSecret = process.env.BUZZ_WATCHER_PRIVATE_KEY
  ? decodeSecret(process.env.BUZZ_WATCHER_PRIVATE_KEY)
  : generateSecretKey();
const memberAuthTag = parseOwnerAuthTag(process.env.BUZZ_WATCHER_AUTH_TAG);
const agentSecret = generateSecretKey();
const ownerPubkey = getPublicKey(ownerSecret);
const agentPubkey = getPublicKey(agentSecret);
const memberPubkey = getPublicKey(memberSecret);
const coordinate = `${KIND_MANAGED_AGENT}:${ownerPubkey}:${agentPubkey}`;

if (ownerPubkey === memberPubkey) {
  throw new Error(
    "publisher and watcher must be different keys — the whole point is cross-author delivery",
  );
}

const findings: Record<string, unknown> = {
  probe: "managed-agent tombstone delivery",
  relayUrl,
  ranAt: new Date().toISOString(),
  identities: { ownerPubkey, agentPubkey, memberPubkey, coordinate },
  credentials: {
    publisherFromEnv: Boolean(process.env.BUZZ_PRIVATE_KEY),
    publisherAuthTag: Boolean(ownerAuthTag),
    watcherFromEnv: Boolean(process.env.BUZZ_WATCHER_PRIVATE_KEY),
    watcherAuthTag: Boolean(memberAuthTag),
  },
};

const owner = new Conn(relayUrl, ownerSecret, ownerAuthTag);
const watcher = new Conn(relayUrl, memberSecret, memberAuthTag);
const backfill = new Conn(relayUrl, memberSecret, memberAuthTag);

try {
  await owner.connect();
  const ownerAuth = await owner.authenticate();
  await watcher.connect();
  const watcherAuth = await watcher.authenticate();
  findings.auth = {
    relayChallenged: ownerAuth !== null,
    ownerAuthenticated: ownerAuth !== null,
    watcherAuthenticatedAsDifferentKey: watcherAuth !== null,
    note:
      ownerAuth === null
        ? "relay issued no AUTH challenge; NIP-42 not exercised"
        : "both connections completed NIP-42 with distinct keys",
  };

  // 1. Publish the kind:30177 managed-agent record the tombstone will target.
  //    Owner-signed, d-tag = agent pubkey — the coordinate's shape upstream.
  const record = finalizeEvent(
    {
      kind: KIND_MANAGED_AGENT,
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify({ name: "phase0-probe-agent", probe: true }),
      tags: [["d", agentPubkey]],
    },
    ownerSecret,
  );
  findings.recordPublish = await owner.publish(record);

  // 2. Watcher opens the live subscription BEFORE the tombstone is published —
  //    this is the watcher's steady state.
  const liveSubId = "probe-live";
  const preexisting = await watcher.querySync(liveSubId, [
    { kinds: [KIND_DELETE], authors: [ownerPubkey] } as Filter,
  ]);
  findings.liveSubscription = {
    openedBeforePublish: true,
    filter: { kinds: [KIND_DELETE], authors: [ownerPubkey] },
    storedEventsAtEose: preexisting.length,
  };

  // 3. Owner publishes the tombstone, wire-identical to build_agent_delete.
  const publishedAt = Math.floor(Date.now() / 1000);
  const tombstone = finalizeEvent(
    {
      kind: KIND_DELETE,
      created_at: publishedAt,
      content: "",
      tags: [["a", coordinate]],
    },
    ownerSecret,
  );
  findings.tombstone = {
    id: tombstone.id,
    kind: tombstone.kind,
    tags: tombstone.tags,
    hasSingleATag: tombstone.tags.filter((t) => t[0] === "a").length === 1,
    hasNoETag: !tombstone.tags.some((t) => t[0] === "e"),
  };
  findings.tombstonePublish = await owner.publish(tombstone);

  // 4. (a) Live delivery to the differently-authenticated watcher.
  const live = await watcher.awaitLive(liveSubId, 10_000);
  findings.liveDelivery = {
    delivered: live !== null,
    matchedId: live?.id === tombstone.id,
    event: live ? { id: live.id, kind: live.kind, tags: live.tags } : null,
  };

  // 5. (b) `since` backfill on a *fresh* connection — the watcher's
  //    startup/reconnect path, cursor minus the 300 s overlap.
  await backfill.connect();
  await backfill.authenticate();
  const backfilled = await backfill.querySync("probe-backfill", [
    {
      kinds: [KIND_DELETE],
      authors: [ownerPubkey],
      since: publishedAt - 300,
    } as Filter,
  ]);
  findings.backfill = {
    since: publishedAt - 300,
    returnedCount: backfilled.length,
    containsTombstone: backfilled.some((e) => e.id === tombstone.id),
    ids: backfilled.map((e) => e.id),
  };

  // 6. Bonus: did the coordinate delete actually remove the 30177 record?
  //    Informational — the watcher never relies on this.
  const afterDelete = await backfill.querySync("probe-record", [
    {
      kinds: [KIND_MANAGED_AGENT],
      authors: [ownerPubkey],
      "#d": [agentPubkey],
    } as Filter,
  ]);
  findings.recordAfterTombstone = {
    stillPresent: afterDelete.length > 0,
    count: afterDelete.length,
  };

  const liveOk = findings.liveDelivery as { delivered: boolean };
  const backfillOk = findings.backfill as { containsTombstone: boolean };
  findings.verdict =
    liveOk.delivered && backfillOk.containsTombstone
      ? "POSITIVE — the planned TombstoneWatcher design is viable as written"
      : "NEGATIVE — watcher design needs amendment before Phase 5";
} catch (error) {
  findings.error = error instanceof Error ? error.message : String(error);
  findings.verdict = "INCONCLUSIVE — probe failed to complete";
} finally {
  owner.close();
  watcher.close();
  backfill.close();
}

const rendered = JSON.stringify(findings, null, 2);
if (outPath) await Bun.write(outPath, `${rendered}\n`);
console.log(rendered);
