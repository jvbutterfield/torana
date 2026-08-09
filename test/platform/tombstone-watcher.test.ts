// US-034 — the gateway-lifetime tombstone watcher.
//
// Two things are being defended here. First, that a tombstone published while
// nothing was listening still lands: the backfill and its durable cursor are
// the only backstop D2 permits, because no sweep may ever infer a deletion.
// Second, that listening is *decoupled* from every endpoint's runtime state —
// the most likely delete sequence is "stop the agent, then delete it", and an
// endpoint-owned subscription would be gone by then.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, Filter } from "nostr-tools";

import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { BuzzAgentLifecycleService } from "../../src/platform/buzz/agent-lifecycle.js";
import {
  buildTombstoneTargets,
  TombstoneWatcher,
  TOMBSTONE_BACKFILL_OVERLAP_SECS,
  type TombstoneRelayTarget,
} from "../../src/platform/buzz/tombstone-watcher.js";
import {
  KIND_MANAGED_AGENT,
  managedAgentCoordinate,
} from "../../src/platform/buzz/tombstone.js";
import type { BuzzRelayClient } from "../../src/platform/buzz/client.js";
import {
  decodeSecret,
  publicKey,
  signTemplate,
} from "../../src/platform/buzz/protocol.js";

const OWNER_SECRET = decodeSecret("04".padStart(64, "0"));
const OWNER_PUBKEY = publicKey(OWNER_SECRET);
const OTHER_SECRET = decodeSecret("07".padStart(64, "0"));
const AGENT_KEY = "0a".repeat(32);
const AGENT_PUBKEY = publicKey(decodeSecret(AGENT_KEY));
const RELAY = "wss://relay.example";
const RELAY_B = "wss://other.example";

const dirs: string[] = [];
const dbs: GatewayDB[] = [];
const watchers: TombstoneWatcher[] = [];

