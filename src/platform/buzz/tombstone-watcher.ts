// The gateway-lifetime tombstone watcher (R5.8–R5.10, plan Q2).
//
// The delete signal is an event on a relay, and nothing in the deploy protocol
// carries it — so something has to be listening, and the most likely delete
// sequence is "stop the agent, then delete it". That means the listener cannot
// belong to an endpoint supervisor: by the time the tombstone publishes, the
// endpoint has drained, announced offline, and stopped. This service therefore
// holds its own connection per **distinct relay URL** across all provisioned
// agents — staged ones included — for the lifetime of the gateway process, and
// keeps listening while any number of endpoints are drained or shut down.
//
// Three properties are load-bearing and were settled by the Phase 0 relay probe
// (`spike/buzz-transport/tombstone-delivery-fixture.json`, verdict POSITIVE):
// the relay accepts a cross-author `{kinds:[5], authors:[…]}` subscription; an
// `a`-tag-only kind:5 is stored as a global event (channel derivation looks for
// an `e` tag, which this event does not have, so channel membership never gates
// it); and it is returned by a `since` backfill.
//
// Everything this service receives is *evidence*, never an instruction. It
// verifies client-side and hands the result to the lifecycle service, which
// stages; anything unverifiable is recorded for the advisory report and deletes
// nothing (R5.11).

import type { Event, Filter } from "nostr-tools";

import { nextBackoffMs } from "../../backoff.js";
import { logger } from "../../log.js";
import type { GatewayDB } from "../../db/gateway-db.js";
import { BuzzRelayClient } from "./client.js";
import {
  readEndpointBlock,
  type BuzzAgentLifecycleService,
  type RecordState,
} from "./agent-lifecycle.js";
import {
  KIND_DELETION,
  KIND_MANAGED_AGENT,
  matchTombstone,
  parseAgentTombstone,
} from "./tombstone.js";

const log = logger("buzz.tombstone-watcher");

/**
 * Backfill overlap, in seconds. Same convention as `replay_overlap_secs`: the
 * cursor records the newest event we processed, and re-asking from slightly
 * before it costs a handful of duplicate events (which are idempotent — a
 * second stage for an already-staged agent is a no-op) and buys immunity to
 * relay clock skew and to events that landed in the same second.
 */
export const TOMBSTONE_BACKFILL_OVERLAP_SECS = 300;

/** Budget for the reconciliation report's record probe (R14.5). */
export const RECORD_PROBE_BUDGET_MS = 10_000;

/**
 * How many event ids the per-process dedupe remembers. Bounded because the
 * watcher runs for the life of the gateway and an unbounded set on a busy
 * relay is a slow leak; the durable answer to "did we already act on this" is
 * the agent's own lifecycle, not this cache.
 */
const SEEN_EVENT_CAP = 2_000;

/** One relay's worth of watching. */
export interface TombstoneRelayTarget {
  relayUrl: string;
  /** Distinct owner pubkeys whose tombstones matter on this relay. */
  ownerPubkeys: string[];
  /**
   * The identity the watcher authenticates as (NIP-42).
   *
   * Deterministically chosen so a restart reuses the same key rather than
   * flapping between identities: the lexicographically-first non-staged agent
   * on this relay, falling back to a staged one. Keys exist until purge, and
   * after the last purge there is nothing left on that relay to watch.
   */
  auth: { endpointId: string; privateKey: string; authTag: string | null };
  agents: Array<{
    agentId: string;
    agentPubkey: string;
    ownerPubkey: string | null;
    lifecycle: string;
  }>;
}

export interface TombstoneWatcherDeps {
  db: GatewayDB;
  lifecycle: BuzzAgentLifecycleService;
  /** Recomputed on every reconcile; a create or a purge changes the answer. */
  targets: () => TombstoneRelayTarget[];
  /** Buzz identities declared in YAML — never stageable by a relay event. */
  yamlPubkeys: () => ReadonlySet<string>;
  maxFrameBytes: number;
  waitMs: number;
  reconnect: { base_ms: number; cap_ms: number };
  clientFactory?: (
    options: ConstructorParameters<typeof BuzzRelayClient>[0],
  ) => BuzzRelayClient;
  random?: () => number;
  now?: () => number;
  /** Cadence at which the relay set is re-derived from the database. */
  reconcileIntervalMs?: number;
  backfillOverlapSecs?: number;
}

