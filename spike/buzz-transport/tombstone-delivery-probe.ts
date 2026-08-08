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
 * Footprint on the supplied identities. The watcher publishes nothing at all —
 * it only authenticates and subscribes. The publisher writes exactly one event,
 * the `kind:5` itself, whose coordinate names the synthetic agent. Neither
 * identity has anything read, rotated, revoked, or removed, and no membership
 * changes. Passing `--publish-record` additionally creates a real `kind:30177`
 * managed-agent record under the publisher's identity and then deletes it,
 * which is the one action with a visible side effect — see the comment at the
 * publish site.
 *
 * Usage:
 *   bun run tombstone-delivery-probe.ts --relay wss://<host> [--out <path>]
 *                                       [--publish-record]
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
const publishRecord = process.argv.includes("--publish-record");
const readOnly = process.argv.includes("--read-only");

// The tombstoned agent is always synthetic, so nothing real can be destroyed.
const ownerSecret = process.env.BUZZ_PRIVATE_KEY
  ? decodeSecret(process.env.BUZZ_PRIVATE_KEY)
  : generateSecretKey();
const ownerAuthTag = parseOwnerAuthTag(process.env.BUZZ_AUTH_TAG);

/**
 * Single-identity mode.
 *
 * Two admitted identities give the complete answer. One still gives most of
 * it, split into two halves that compose:
 *
 *   a. the relay *accepts* a cross-author `{kinds:[5], authors:[other]}`
 *      subscription (the gate that could kill the watcher design); and
 *   b. an `a`-tag-only `kind:5` is accepted, stored, fanned out live, and
 *      returned by a `since` backfill.
 *
 * What one identity cannot show directly is (a) and (b) *together* — an event
 * authored by A arriving at a subscriber authenticated as B. The relay source
 * says nothing gates that: `event_visible_to_reader` withholds only
 * author-only, unshared-gated, and DM/metric kinds, and kind 5 is none of
 * them. So the join is source-backed rather than observed, and the verdict
 * says so instead of overclaiming.
 */
const singleIdentity =
  Boolean(process.env.BUZZ_PRIVATE_KEY) &&
  !process.env.BUZZ_WATCHER_PRIVATE_KEY;

const memberSecret = process.env.BUZZ_WATCHER_PRIVATE_KEY
  ? decodeSecret(process.env.BUZZ_WATCHER_PRIVATE_KEY)
  : singleIdentity
    ? ownerSecret
    : generateSecretKey();
const memberAuthTag = singleIdentity
  ? ownerAuthTag
  : parseOwnerAuthTag(process.env.BUZZ_WATCHER_AUTH_TAG);
const agentSecret = generateSecretKey();
const ownerPubkey = getPublicKey(ownerSecret);
const agentPubkey = getPublicKey(agentSecret);
const memberPubkey = getPublicKey(memberSecret);
const coordinate = `${KIND_MANAGED_AGENT}:${ownerPubkey}:${agentPubkey}`;

if (!singleIdentity && ownerPubkey === memberPubkey) {
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
    mode: singleIdentity ? "single-identity" : "two-identity",
  },
};

const owner = new Conn(relayUrl, ownerSecret, ownerAuthTag);
const watcher = new Conn(relayUrl, memberSecret, memberAuthTag);
const backfill = new Conn(relayUrl, memberSecret, memberAuthTag);

// `--read-only` answers the single question that could kill the watcher design
// — whether the relay will even *accept* a cross-author `kind:5` subscription —
// without publishing anything. `author_only_filters_authorized` closes a global
// subscription that targets exclusively author-only kinds with `authors` other
// than self; if kind 5 were in `AUTHOR_ONLY_KINDS` the watcher could never
// subscribe on another identity's behalf. An accepted filter (EOSE rather than
// CLOSED) rules that out. It does not prove an event traverses the wire, so it
// is strong-but-partial evidence — the full probe remains the complete answer.
if (readOnly) {
  // A pubkey belonging to nobody. Deliberately *not* `ownerPubkey`: in
  // single-identity mode the publisher and the subscriber are the same key, so
  // filtering on the owner would make this a self-author subscription and
  // prove nothing about the gate it exists to test.
  const strangerPubkey = getPublicKey(generateSecretKey());
  const result: Record<string, unknown> = {
    probe: "cross-author kind:5 subscription filter gate (read-only)",
    relayUrl,
    ranAt: new Date().toISOString(),
    filter: { kinds: [KIND_DELETE], authors: [strangerPubkey] },
    subscribedAs: memberPubkey,
    wroteAnything: false,
  };
  try {
    await watcher.connect();
    const authed = await watcher.authenticate();
    result.authenticated = authed !== null;
    const events = await watcher.querySync("probe-filter-gate", [
      { kinds: [KIND_DELETE], authors: [strangerPubkey] } as Filter,
    ]);
    result.filterAccepted = true;
    result.storedEventsReturned = events.length;
    result.verdict =
      "POSITIVE — the relay accepts a cross-author kind:5 subscription; the author-only gate does not block the watcher";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.error = message;
    result.filterAccepted = false;
    result.verdict = /restricted: author-only/i.test(message)
      ? "NEGATIVE — the relay refuses cross-author kind:5 subscriptions; the Q2 watcher design needs amendment"
      : `INCONCLUSIVE — did not reach the filter gate (${message})`;
  } finally {
    watcher.close();
  }
  const renderedReadOnly = JSON.stringify(result, null, 2);
  if (outPath) await Bun.write(outPath, `${renderedReadOnly}\n`);
  console.log(renderedReadOnly);
  process.exit(0);
}