afterEach(async () => {
  for (const watcher of watchers.splice(0)) await watcher.stop();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// ── a relay that behaves like the one the Phase 0 probe measured ────────────

interface RelayStore {
  /** kind:5 events the relay already holds, answerable by a `since` query. */
  stored: Event[];
  /** kind:30177 records, for the reconciliation probe. */
  records: Event[];
  clients: FakeRelayClient[];
  /** Set to make `connect()` throw, exercising the reconnect path. */
  failConnect: boolean;
}

const stores = new Map<string, RelayStore>();

function store(relayUrl: string): RelayStore {
  const existing = stores.get(relayUrl);
  if (existing) return existing;
  const created: RelayStore = {
    stored: [],
    records: [],
    clients: [],
    failConnect: false,
  };
  stores.set(relayUrl, created);
  return created;
}

class FakeRelayClient {
  readonly relayUrl: string;
  readonly queries: Filter[][] = [];
  readonly liveFilters: Filter[][] = [];
  private handlers = new Map<string, (event: unknown) => void>();
  private closedResolve: (() => void) | null = null;
  private closedPromise: Promise<void> = Promise.resolve();
  connected = false;

  constructor(readonly options: { relayUrl: string; privateKey: string }) {
    this.relayUrl = options.relayUrl;
    store(this.relayUrl).clients.push(this);
  }

  async connect(): Promise<Event> {
    if (store(this.relayUrl).failConnect) throw new Error("relay refused");
    this.connected = true;
    this.closedPromise = new Promise<void>((resolve) => {
      this.closedResolve = resolve;
    });
    return {} as Event;
  }

  async query(filters: Filter[]): Promise<unknown[]> {
    this.queries.push(filters);
    const filter = filters[0]!;
    const backing = store(this.relayUrl);
    if (filter.kinds?.includes(KIND_MANAGED_AGENT)) {
      const wanted = new Set(filter["#d"] ?? []);
      return backing.records.filter((event) =>
        wanted.has(event.tags.find((tag) => tag[0] === "d")?.[1] ?? ""),
      );
    }
    const since = filter.since ?? 0;
    const authors = new Set(filter.authors ?? []);
    // Relay frames arrive as JSON, never as the locally-signed object: the
    // "already verified" symbol `finalizeEvent` stamps must not travel here or
    // every forgery test would pass verification for free.
    return backing.stored
      .filter((event) => event.created_at >= since && authors.has(event.pubkey))
      .map((event) => JSON.parse(JSON.stringify(event)));
  }

  subscribe(
    id: string,
    filters: Filter[],
    onEvent: (event: unknown) => void,
  ): void {
    this.liveFilters.push(filters);
    this.handlers.set(id, onEvent);
  }

  closeSubscription(id: string): void {
    this.handlers.delete(id);
  }

  async waitUntilClosed(): Promise<void> {
    await this.closedPromise;
  }

  close(): void {
    this.connected = false;
    this.handlers.clear();
    this.closedResolve?.();
    this.closedResolve = null;
  }

  /** Fan one event out to the live subscription, as the relay would. */
  deliver(event: Event): void {
    const frame = JSON.parse(JSON.stringify(event));
    for (const handler of [...this.handlers.values()]) handler(frame);
  }

  get subscribed(): boolean {
    return this.handlers.size > 0;
  }
}

/**
 * Change a hex string's last character to something it definitely was not.
 *
 * Replacing it with a *fixed* character is a one-in-sixteen flake: schnorr
 * signing draws fresh auxiliary randomness every run, so roughly one signature
 * in sixteen already ends in that character and the "forgery" is byte-identical
 * to the real thing. The test then verifies, stages the agent, and fails —
 * intermittently, on CI, on one matrix job out of two.
 */
function corrupt(hex: string): string {
  const last = hex.at(-1);
  return `${hex.slice(0, -1)}${last === "a" ? "b" : "a"}`;
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ── fixtures ────────────────────────────────────────────────────────────────

function tombstoneFor(
  agentPubkey: string,
  options: { secret?: Uint8Array; owner?: string; createdAt?: number } = {},
): Event {
  return signTemplate(
    {
      kind: 5,
      created_at: options.createdAt ?? 1_786_000_000,
      content: "",
      tags: [
        [
          "a",
          managedAgentCoordinate(options.owner ?? OWNER_PUBKEY, agentPubkey),
        ],
      ],
    },
    options.secret ?? OWNER_SECRET,
  );
}

function recordFor(agentPubkey: string): Event {
  return signTemplate(
    {
      kind: KIND_MANAGED_AGENT,
      created_at: 1_785_000_000,
      content: "{}",
      tags: [["d", agentPubkey]],
    },
    OWNER_SECRET,
  );
}

interface Harness {
  db: GatewayDB;
  watcher: TombstoneWatcher;
  lifecycle: BuzzAgentLifecycleService;
  targets: TombstoneRelayTarget[];
  clock: { now: number };
  addAgent: (input: {
    agentId: string;
    privateKeyHex: string;
    relayUrl?: string;
    ownerPubkey?: string | null;
    lifecycle?: "active" | "staged_delete";
  }) => string;
  currentClient: (relayUrl?: string) => FakeRelayClient;
}

function makeHarness(options: { yamlPubkeys?: string[] } = {}): Harness {
  stores.clear();
  const dir = mkdtempSync(join(tmpdir(), "torana-watcher-"));
  dirs.push(dir);
  applyMigrations(join(dir, "gateway.db"));
  const db = new GatewayDB(join(dir, "gateway.db"));
  dbs.push(db);

  const clock = { now: 1_786_000_000_000 };
  const lifecycle = new BuzzAgentLifecycleService({
    db,
    dataDir: dir,
    provisioning: {
      max_agents: 8,
      delete_grace_hours: 72,
      min_free_bytes: 0,
      workspace_quota_bytes: 0,
      buzz_tools_default: {
        policy: "read_only",
        allowed_commands: [],
        expose_private_key_to_runner: false,
        acknowledge_dangerous: false,
      },
      harnesses: {},
    } as never,
    transport: () => null,
    now: () => clock.now,
  });

  const targets: TombstoneRelayTarget[] = [];
  const watcher = new TombstoneWatcher({
    db,
    lifecycle,
    // Fresh objects on every call, as `provisioning.tombstoneTargets()` builds
    // them. Handing the watcher the same arrays it already holds would make
    // every mutation invisible to its "did the owner set move?" comparison.
    targets: () =>
      targets.map((target) => ({
        ...target,
        ownerPubkeys: [...target.ownerPubkeys],
        agents: [...target.agents],
      })),
    yamlPubkeys: () => new Set(options.yamlPubkeys ?? []),
    maxFrameBytes: 65_536,
    waitMs: 500,
    reconnect: { base_ms: 1, cap_ms: 2 },
    random: () => 0.5,
    now: () => clock.now,
    clientFactory: (opts) =>
      new FakeRelayClient(opts) as unknown as BuzzRelayClient,
  });
  watchers.push(watcher);

  const addAgent: Harness["addAgent"] = (input) => {
    const pubkey = publicKey(decodeSecret(input.privateKeyHex));
    const relayUrl = input.relayUrl ?? RELAY;
    const owner =
      input.ownerPubkey === undefined ? OWNER_PUBKEY : input.ownerPubkey;
    db.upsertProvisionedAgent({
      agentId: input.agentId,
      derivedPubkey: pubkey,
      harness: "claude",
      systemPrompt: "",
      model: null,
      timeoutsJson: "{}",
      instructionVersion: "aaaaaaaaaaaa",
      provisionedBy: "test",
    });
    db.upsertProvisionedEndpoint({
      endpointId: `${input.agentId}-buzz`,
      agentId: input.agentId,
      derivedPubkey: pubkey,
      configJson: JSON.stringify({
        relay_url: relayUrl,
        ...(owner ? { owner_pubkey: owner } : {}),
      }),
      privateKeyCiphertext: "sealed",
      authTagCiphertext: null,
      provisionedBy: "test",
      deployNonce: null,
    });
    if (input.lifecycle === "staged_delete") {
      db.stageProvisionedAgentDelete({
        agentId: input.agentId,
        stagedAt: "2026-08-09 00:00:00",
        purgeDeadline: "2026-08-12 00:00:00",
      });
    }
    const existing = targets.find((target) => target.relayUrl === relayUrl);
    if (existing) {
      if (owner && !existing.ownerPubkeys.includes(owner)) {
        existing.ownerPubkeys = [...existing.ownerPubkeys, owner].sort();
      }
      existing.agents.push({
        agentId: input.agentId,
        agentPubkey: pubkey,
        ownerPubkey: owner,
        lifecycle: input.lifecycle ?? "active",
      });
    } else {
      targets.push({
        relayUrl,
        ownerPubkeys: owner ? [owner] : [],
        auth: {
          endpointId: `${input.agentId}-buzz`,
          privateKey: input.privateKeyHex,
          authTag: null,
        },
        agents: [
          {
            agentId: input.agentId,
            agentPubkey: pubkey,
            ownerPubkey: owner,
            lifecycle: input.lifecycle ?? "active",
          },
        ],
      });
    }
    return pubkey;
  };

  return {
    db,
    watcher,
    lifecycle,
    targets,
    clock,
    addAgent,
    currentClient: (relayUrl = RELAY) => {
      const clients = store(relayUrl).clients;
      const client = clients[clients.length - 1];
      if (!client) throw new Error(`no client created for ${relayUrl}`);
      return client;
    },
  };
}

// ── target selection ────────────────────────────────────────────────────────

describe("buildTombstoneTargets", () => {
  const credential = () => ({ privateKey: "key", authTag: null });

  test("groups by distinct relay URL, one target each", () => {
    const targets = buildTombstoneTargets({
      agents: [
        agentRow("a", "aa", RELAY),
        agentRow("b", "bb", RELAY),
        agentRow("c", "cc", RELAY_B),
      ],
      credentialFor: credential,
    });
    // Sorted by URL so the target list is stable across calls; a set that
    // reorders itself would make the watcher churn connections on every
    // reconcile.
    expect(targets.map((target) => target.relayUrl)).toEqual([RELAY_B, RELAY]);
    expect(targets[1]!.agents).toHaveLength(2);
  });

  test("authenticates as the lexicographically first non-staged identity", () => {
    const targets = buildTombstoneTargets({
      agents: [
        agentRow("z", "ff", RELAY),
        agentRow("a", "11", RELAY),
        agentRow("m", "88", RELAY),
      ],
      credentialFor: credential,
    });
    expect(targets[0]!.auth.endpointId).toBe("a-buzz");
  });

  test("falls back to a staged identity when every agent is staged", () => {
    // Keys exist until purge, so a fleet mid-grace is still watchable — and it
    // is exactly the fleet whose remaining tombstones matter most.
    const targets = buildTombstoneTargets({
      agents: [
        { ...agentRow("z", "ff", RELAY), lifecycle: "staged_delete" },
        { ...agentRow("a", "11", RELAY), lifecycle: "staged_delete" },
      ],
      credentialFor: credential,
    });
    expect(targets[0]!.auth.endpointId).toBe("a-buzz");
  });

  test("prefers an active identity over an alphabetically earlier staged one", () => {
    const targets = buildTombstoneTargets({
      agents: [
        { ...agentRow("a", "11", RELAY), lifecycle: "staged_delete" },
        agentRow("z", "ff", RELAY),
      ],
      credentialFor: credential,
    });
    expect(targets[0]!.auth.endpointId).toBe("z-buzz");
  });

  test("de-duplicates and sorts owner pubkeys", () => {
    const targets = buildTombstoneTargets({
      agents: [
        { ...agentRow("a", "11", RELAY), ownerPubkey: "bb" },
        { ...agentRow("b", "22", RELAY), ownerPubkey: "aa" },
        { ...agentRow("c", "33", RELAY), ownerPubkey: "bb" },
      ],
      credentialFor: credential,
    });
    expect(targets[0]!.ownerPubkeys).toEqual(["aa", "bb"]);
  });

  test("skips an agent with no relay recorded", () => {
    const targets = buildTombstoneTargets({
      agents: [{ ...agentRow("a", "11", RELAY), relayUrl: null }],
      credentialFor: credential,
    });
    expect(targets).toEqual([]);
  });

  test("refuses to watch a relay with no owner pubkey — nothing could verify", () => {
    const targets = buildTombstoneTargets({
      agents: [{ ...agentRow("a", "11", RELAY), ownerPubkey: null }],
      credentialFor: credential,
    });
    expect(targets).toEqual([]);
  });

  test("refuses to watch a relay whose key will not open", () => {
    const targets = buildTombstoneTargets({
      agents: [agentRow("a", "11", RELAY)],
      credentialFor: () => null,
    });
    expect(targets).toEqual([]);
  });

  function agentRow(agentId: string, pubkey: string, relayUrl: string) {
    return {
      agentId,
      agentPubkey: pubkey,
      lifecycle: "active",
      endpointId: `${agentId}-buzz`,
      relayUrl,
      ownerPubkey: OWNER_PUBKEY,
    };
  }
});

// ── connection, backfill, cursor ────────────────────────────────────────────

describe("connecting and backfilling", () => {
  test("opens one connection per distinct relay and subscribes live", async () => {
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    h.addAgent({
      agentId: "beta",
      privateKeyHex: "0b".repeat(32),
      relayUrl: RELAY_B,
    });
    h.watcher.start();

    await waitFor(
      () =>
        h.currentClient(RELAY).subscribed &&
        h.currentClient(RELAY_B).subscribed,
      "both relays subscribed",
    );
    expect(h.watcher.relayUrls).toEqual([RELAY_B, RELAY].sort());
  });

  test("with no cursor, backfills a bounded window rather than all history", async () => {
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    h.watcher.start();
    await waitFor(() => h.currentClient().queries.length > 0, "backfill query");

    const filter = h.currentClient().queries[0]![0]!;
    expect(filter.kinds).toEqual([5]);
    expect(filter.authors).toEqual([OWNER_PUBKEY]);
    expect(filter.since).toBe(
      Math.floor(h.clock.now / 1000) - TOMBSTONE_BACKFILL_OVERLAP_SECS,
    );
  });

  test("recovers a tombstone published while the gateway was down", async () => {
    // R5.10, and the reason it exists: D2 forbids a sweep, so a missed event
    // has no other backstop and the agent would bill forever.
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    store(RELAY).stored.push(
      tombstoneFor(AGENT_PUBKEY, {
        createdAt: Math.floor(h.clock.now / 1000) - 60,
      }),
    );
    h.watcher.start();

    await waitFor(
      () => h.db.getProvisionedAgent("canary")?.lifecycle === "staged_delete",
      "backfilled tombstone staged the agent",
    );
  });

  test("re-asks from the persisted cursor minus the overlap on the next start", async () => {
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    h.db.advanceTombstoneCursor({
      relayUrl: RELAY,
      lastCreatedAt: 1_700_000_000,
      lastEventId: "aa".repeat(32),
    });
    h.watcher.start();
    await waitFor(() => h.currentClient().queries.length > 0, "backfill query");
    expect(h.currentClient().queries[0]![0]!.since).toBe(
      1_700_000_000 - TOMBSTONE_BACKFILL_OVERLAP_SECS,
    );
  });

  test("advances the cursor for every delivered event, matched or not", async () => {
    // Advancing only on success would let one permanently unmatched tombstone
    // pin the window open and replay the same batch on every reconnect.
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    const stray = tombstoneFor("ab".repeat(32), { createdAt: 1_786_000_500 });
    store(RELAY).stored.push(stray);
    h.watcher.start();

    await waitFor(
      () => h.db.getTombstoneCursor(RELAY)?.lastCreatedAt === 1_786_000_500,
      "cursor advanced past an unmatched tombstone",
    );
    expect(h.db.getTombstoneCursor(RELAY)?.lastEventId).toBe(stray.id);
    expect(h.db.getProvisionedAgent("canary")?.lifecycle).toBe("active");
  });

  test("the cursor never moves backwards", () => {
    const h = makeHarness();
    h.db.advanceTombstoneCursor({
      relayUrl: RELAY,
      lastCreatedAt: 2_000,
      lastEventId: "new",
    });
    h.db.advanceTombstoneCursor({
      relayUrl: RELAY,
      lastCreatedAt: 1_000,
      lastEventId: "old",
    });
    expect(h.db.getTombstoneCursor(RELAY)).toMatchObject({
      lastCreatedAt: 2_000,
      lastEventId: "new",
    });
  });

  test("reconnects after a drop and backfills again", async () => {
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    h.watcher.start();
    await waitFor(() => h.currentClient().subscribed, "first connection");
    const first = h.currentClient();

    // The relay drops the socket, and a tombstone lands while we are away.
    store(RELAY).stored.push(
      tombstoneFor(AGENT_PUBKEY, { createdAt: 1_786_000_900 }),
    );
    first.close();

    await waitFor(
      () => store(RELAY).clients.length > 1,
      "a replacement connection",
    );
    await waitFor(
      () => h.db.getProvisionedAgent("canary")?.lifecycle === "staged_delete",
      "the reconnect backfill caught the tombstone",
    );
  });

  test("keeps retrying a relay that refuses the connection", async () => {
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    store(RELAY).failConnect = true;
    h.watcher.start();
    await waitFor(
      () => store(RELAY).clients.length >= 3,
      "repeated connection attempts",
    );
    // Nothing was staged on the way: an unreachable relay is not evidence.
    expect(h.db.getProvisionedAgent("canary")?.lifecycle).toBe("active");
  });
});

// ── verification at the funnel ──────────────────────────────────────────────

describe("what a live tombstone does", () => {
  test("an owner-signed tombstone for a provisioned agent stages it", async () => {
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    h.watcher.start();
    await waitFor(() => h.currentClient().subscribed, "live subscription");

    h.currentClient().deliver(tombstoneFor(AGENT_PUBKEY));
    await waitFor(
      () => h.db.getProvisionedAgent("canary")?.lifecycle === "staged_delete",
      "the agent staged",
    );
  });

  test("still arrives after the endpoint was stopped by its owner", async () => {
    // R5.8. The whole reason this service is not owned by a supervisor.
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    h.watcher.start();
    await waitFor(() => h.currentClient().subscribed, "live subscription");

    h.db.setEndpointLifecycle("canary-buzz", "disabled", "owner_shutdown");
    h.currentClient().deliver(tombstoneFor(AGENT_PUBKEY));

    await waitFor(
      () => h.db.getProvisionedAgent("canary")?.lifecycle === "staged_delete",
      "a stopped agent still staged",
    );
  });

  test("a wrongly-signed tombstone deletes nothing and is reported", async () => {
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    const event = JSON.parse(JSON.stringify(tombstoneFor(AGENT_PUBKEY)));
    event.sig = corrupt(String(event.sig));

    await h.watcher.handleEvent(event, RELAY);
    expect(h.db.getProvisionedAgent("canary")?.lifecycle).toBe("active");
    const report = await h.lifecycle.reconciliationReport();
    expect(report.rejectedTombstones[0]?.reason).toBe("invalid_signature");
  });

  test("a tombstone signed by the wrong owner deletes nothing and is reported", async () => {
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    // A self-consistent coordinate from a key that is not this agent's owner.
    const foreignOwner = publicKey(OTHER_SECRET);
    await h.watcher.handleEvent(
      JSON.parse(
        JSON.stringify(
          tombstoneFor(AGENT_PUBKEY, {
            secret: OTHER_SECRET,
            owner: foreignOwner,
          }),
        ),
      ),
      RELAY,
    );
    expect(h.db.getProvisionedAgent("canary")?.lifecycle).toBe("active");
    const report = await h.lifecycle.reconciliationReport();
    expect(report.rejectedTombstones[0]?.reason).toBe("owner_mismatch");
  });

  test("an unmatched pubkey deletes nothing and is reported", async () => {
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    await h.watcher.handleEvent(
      JSON.parse(JSON.stringify(tombstoneFor("cd".repeat(32)))),
      RELAY,
    );
    expect(h.db.getProvisionedAgent("canary")?.lifecycle).toBe("active");
    const report = await h.lifecycle.reconciliationReport();
    expect(report.rejectedTombstones[0]).toMatchObject({
      reason: "unmatched_pubkey",
      agentPubkey: "cd".repeat(32),
    });
  });

  test("a tombstone naming a YAML identity deletes nothing and is reported", async () => {
    const yamlPubkey = publicKey(decodeSecret("0e".repeat(32)));
    const h = makeHarness({ yamlPubkeys: [yamlPubkey] });
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    await h.watcher.handleEvent(
      JSON.parse(JSON.stringify(tombstoneFor(yamlPubkey))),
      RELAY,
    );
    const report = await h.lifecycle.reconciliationReport();
    expect(report.rejectedTombstones[0]?.reason).toBe("yaml_identity");
    // And nothing anywhere moved.
    expect(h.db.getProvisionedAgent("canary")?.lifecycle).toBe("active");
  });

  test("ordinary relay noise is not written to the report", async () => {
    // A kind:5 deleting a message is normal traffic on a shared relay. Turning
    // every one of them into an audit row would bury the tombstones that
    // actually failed verification.
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    const messageDeletion = signTemplate(
      {
        kind: 5,
        created_at: 1_786_000_000,
        content: "",
        tags: [["e", "f".repeat(64)]],
      },
      OWNER_SECRET,
    );
    await h.watcher.handleEvent(
      JSON.parse(JSON.stringify(messageDeletion)),
      RELAY,
    );
    const report = await h.lifecycle.reconciliationReport();
    expect(report.rejectedTombstones).toHaveLength(0);
  });

  test("a tombstone an operator already reversed does not re-stage the agent", async () => {
    // The nastiest redelivery: restore at T, restart at T+1min, and the
    // backfill's 300 s overlap hands the same tombstone back. The in-process
    // dedupe is empty after a restart, so the audit trail has to carry the
    // operator's decision.
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    const event = JSON.parse(JSON.stringify(tombstoneFor(AGENT_PUBKEY)));
    await h.watcher.handleEvent(event, RELAY);
    expect(h.db.getProvisionedAgent("canary")?.lifecycle).toBe("staged_delete");

    h.clock.now += 30_000;
    expect(h.lifecycle.restore("canary", "operator-cli")).toBe("restored");

    // A fresh process: new watcher, empty dedupe, same database.
    const revived = new TombstoneWatcher({
      db: h.db,
      lifecycle: h.lifecycle,
      targets: () => [],
      yamlPubkeys: () => new Set(),
      maxFrameBytes: 65_536,
      waitMs: 500,
      reconnect: { base_ms: 1, cap_ms: 2 },
      now: () => h.clock.now,
    });
    watchers.push(revived);
    await revived.handleEvent(event, RELAY);

    expect(h.db.getProvisionedAgent("canary")?.lifecycle).toBe("active");
    const report = await h.lifecycle.reconciliationReport();
    expect(report.rejectedTombstones[0]?.reason).toBe(
      "restored_after_tombstone",
    );
  });

  test("a different tombstone still stages an agent that was restored", async () => {
    // The reversal answers the tombstone it reversed, not every future one. A
    // second delete is a second signal and has to be honoured.
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    await h.watcher.handleEvent(
      JSON.parse(
        JSON.stringify(
          tombstoneFor(AGENT_PUBKEY, { createdAt: 1_786_000_000 }),
        ),
      ),
      RELAY,
    );
    expect(h.lifecycle.restore("canary", "operator-cli")).toBe("restored");

    await h.watcher.handleEvent(
      JSON.parse(
        JSON.stringify(
          tombstoneFor(AGENT_PUBKEY, { createdAt: 1_786_000_200 }),
        ),
      ),
      RELAY,
    );
    expect(h.db.getProvisionedAgent("canary")?.lifecycle).toBe("staged_delete");
  });

  test("the same event twice in one process is handled once", async () => {
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    const stray = JSON.parse(JSON.stringify(tombstoneFor("cd".repeat(32))));
    await h.watcher.handleEvent(stray, RELAY);
    await h.watcher.handleEvent(stray, RELAY);
    const report = await h.lifecycle.reconciliationReport();
    expect(report.rejectedTombstones).toHaveLength(1);
  });

  test("a redelivered tombstone for an already-staged agent changes nothing", async () => {
    const h = makeHarness();
    h.addAgent({
      agentId: "canary",
      privateKeyHex: AGENT_KEY,
      lifecycle: "staged_delete",
    });
    const before = h.db.getProvisionedAgent("canary")!;
    await h.watcher.handleEvent(
      JSON.parse(JSON.stringify(tombstoneFor(AGENT_PUBKEY))),
      RELAY,
    );
    expect(h.db.getProvisionedAgent("canary")).toEqual(before);
  });
});

// ── fleet changes and the record probe ─────────────────────────────────────

describe("refresh", () => {
  test("starts watching a relay that a new agent introduced", async () => {
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    h.watcher.start();
    await waitFor(() => h.currentClient(RELAY).subscribed, "first relay");

    h.addAgent({
      agentId: "beta",
      privateKeyHex: "0b".repeat(32),
      relayUrl: RELAY_B,
    });
    h.watcher.refresh();
    await waitFor(() => h.currentClient(RELAY_B).subscribed, "second relay");
    expect(h.watcher.relayUrls).toHaveLength(2);
  });

  test("stops watching a relay once its last agent is purged", async () => {
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    h.watcher.start();
    await waitFor(() => h.currentClient(RELAY).subscribed, "connected");

    h.targets.splice(0);
    h.watcher.refresh();
    expect(h.watcher.relayUrls).toEqual([]);
    await waitFor(
      () => !h.currentClient(RELAY).connected,
      "the connection closed",
    );
  });

  test("adding an agent under a new owner replaces the subscription filter", async () => {
    const h = makeHarness();
    h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    h.watcher.start();
    await waitFor(() => h.currentClient().subscribed, "connected");
    const secondOwner = publicKey(OTHER_SECRET);
    h.addAgent({
      agentId: "beta",
      privateKeyHex: "0b".repeat(32),
      ownerPubkey: secondOwner,
    });
    h.watcher.refresh();

    await waitFor(
      () =>
        store(RELAY).clients.some((client) =>
          client.liveFilters.some(
            (filters) => (filters[0]?.authors ?? []).length === 2,
          ),
        ),
      "a subscription covering both owners",
    );
  });
});

describe("record probe", () => {
  test("reports present and absent for the relays it reached", async () => {
    const h = makeHarness();
    const canaryPubkey = h.addAgent({
      agentId: "canary",
      privateKeyHex: AGENT_KEY,
    });
    const betaPubkey = h.addAgent({
      agentId: "beta",
      privateKeyHex: "0b".repeat(32),
    });
    store(RELAY).records.push(recordFor(canaryPubkey));
    h.watcher.start();
    await waitFor(() => h.currentClient().subscribed, "connected");

    const states = await h.watcher.probeRecords([
      managedAgentCoordinate(OWNER_PUBKEY, canaryPubkey),
      managedAgentCoordinate(OWNER_PUBKEY, betaPubkey),
    ]);
    expect(states.get(managedAgentCoordinate(OWNER_PUBKEY, canaryPubkey))).toBe(
      "present",
    );
    expect(states.get(managedAgentCoordinate(OWNER_PUBKEY, betaPubkey))).toBe(
      "absent",
    );
  });

  test("queries kind 30177, not the author-only private variant", async () => {
    const h = makeHarness();
    const pubkey = h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    h.watcher.start();
    await waitFor(() => h.currentClient().subscribed, "connected");
    await h.watcher.probeRecords([
      managedAgentCoordinate(OWNER_PUBKEY, pubkey),
    ]);
    const probe = h
      .currentClient()
      .queries.find((filters) => filters[0]?.kinds?.[0] === 30177);
    expect(probe).toBeDefined();
    expect(probe![0]!.kinds).toEqual([30177]);
  });

  test("contributes nothing for a relay it never connected to", async () => {
    const h = makeHarness();
    const pubkey = h.addAgent({ agentId: "canary", privateKeyHex: AGENT_KEY });
    // Watcher never started: no worker, so no answer — and "unknown" is what
    // the caller renders, never "absent".
    const states = await h.watcher.probeRecords([
      managedAgentCoordinate(OWNER_PUBKEY, pubkey),
    ]);
    expect(states.size).toBe(0);
  });
});