/** Distinct-relay reconciliation, connection ownership, and the event funnel. */
export class TombstoneWatcher {
  private readonly workers = new Map<string, RelayWorker>();
  /** Event ids handled by this process, so overlap does not re-audit them. */
  private readonly seen = new Set<string>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: TombstoneWatcherDeps) {}

  /** Distinct relay URLs currently being watched. */
  get relayUrls(): string[] {
    return [...this.workers.keys()].sort();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.refresh();
    this.reconcileTimer = setInterval(
      () => this.refresh(),
      this.deps.reconcileIntervalMs ?? 60_000,
    );
    (this.reconcileTimer as unknown as { unref?: () => void }).unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.allSettled(workers.map((worker) => worker.stop()));
  }

  /**
   * Re-derive the relay set and start/stop/replace workers to match.
   *
   * Called on a timer and directly after any fleet change. A worker whose owner
   * set moved is replaced rather than patched: the owner list is baked into a
   * live REQ filter, and a subscription cannot be widened in place.
   */
  refresh(): void {
    if (!this.running) return;
    let targets: TombstoneRelayTarget[];
    try {
      targets = this.deps.targets();
    } catch (error) {
      log.error("could not derive tombstone watch targets", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const wanted = new Map(targets.map((target) => [target.relayUrl, target]));

    for (const [relayUrl, worker] of [...this.workers]) {
      const target = wanted.get(relayUrl);
      if (!target) {
        this.workers.delete(relayUrl);
        void worker.stop();
        log.info("stopped watching a relay with no provisioned agents", {
          relay_url: relayUrl,
        });
        continue;
      }
      if (worker.matches(target)) {
        worker.updateTarget(target);
        continue;
      }
      this.workers.delete(relayUrl);
      void worker.stop();
    }

    for (const target of targets) {
      if (this.workers.has(target.relayUrl)) continue;
      const worker = new RelayWorker(this.deps, target, (event, relayUrl) =>
        this.handleEvent(event, relayUrl),
      );
      this.workers.set(target.relayUrl, worker);
      worker.start();
      log.info("watching a relay for managed-agent tombstones", {
        relay_url: target.relayUrl,
        owners: target.ownerPubkeys.length,
        agents: target.agents.length,
      });
    }
  }

  /**
   * Verify one inbound frame and stage if — and only if — it accounts for
   * itself completely.
   *
   * Every early return here is a refusal to delete. They are recorded rather
   * than dropped, because "we saw a tombstone we could not act on" is exactly
   * the state the reconciliation report exists to surface (R5.11).
   */
  async handleEvent(value: unknown, relayUrl: string): Promise<void> {
    // The live subscription starts at the same point the backfill did, so the
    // two overlap by design and every reconnect redelivers the same window.
    // Without this the audit table would grow a fresh "rejected" row for the
    // same tombstone on every reconnect, burying the ones that are new.
    const frameId = eventIdOf(value);
    if (frameId !== null) {
      if (this.seen.has(frameId)) return;
      if (this.seen.size >= SEEN_EVENT_CAP) {
        this.seen.delete(this.seen.values().next().value as string);
      }
      this.seen.add(frameId);
    }

    const parsed = parseAgentTombstone(value);
    if (!parsed.ok) {
      // A kind:5 that is not an agent tombstone at all (a message deletion, a
      // different record kind) is ordinary relay traffic and is not worth an
      // audit row. Anything that *claims* to be one and fails is.
      const noise =
        parsed.reason === "wrong_kind" ||
        parsed.reason === "wrong_record_kind" ||
        parsed.reason === "no_a_tag" ||
        parsed.reason === "unexpected_e_tag" ||
        parsed.reason === "not_an_event";
      log.warn("ignoring a kind:5 that is not an actionable agent tombstone", {
        relay_url: relayUrl,
        reason: parsed.reason,
        detail: parsed.detail,
      });
      if (!noise) {
        this.deps.lifecycle.recordRejectedTombstone({
          reason: parsed.reason,
          eventId: eventIdOf(value),
          agentPubkey: null,
          ownerPubkey: null,
          relayUrl,
          message: parsed.detail,
        });
      }
      return;
    }

    const tombstone = parsed.tombstone;
    // Endpoints are read once and indexed: a relay carrying ordinary kind:5
    // traffic reaches this path often, and a per-agent lookup inside the loop
    // would re-read and re-parse every endpoint row for every event.
    const ownerByAgent = new Map(
      this.deps.db
        .listProvisionedEndpoints()
        .map((row) => [row.agentId, readEndpointBlock(row).ownerPubkey]),
    );
    const provisionedByPubkey = new Map(
      this.deps.db.listProvisionedAgents().map((row) => [
        row.derivedPubkey,
        {
          agentId: row.agentId,
          ownerPubkey: ownerByAgent.get(row.agentId) ?? null,
          lifecycle: row.lifecycle,
        },
      ]),
    );
    const match = matchTombstone(tombstone, {
      yamlPubkeys: this.deps.yamlPubkeys(),
      provisionedByPubkey,
    });

    if (match.kind === "ignore") {
      log.warn("tombstone deleted nothing", {
        relay_url: relayUrl,
        reason: match.reason,
        event_id: tombstone.eventId,
        agent_pubkey: tombstone.agentPubkey,
        detail: match.detail,
      });
      this.deps.lifecycle.recordRejectedTombstone({
        reason: match.reason,
        eventId: tombstone.eventId,
        agentPubkey: tombstone.agentPubkey,
        ownerPubkey: tombstone.ownerPubkey,
        relayUrl,
        message: match.detail,
      });
      return;
    }
    if (match.kind === "already_staged") {
      log.info("tombstone matched an agent that is already staged", {
        agent_id: match.agentId,
        event_id: tombstone.eventId,
      });
      return;
    }

    // An operator (or a fresh deploy) has already answered *this* tombstone.
    // The in-process dedupe above does not cover it: a restart clears that set,
    // and the backfill's 300 s overlap would then redeliver the very event the
    // reversal undid. The audit trail is the durable memory of that decision.
    if (this.deps.lifecycle.wasReversed(match.agentId, tombstone.eventId)) {
      log.warn("ignoring a tombstone an operator has already reversed", {
        agent_id: match.agentId,
        event_id: tombstone.eventId,
      });
      this.deps.lifecycle.recordRejectedTombstone({
        reason: "restored_after_tombstone",
        eventId: tombstone.eventId,
        agentPubkey: tombstone.agentPubkey,
        ownerPubkey: tombstone.ownerPubkey,
        relayUrl,
        message: `agent '${match.agentId}' was restored after this exact tombstone staged it`,
      });
      return;
    }

    await this.deps.lifecycle.stage(match.agentId, {
      kind: "tombstone",
      eventId: tombstone.eventId,
      ownerPubkey: tombstone.ownerPubkey,
      relayUrl,
    });
  }

  /**
   * Best-effort managed-agent record states for the reconciliation report.
   *
   * Kind **30177**, asserted rather than assumed: 30179 is the private variant
   * and is author-only at the relay, so querying it would return nothing for
   * every agent and the report would read as "every record deleted".
   *
   * A relay that is not connected, or that does not answer inside the budget,
   * contributes no entries at all — the caller renders those `unknown`.
   */
  async probeRecords(
    coordinates: readonly string[],
  ): Promise<ReadonlyMap<string, RecordState>> {
    const states = new Map<string, RecordState>();
    if (coordinates.length === 0) return states;
    const wanted = new Set(coordinates);
    const deadline = Date.now() + RECORD_PROBE_BUDGET_MS;

    await Promise.all(
      [...this.workers.values()].map(async (worker) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        const scoped = worker.target.agents.filter((agent) =>
          agent.ownerPubkey
            ? wanted.has(
                `${KIND_MANAGED_AGENT}:${agent.ownerPubkey}:${agent.agentPubkey}`,
              )
            : false,
        );
        if (scoped.length === 0) return;
        let events: Event[];
        try {
          events = await withTimeout(
            worker.query({
              kinds: [KIND_MANAGED_AGENT],
              authors: [...new Set(scoped.map((a) => a.ownerPubkey!))],
              "#d": scoped.map((a) => a.agentPubkey),
            }),
            remaining,
          );
        } catch (error) {
          log.warn("record probe failed for a relay", {
            relay_url: worker.target.relayUrl,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        const present = new Set<string>();
        for (const event of events) {
          const d = event.tags.find((tag) => tag[0] === "d")?.[1];
          if (typeof d === "string") {
            present.add(`${KIND_MANAGED_AGENT}:${event.pubkey}:${d}`);
          }
        }
        // Only relays we actually reached get to answer, and within those, an
        // absent record is a real fact rather than an unanswered question.
        for (const agent of scoped) {
          const coordinate = `${KIND_MANAGED_AGENT}:${agent.ownerPubkey}:${agent.agentPubkey}`;
          states.set(
            coordinate,
            present.has(coordinate) ? "present" : "absent",
          );
        }
      }),
    );
    return states;
  }
}

/** One relay connection: NIP-42, backfill, live subscription, cursor, backoff. */
class RelayWorker {
  private client: BuzzRelayClient | null = null;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private failureCount = 0;
  private sleepResolvers = new Set<() => void>();
  private querySequence = 0;

  constructor(
    private readonly deps: TombstoneWatcherDeps,
    public target: TombstoneRelayTarget,
    private readonly onEvent: (
      event: unknown,
      relayUrl: string,
    ) => Promise<void>,
  ) {}

  /** Same relay, same owner filter, same auth identity — nothing to replace. */
  matches(next: TombstoneRelayTarget): boolean {
    return (
      next.relayUrl === this.target.relayUrl &&
      next.auth.endpointId === this.target.auth.endpointId &&
      sameSet(next.ownerPubkeys, this.target.ownerPubkeys)
    );
  }

  /** Refresh the agent list without disturbing the connection or the filter. */
  updateTarget(next: TombstoneRelayTarget): void {
    this.target = next;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const resolve of [...this.sleepResolvers]) resolve();
    this.client?.close();
    if (this.loopPromise) await this.loopPromise.catch(() => {});
    this.loopPromise = null;
  }

  /** Run one REQ on the live connection; throws when not connected. */
  async query(filter: Filter): Promise<Event[]> {
    const client = this.client;
    if (!client) throw new Error(`not connected to ${this.target.relayUrl}`);
    const events = await client.query(
      [filter],
      `tombstone-probe-${++this.querySequence}`,
    );
    return events.filter(
      (event): event is Event =>
        typeof event === "object" && event !== null && "id" in event,
    );
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const client = (
          this.deps.clientFactory ?? ((options) => new BuzzRelayClient(options))
        )({
          relayUrl: this.target.relayUrl,
          privateKey: this.target.auth.privateKey,
          authTag: this.target.auth.authTag,
          maxFrameBytes: this.deps.maxFrameBytes,
          waitMs: this.deps.waitMs,
          onInvalidFrame: (reason) => {
            log.warn("tombstone relay frame rejected", {
              relay_url: this.target.relayUrl,
              reason,
            });
          },
        });
        this.client = client;
        await client.connect();
        this.failureCount = 0;
        log.info("tombstone watcher connected", {
          relay_url: this.target.relayUrl,
          owners: this.target.ownerPubkeys.length,
        });

        // Backfill first, then go live. In that order a tombstone published
        // during the disconnect is processed before any new one, and the live
        // subscription's own `since` cannot open a gap: it starts at the same
        // point the backfill did, so an event landing between the two arrives
        // through one of them.
        const since = this.backfillSince();
        await this.backfill(client, since);
        client.subscribe(
          "tombstones-live",
          [this.filterSince(since)],
          (event) => {
            void this.consume(event);
          },
        );

        await client.waitUntilClosed();
        if (this.running) {
          log.warn("tombstone watcher disconnected; reconnecting", {
            relay_url: this.target.relayUrl,
          });
        }
      } catch (error) {
        if (!this.running) break;
        this.failureCount = Math.min(this.failureCount + 1, 16);
        log.warn("tombstone watcher connection failed", {
          relay_url: this.target.relayUrl,
          failure: this.failureCount,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.client?.close();
        this.client = null;
      }

      if (!this.running) break;
      // The existing Buzz reconnect vocabulary, not a new retry policy.
      const backoff = nextBackoffMs(
        Math.max(0, this.failureCount - 1),
        this.deps.reconnect.base_ms,
        this.deps.reconnect.cap_ms,
      );
      const random = this.deps.random ?? Math.random;
      await this.sleep(
        Math.max(1, Math.floor(backoff * (0.75 + random() * 0.5))),
      );
    }
  }

  /**
   * `cursor − overlap`, or the beginning of this watch if there is no cursor.
   *
   * A first run with no cursor deliberately asks for a bounded window rather
   * than for all history: the relay's whole kind:5 corpus is not ours to
   * reprocess, and any tombstone older than the window names an agent that
   * either no longer exists or was created after it.
   */
  private backfillSince(): number {
    const overlap =
      this.deps.backfillOverlapSecs ?? TOMBSTONE_BACKFILL_OVERLAP_SECS;
    const cursor = this.deps.db.getTombstoneCursor(this.target.relayUrl);
    const nowSecs = Math.floor((this.deps.now?.() ?? Date.now()) / 1000);
    if (!cursor) return nowSecs - overlap;
    return Math.max(0, cursor.lastCreatedAt - overlap);
  }

  private filterSince(since: number): Filter {
    return {
      kinds: [KIND_DELETION],
      authors: this.target.ownerPubkeys,
      since,
    };
  }

  private async backfill(
    client: BuzzRelayClient,
    since: number,
  ): Promise<void> {
    const events = await client.query(
      [this.filterSince(since)],
      `tombstones-backfill-${++this.querySequence}`,
    );
    const ordered = events
      .filter(
        (event): event is Event =>
          typeof event === "object" && event !== null && "created_at" in event,
      )
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    if (ordered.length > 0) {
      log.info("tombstone backfill returned events", {
        relay_url: this.target.relayUrl,
        since,
        count: ordered.length,
      });
    }
    for (const event of ordered) await this.consume(event);
  }

  /**
   * Process one event and advance the cursor.
   *
   * The cursor moves for **every** event the relay delivered under our filter,
   * not only for ones that staged something. It records how far we have read,
   * not what we agreed with — advancing only on success would make one
   * permanently unmatched tombstone pin the window open forever, and every
   * reconnect would replay the same batch.
   */
  private async consume(value: unknown): Promise<void> {
    try {
      await this.onEvent(value, this.target.relayUrl);
    } catch (error) {
      log.error("handling a tombstone failed", {
        relay_url: this.target.relayUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const event = value as Partial<Event>;
    if (typeof event?.created_at === "number") {
      this.deps.db.advanceTombstoneCursor({
        relayUrl: this.target.relayUrl,
        lastCreatedAt: event.created_at,
        lastEventId: typeof event.id === "string" ? event.id : null,
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.sleepResolvers.delete(wake);
        resolve();
      }, ms);
      const wake = (): void => {
        clearTimeout(timer);
        this.sleepResolvers.delete(wake);
        resolve();
      };
      this.sleepResolvers.add(wake);
    });
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((item) => set.has(item));
}

function eventIdOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("probe budget exhausted")),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Group provisioned agents into one target per distinct relay URL.
 *
 * The auth identity is chosen deterministically — lexicographically first
 * non-staged agent pubkey, else the first staged one — so a restart
 * authenticates as the same key rather than flapping, and so the choice is
 * testable without a relay. An agent whose endpoint has no `owner_pubkey` is
 * dropped from the owner filter with a log line: nothing could ever be verified
 * against it, and including it would widen the subscription for no gain.
 */
export function buildTombstoneTargets(input: {
  agents: ReadonlyArray<{
    agentId: string;
    agentPubkey: string;
    lifecycle: string;
    endpointId: string;
    relayUrl: string | null;
    ownerPubkey: string | null;
  }>;
  /** Opens the sealed key for exactly the endpoint chosen for NIP-42. */
  credentialFor: (
    endpointId: string,
  ) => { privateKey: string; authTag: string | null } | null;
}): TombstoneRelayTarget[] {
  const byRelay = new Map<string, TombstoneRelayTarget["agents"]>();
  const endpointByPubkey = new Map<string, string>();
  for (const agent of input.agents) {
    if (!agent.relayUrl) continue;
    const list = byRelay.get(agent.relayUrl) ?? [];
    list.push({
      agentId: agent.agentId,
      agentPubkey: agent.agentPubkey,
      ownerPubkey: agent.ownerPubkey,
      lifecycle: agent.lifecycle,
    });
    byRelay.set(agent.relayUrl, list);
    endpointByPubkey.set(agent.agentPubkey, agent.endpointId);
  }

  const targets: TombstoneRelayTarget[] = [];
  for (const [relayUrl, agents] of [...byRelay].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const sorted = [...agents].sort((a, b) =>
      a.agentPubkey.localeCompare(b.agentPubkey),
    );
    const chosen =
      sorted.find((agent) => agent.lifecycle !== "staged_delete") ?? sorted[0];
    if (!chosen) continue;
    const endpointId = endpointByPubkey.get(chosen.agentPubkey);
    const credential = endpointId ? input.credentialFor(endpointId) : null;
    if (!endpointId || !credential) {
      log.error("no usable NIP-42 identity for a relay; not watching it", {
        relay_url: relayUrl,
        agents: sorted.length,
      });
      continue;
    }
    const ownerPubkeys = [
      ...new Set(
        sorted
          .map((agent) => agent.ownerPubkey)
          .filter((owner): owner is string => Boolean(owner)),
      ),
    ].sort();
    if (ownerPubkeys.length === 0) {
      log.error("no owner pubkeys recorded for a relay; not watching it", {
        relay_url: relayUrl,
      });
      continue;
    }
    targets.push({
      relayUrl,
      ownerPubkeys,
      auth: { endpointId, ...credential },
      agents: sorted,
    });
  }
  return targets;
}