try {
  await owner.connect();
  const ownerAuth = await owner.authenticate();
  await watcher.connect();
  const watcherAuth = await watcher.authenticate();
  findings.auth = {
    relayChallenged: ownerAuth !== null,
    ownerAuthenticated: ownerAuth !== null,
    watcherAuthenticatedAsDifferentKey: watcherAuth !== null,
    distinctKeys: ownerPubkey !== memberPubkey,
    note:
      ownerAuth === null
        ? "relay issued no AUTH challenge; NIP-42 not exercised"
        : singleIdentity
          ? "both connections completed NIP-42 as the SAME key (single-identity mode)"
          : "both connections completed NIP-42 with distinct keys",
  };

  // 0. The gate that could kill the design, checked on its own so a failure
  //    here is unambiguous: will the relay even accept a subscription for
  //    somebody else's kind:5? `author_only_filters_authorized` closes a
  //    global subscription that targets exclusively author-only kinds with
  //    `authors` other than self — so if kind 5 were in AUTHOR_ONLY_KINDS the
  //    watcher could never subscribe on an owner's behalf.
  const strangerPubkey = getPublicKey(generateSecretKey());
  try {
    const preexisting = await watcher.querySync("probe-cross-author", [
      { kinds: [KIND_DELETE], authors: [strangerPubkey] } as Filter,
    ]);
    findings.crossAuthorFilterGate = {
      accepted: true,
      subscribedAs: memberPubkey,
      authorsFilter: strangerPubkey,
      storedEventsReturned: preexisting.length,
      note: "the relay accepts a cross-author kind:5 subscription",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.crossAuthorFilterGate = {
      accepted: false,
      error: message,
      note: /restricted: author-only/i.test(message)
        ? "the relay refuses cross-author kind:5 subscriptions — the Q2 watcher design needs amendment"
        : "did not reach the filter gate",
    };
  }

  // 1. Optionally publish the kind:30177 managed-agent record the tombstone
  //    will target. Off by default: a kind:30177 under the publisher's identity
  //    is a *real* managed-agent record, and a Desktop connected to this relay
  //    could surface it as an agent until the tombstone lands. The relay does
  //    not require the target to exist — `validate_standard_deletion_event`
  //    only checks that the actor owns the coordinate, and a coordinate delete
  //    matching no live row is logged, not rejected — so the delivery question
  //    this probe exists to answer is unaffected either way. Enable it only to
  //    additionally observe whether the coordinate delete took effect.
  if (publishRecord) {
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
  } else {
    findings.recordPublish = {
      skipped: true,
      why: "pass --publish-record to also create and delete a real kind:30177 record",
    };
  }

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

  // 6. Bonus, only when a record was actually created: did the coordinate
  //    delete remove it? Informational — the watcher never relies on this.
  const afterDelete = publishRecord
    ? await backfill.querySync("probe-record", [
        {
          kinds: [KIND_MANAGED_AGENT],
          authors: [ownerPubkey],
          "#d": [agentPubkey],
        } as Filter,
      ])
    : [];
  findings.recordAfterTombstone = publishRecord
    ? { stillPresent: afterDelete.length > 0, count: afterDelete.length }
    : { skipped: true, why: "no record was published" };

  const liveOk = findings.liveDelivery as { delivered: boolean };
  const backfillOk = findings.backfill as { containsTombstone: boolean };
  const gateOk = (findings.crossAuthorFilterGate as { accepted?: boolean })
    ?.accepted;
  const deliveryOk = liveOk.delivered && backfillOk.containsTombstone;

  if (!deliveryOk || !gateOk) {
    findings.verdict =
      "NEGATIVE — watcher design needs amendment before Phase 5";
  } else if (singleIdentity) {
    findings.verdict =
      "POSITIVE (single-identity) — the relay accepts a cross-author kind:5 " +
      "subscription, and an a-tag-only kind:5 is stored, fanned out live, and " +
      "returned by a `since` backfill. The two were observed separately: " +
      "delivery was self-authored, so the join rests on the relay source, " +
      "where no per-event author gate applies to kind 5. Re-run with " +
      "BUZZ_WATCHER_PRIVATE_KEY for the complete answer.";
  } else {
    findings.verdict =
      "POSITIVE — the planned TombstoneWatcher design is viable as written";
  }
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
