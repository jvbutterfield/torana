import type { Event } from "nostr-tools";
import { nextBackoffMs } from "../../backoff.js";
import type { AlertManager } from "../../alerts.js";
import type {
  NormalizedConfigModel,
  NormalizedEndpointConfig,
} from "../../config/v2.js";
import type { GatewayDB } from "../../db/gateway-db.js";
import { logger } from "../../log.js";
import type { OnUpdateHandler, Transport } from "../../transport/types.js";
import type { PlatformAdapter } from "../capabilities.js";
import type { InboundEvent } from "../types.js";
import { BuzzAdapter, type BuzzSignalOutcome } from "./adapter.js";
import { BuzzRelayClient } from "./client.js";
import {
  BUZZ_KINDS,
  channelFilter,
  channelMetadataFilter,
  discoverChannelIds,
  discoveryFilters,
  isValidInboundEvent,
  membershipFilter,
  parseChannelMetadata,
} from "./protocol.js";

const log = logger("transport.buzz");

/**
 * `lastError` marker for an endpoint that is connected but whose presence
 * refreshes are not landing. Distinct from a disconnect: the relay session is
 * fine, but clients are about to stop seeing the agent as online.
 */
export const PRESENCE_STALE = "presence_stale";

/**
 * `state_reason` written when an endpoint is stopped by its owner's
 * `!shutdown`. Deliberately not `config_disabled`: that reason is the one the
 * config sync treats as "re-enable me when the config says so", which would
 * bring a stopped agent back on the next restart.
 */
export const OWNER_SHUTDOWN = "owner_shutdown";

export type BuzzEndpointHealthState =
  | "disabled"
  | "draining"
  | "connecting"
  | "healthy"
  | "unhealthy";

export interface BuzzEndpointHealth {
  endpointId: string;
  agentId: string;
  state: BuzzEndpointHealthState;
  connected: boolean;
  channels: number;
  lastError: string | null;
  disconnectedSince: number | null;
  presence: BuzzPresenceHealth;
}

export interface BuzzPresenceHealth {
  /** Lifecycle presence publishes the supervisor tried to make. */
  attempted: number;
  /** Dropped before signing because the presence rate limit was still open. */
  suppressed: number;
  /** Signed but not accepted by the relay. */
  failed: number;
  /** Failures since the last accepted publish. */
  consecutiveFailures: number;
  /** `Date.now()` of the last accepted lifecycle presence publish. */
  lastPublishedAt: number | null;
  /** True once `consecutiveFailures` reaches the configured threshold. */
  stale: boolean;
}

export interface BuzzTransportOptions {
  db: GatewayDB;
  normalized: NormalizedConfigModel;
  endpoints: NormalizedEndpointConfig[];
  alerts?: AlertManager;
  onAccepted?: (args: {
    endpointId: string;
    inboundEventId: number;
    event: Event;
    normalizedEvent: InboundEvent;
  }) => Promise<"enqueued" | void> | "enqueued" | void;
  onControl?: (args: {
    endpointId: string;
    inboundEventId: number;
    event: InboundEvent;
  }) => Promise<void> | void;
  onProactive?: (args: {
    endpointId: string;
    channelId: string;
    prompt: string;
  }) => Promise<void> | void;
  adapters?: ReadonlyMap<string, PlatformAdapter>;
  clientFactory?: (
    options: ConstructorParameters<typeof BuzzRelayClient>[0],
  ) => BuzzRelayClient;
  random?: () => number;
  lifecyclePollMs?: number;
}

export class BuzzTransport implements Transport {
  readonly kind = "buzz" as const;
  private supervisors: BuzzEndpointSupervisor[];
  private readonly opts: BuzzTransportOptions;
  private started = false;

  constructor(opts: BuzzTransportOptions) {
    this.opts = opts;
    this.supervisors = opts.endpoints
      .filter((endpoint) => endpoint.platform === "buzz" && endpoint.buzz)
      .map((endpoint) => new BuzzEndpointSupervisor({ ...opts, endpoint }));
  }

  /**
   * Derived rather than captured at construction: provisioning can attach an
   * endpoint to an agent after startup, and a stale list would leave that
   * agent's endpoint invisible to everything that iterates transports.
   */
  get botIds(): readonly string[] {
    return this.supervisors.map((item) => item.agentId);
  }

  async start(_onUpdate: OnUpdateHandler): Promise<void> {
    this.started = true;
    for (const supervisor of this.supervisors) supervisor.start();
  }

  async stopIngress(): Promise<void> {
    await Promise.all(this.supervisors.map((item) => item.stopIngress()));
  }

  async stop(): Promise<void> {
    this.started = false;
    await Promise.all(this.supervisors.map((item) => item.stop()));
  }

  snapshots(): BuzzEndpointHealth[] {
    return this.supervisors.map((item) => item.snapshot());
  }

  snapshot(endpointId: string): BuzzEndpointHealth | null {
    return (
      this.supervisors
        .find((item) => item.endpointId === endpointId)
        ?.snapshot() ?? null
    );
  }

  /**
   * Add or replace a supervisor at runtime — the transport capability that
   * makes provisioning possible without a process restart.
   *
   * Replacing is a full teardown of the old supervisor first (drain intake,
   * announce offline, close), because two supervisors on one endpoint id would
   * mean two subscriptions and two independently signed replies. Idempotent:
   * re-adding the same endpoint is a clean replace, not a duplicate.
   */
  async upsertEndpoint(endpoint: NormalizedEndpointConfig): Promise<void> {
    if (endpoint.platform !== "buzz" || !endpoint.buzz) {
      throw new Error("only Buzz endpoints can be provisioned");
    }
    await this.removeEndpoint(endpoint.id);
    const supervisor = new BuzzEndpointSupervisor({ ...this.opts, endpoint });
    this.supervisors.push(supervisor);
    if (this.started) supervisor.start();
  }

  /**
   * Stop and drop a supervisor. Returns false when there was nothing to stop.
   *
   * With `drainReason`, in-flight turns are allowed to finish and the endpoint
   * announces `offline` before the socket closes — what a deliberate delete
   * should do. Without it (the replace path of `upsertEndpoint`) the endpoint
   * is coming straight back, so the drain would only add latency.
   */
  async removeEndpoint(
    endpointId: string,
    opts: { drainReason?: string } = {},
  ): Promise<boolean> {
    const index = this.supervisors.findIndex(
      (item) => item.endpointId === endpointId,
    );
    if (index === -1) return false;
    const [supervisor] = this.supervisors.splice(index, 1);
    if (opts.drainReason) {
      await supervisor!.drainAndAnnounceOffline(opts.drainReason);
    }
    await supervisor!.stop();
    return true;
  }

  hasEndpoint(endpointId: string): boolean {
    return this.supervisors.some((item) => item.endpointId === endpointId);
  }
}

interface SupervisorOptions extends BuzzTransportOptions {
  endpoint: NormalizedEndpointConfig;
}

type BuzzNormalizedConfig = NormalizedConfigModel & {
  buzzPlatform: NonNullable<NormalizedConfigModel["buzzPlatform"]>;
  limits: NonNullable<NormalizedConfigModel["limits"]>;
};

class BuzzEndpointSupervisor {
  readonly endpointId: string;
  readonly agentId: string;
  private endpoint: NormalizedEndpointConfig;
  private adapter: BuzzAdapter;
  private db: GatewayDB;
  private normalized: BuzzNormalizedConfig;
  private alerts?: AlertManager;
  private onAccepted?: BuzzTransportOptions["onAccepted"];
  private onControl?: BuzzTransportOptions["onControl"];
  private onProactive?: BuzzTransportOptions["onProactive"];
  private clientFactory: NonNullable<BuzzTransportOptions["clientFactory"]>;
  private random: () => number;
  private lifecyclePollMs: number;
  private client: BuzzRelayClient | null = null;
  private running = false;
  private ingressEnabled = true;
  private loopPromise: Promise<void> | null = null;
  private accessibleChannels = new Set<string>();
  private activeChannelSubscriptions = new Set<string>();
  private state: BuzzEndpointHealthState = "disabled";
  private lastError: string | null = null;
  private disconnectedSince: number | null = null;
  private alertedDisconnected = false;
  private failureCount = 0;
  private membershipRefresh: Promise<void> = Promise.resolve();
  private sleepResolvers = new Set<() => void>();
  private heartbeatSequence = 0;
  private presence: BuzzPresenceHealth = {
    attempted: 0,
    suppressed: 0,
    failed: 0,
    consecutiveFailures: 0,
    lastPublishedAt: null,
    stale: false,
  };
  private alertedPresenceStale = false;
  private ownerShutdownInProgress = false;
  private readonly ownerShutdownDrainMs: number;
  private readonly outboundOnly: boolean;
  private readonly destinationChannelId: string | null;

  constructor(opts: SupervisorOptions) {
    this.endpoint = opts.endpoint;
    this.endpointId = opts.endpoint.id;
    this.agentId = opts.endpoint.agentId;
    this.outboundOnly = opts.endpoint.principalKind === "publisher";
    this.destinationChannelId =
      opts.normalized.publishers?.find(
        (publisher) => publisher.endpointId === opts.endpoint.id,
      )?.destinationConversationId ?? null;
    const configuredAdapter = opts.adapters?.get(opts.endpoint.id);
    this.adapter =
      configuredAdapter instanceof BuzzAdapter
        ? configuredAdapter
        : new BuzzAdapter(opts.endpoint);
    this.db = opts.db;
    if (!opts.normalized.buzzPlatform || !opts.normalized.limits) {
      throw new Error("Buzz transport requires normalized Phase 4 limits");
    }
    this.normalized = opts.normalized as BuzzNormalizedConfig;
    this.alerts = opts.alerts;
    this.onAccepted = opts.onAccepted;
    this.onControl = opts.onControl;
    this.onProactive = opts.onProactive;
    this.adapter.setRateLimits({
      edit: this.normalized.limits.buzz_edit_cadence_ms,
      reaction: this.normalized.limits.reaction_min_interval_ms,
      typing: this.normalized.limits.typing_min_interval_ms,
      presence: this.normalized.limits.presence_min_interval_ms,
    });
    this.clientFactory =
      opts.clientFactory ?? ((options) => new BuzzRelayClient(options));
    this.random = opts.random ?? Math.random;
    this.lifecyclePollMs = opts.lifecyclePollMs ?? 250;
    this.ownerShutdownDrainMs =
      this.normalized.limits.owner_shutdown_drain_ms ?? 30_000;
  }

  start(): void {
    if (this.running) return;
    this.ingressEnabled = true;
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stopIngress(): Promise<void> {
    if (!this.ingressEnabled) return;
    this.ingressEnabled = false;
    const client = this.client;
    if (!client) return;
    client.closeSubscription(this.subscriptionId("membership"));
    for (const channelId of this.activeChannelSubscriptions) {
      client.closeSubscription(this.channelSubscriptionId(channelId));
    }
    this.activeChannelSubscriptions.clear();
  }

  async stop(): Promise<void> {
    await this.stopIngress();
    this.running = false;
    if (!this.outboundOnly) {
      await this.adapter
        .signal(this.signalConversation(), {
          kind: "presence",
          state: "offline",
        })
        .catch(() => false);
    }
    for (const resolve of [...this.sleepResolvers]) resolve();
    this.client?.close();
    if (this.loopPromise) await this.loopPromise.catch(() => {});
    this.loopPromise = null;
  }

  snapshot(): BuzzEndpointHealth {
    return {
      endpointId: this.endpointId,
      agentId: this.agentId,
      state: this.state,
      connected: this.client !== null && this.state === "healthy",
      channels: this.accessibleChannels.size,
      lastError: this.lastError,
      disconnectedSince: this.disconnectedSince,
      presence: { ...this.presence },
    };
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const lifecycle = this.db.getEndpointState(
        this.endpointId,
      )?.lifecycleState;
      if (lifecycle !== "active") {
        this.client?.close();
        this.client = null;
        this.state = lifecycle === "draining" ? "draining" : "disabled";
        await this.sleep(this.lifecyclePollMs);
        continue;
      }

      try {
        this.state = "connecting";
        const config = this.endpoint.buzz!;
        const client = this.clientFactory({
          relayUrl: config.relayUrl,
          privateKey: config.privateKey,
          authTag: config.authTag,
          maxFrameBytes: this.normalized.buzzPlatform.max_frame_bytes,
          waitMs: this.normalized.limits.relay_ok_wait_ms,
          onInvalidFrame: (reason) => {
            log.warn("Buzz relay frame rejected", {
              endpoint_id: this.endpointId,
              reason,
            });
          },
        });
        this.client = client;
        this.adapter.setPublisher((event) => this.publish(client, event));
        await client.connect();
        this.adapter.resetEphemeralRateLimits();
        this.accessibleChannels = new Set(
          this.db.getEndpointState(this.endpointId)?.cursor.channels ?? [],
        );
        await this.refreshMemberships(client, true);
        if (this.outboundOnly && !this.destinationChannelId) {
          throw new Error("publisher destination is not configured");
        }
        if (
          this.outboundOnly &&
          !this.accessibleChannels.has(this.destinationChannelId!)
        ) {
          throw new Error("publisher destination membership is not active");
        }
        if (!this.outboundOnly && this.ingressEnabled) {
          await this.publishLifecyclePresence();
          await this.recoverAcceptedEvents();
        }
        if (this.ingressEnabled) this.subscribeMembership(client);
        this.failureCount = 0;
        this.disconnectedSince = null;
        this.alertedDisconnected = false;
        this.lastError = null;
        this.state = "healthy";
        log.info("Buzz endpoint connected", {
          endpoint_id: this.endpointId,
          community_id: this.endpoint.communityId,
          channels: this.accessibleChannels.size,
        });

        const closed = client.waitUntilClosed();
        const lifecycleMonitor = this.monitorLifecycle(client);
        try {
          await Promise.race([closed, lifecycleMonitor]);
        } finally {
          this.adapter.setPublisher(null);
          client.close();
          await Promise.allSettled([closed, lifecycleMonitor]);
        }
      } catch (error) {
        this.adapter.setPublisher(null);
        if (!this.running) break;
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;
        this.disconnectedSince ??= Date.now();
        this.failureCount = Math.min(this.failureCount + 1, 16);
        this.state = this.maybeAlertDisconnected() ? "unhealthy" : "connecting";
        log.warn("Buzz endpoint disconnected; reconnecting", {
          endpoint_id: this.endpointId,
          failure: this.failureCount,
          error: message,
        });
      } finally {
        this.client?.close();
        this.client = null;
        this.activeChannelSubscriptions.clear();
      }

      if (!this.running) break;
      const base = this.normalized.buzzPlatform.reconnect.base_ms;
      const cap = this.normalized.buzzPlatform.reconnect.cap_ms;
      const backoff = nextBackoffMs(
        Math.max(0, this.failureCount - 1),
        base,
        cap,
      );
      const jittered = Math.max(
        1,
        Math.floor(backoff * (0.75 + this.random() * 0.5)),
      );
      await this.sleep(jittered);
    }
  }

  private async recoverAcceptedEvents(): Promise<void> {
    for (const row of this.db.listBuzzEventsByStatus(this.endpointId, [
      "control",
    ])) {
      let event: unknown;
      try {
        event = JSON.parse(row.payloadJson);
      } catch {
        continue;
      }
      if (!isValidInboundEvent(event)) continue;
      const normalizedEvent = this.adapter.normalizeRecorded(event);
      if (normalizedEvent) {
        await this.onControl?.({
          endpointId: this.endpointId,
          inboundEventId: row.id,
          event: normalizedEvent,
        });
      }
    }
    const dispatched = this.db.listBuzzEventsByStatus(this.endpointId, [
      "dispatched",
    ]);
    for (const row of dispatched) {
      this.db.transitionInboundEvent(
        row.id,
        "dispatched",
        "interrupted",
        "gateway restarted after dispatch",
      );
    }
    const received = this.db.listBuzzEventsByStatus(this.endpointId, [
      "received",
    ]);
    for (const row of received) {
      let event: unknown;
      try {
        event = JSON.parse(row.payloadJson);
      } catch {
        this.db.transitionInboundEvent(
          row.id,
          "received",
          "rejected",
          "stored payload is malformed",
        );
        continue;
      }
      if (!isValidInboundEvent(event)) {
        this.db.transitionInboundEvent(
          row.id,
          "received",
          "rejected",
          "stored event signature is invalid",
        );
        continue;
      }
      await this.dispatchAccepted(row.id, event);
    }
  }

  private async refreshMemberships(
    client: BuzzRelayClient,
    initial: boolean,
  ): Promise<void> {
    const raw = await client.query(
      discoveryFilters(this.adapter.config.pubkey),
      this.subscriptionId(`discovery-${Date.now()}`),
    );
    const memberships = raw
      .filter(isValidInboundEvent)
      .filter((event) => event.kind === BUZZ_KINDS.groupMembers);
    const discovered = new Set(discoverChannelIds(memberships));
    const metadataRaw =
      discovered.size === 0 || this.outboundOnly
        ? []
        : await client.query(
            [channelMetadataFilter([...discovered])],
            this.subscriptionId(`metadata-${Date.now()}`),
          );
    const metadata = parseChannelMetadata(
      metadataRaw.filter(isValidInboundEvent),
    );
    this.adapter.setChannels(metadata);
    const removed = [...this.accessibleChannels].filter(
      (channel) => !discovered.has(channel),
    );
    const added = [...discovered].filter(
      (channel) => !this.accessibleChannels.has(channel),
    );

    for (const channel of removed) {
      client.closeSubscription(this.channelSubscriptionId(channel));
      this.activeChannelSubscriptions.delete(channel);
      this.db.archiveEndpointChannel(this.endpointId, channel);
    }
    this.accessibleChannels = discovered;
    this.db.setBuzzChannels(this.endpointId, [...discovered]);
    if (!this.outboundOnly && this.ingressEnabled) {
      for (const channel of initial ? [...discovered] : added) {
        await this.drainAndSubscribeChannel(client, channel);
      }
    }
  }

  private subscribeMembership(client: BuzzRelayClient): void {
    if (!this.ingressEnabled) return;
    const cursor = this.db.getEndpointState(this.endpointId)?.cursor;
    const point = cursor?.subscriptions.membership;
    const since = point
      ? Math.max(
          0,
          point.created_at -
            this.normalized.buzzPlatform.subscription.replay_overlap_secs,
        )
      : undefined;
    client.subscribe(
      this.subscriptionId("membership"),
      [membershipFilter(this.adapter.config.pubkey, since)],
      (raw) => {
        if (!this.ingressEnabled) return;
        if (this.outboundOnly) {
          if (!isValidInboundEvent(raw) || raw.kind !== BUZZ_KINDS.groupMembers)
            return;
          this.membershipRefresh = this.membershipRefresh
            .then(() => this.refreshMemberships(client, false))
            .catch((error) => {
              log.warn("Buzz publisher membership refresh failed", {
                endpoint_id: this.endpointId,
                error: error instanceof Error ? error.message : String(error),
              });
              client.close();
            });
          return;
        }
        void this.handleRelayEvent(raw)
          .then((membershipChanged) => {
            if (!membershipChanged) return;
            this.membershipRefresh = this.membershipRefresh
              .then(() => this.refreshMemberships(client, false))
              .catch((error) => {
                log.warn("Buzz membership refresh failed", {
                  endpoint_id: this.endpointId,
                  error: error instanceof Error ? error.message : String(error),
                });
                client.close();
              });
          })
          .catch((error) => this.failLiveHandler(client, error));
      },
    );
  }

  private async drainAndSubscribeChannel(
    client: BuzzRelayClient,
    channelId: string,
  ): Promise<void> {
    if (!this.ingressEnabled || this.activeChannelSubscriptions.has(channelId))
      return;
    const cursor = this.db.getEndpointState(this.endpointId)?.cursor;
    const scope = `channel:${channelId}:messages`;
    const point = cursor?.subscriptions[scope];
    const since = point
      ? Math.max(
          0,
          point.created_at -
            this.normalized.buzzPlatform.subscription.replay_overlap_secs,
        )
      : 0;
    const limit = this.normalized.buzzPlatform.subscription.historical_limit;
    const backlog = await client.query(
      [
        channelFilter({
          channelId,
          kinds: [
            BUZZ_KINDS.streamMessageV1,
            BUZZ_KINDS.streamMessageV2,
            BUZZ_KINDS.streamEdit,
            BUZZ_KINDS.deletion,
            BUZZ_KINDS.nativeDelete,
            BUZZ_KINDS.reaction,
            BUZZ_KINDS.forumPost,
            BUZZ_KINDS.forumComment,
            BUZZ_KINDS.forumVote,
            ...this.workflowKinds(),
          ],
          since,
          limit,
        }),
      ],
      this.subscriptionId(`backlog-${channelId}-${Date.now()}`),
    );
    if (backlog.length >= limit) {
      throw new Error(
        `replay_gap: channel ${channelId} reached historical_limit=${limit}`,
      );
    }
    const ordered = backlog
      .filter(isValidInboundEvent)
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    for (const event of ordered) await this.handleRelayEvent(event);

    const current = this.db.getEndpointState(this.endpointId)?.cursor
      .subscriptions[scope];
    const liveSince = current
      ? Math.max(
          0,
          current.created_at -
            this.normalized.buzzPlatform.subscription.replay_overlap_secs,
        )
      : since;
    if (!this.ingressEnabled) return;
    client.subscribe(
      this.channelSubscriptionId(channelId),
      [
        channelFilter({
          channelId,
          kinds: [
            BUZZ_KINDS.streamMessageV1,
            BUZZ_KINDS.streamMessageV2,
            BUZZ_KINDS.streamEdit,
            BUZZ_KINDS.deletion,
            BUZZ_KINDS.nativeDelete,
            BUZZ_KINDS.reaction,
            BUZZ_KINDS.forumPost,
            BUZZ_KINDS.forumComment,
            BUZZ_KINDS.forumVote,
            ...this.workflowKinds(),
          ],
          since: liveSince,
        }),
      ],
      (event) => {
        void this.handleRelayEvent(event).catch((error) =>
          this.failLiveHandler(client, error),
        );
      },
    );
    this.activeChannelSubscriptions.add(channelId);
  }

  private async handleRelayEvent(raw: unknown): Promise<boolean> {
    if (!this.ingressEnabled) return false;
    const decision = this.adapter.evaluateInbound(raw, this.accessibleChannels);
    if (decision.kind === "malformed") {
      log.warn("Buzz event failed validation", {
        endpoint_id: this.endpointId,
        reason: decision.reason,
      });
      return false;
    }
    if (decision.kind === "irrelevant") {
      if (decision.checkpoint) {
        this.db.checkpointBuzzCursor(
          this.endpointId,
          decision.checkpoint.cursorScope,
          decision.checkpoint.createdAt,
          decision.checkpoint.eventId,
        );
      }
      return false;
    }
    const status =
      decision.kind === "accepted"
        ? "received"
        : decision.kind === "control"
          ? "control"
          : "rejected";
    let recorded: ReturnType<GatewayDB["recordBuzzInbound"]> | undefined;
    try {
      recorded = this.db.recordBuzzInbound({
        event: decision.event,
        status,
        statusReason: decision.reason,
        cursorScope: decision.cursorScope,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "endpoint_not_active") {
        return false;
      }
      throw error;
    }
    if (decision.kind === "accepted") {
      if (recorded.kind === "inserted") {
        await this.dispatchAccepted(recorded.id, raw as Event);
      } else if (recorded.status === "received") {
        await this.dispatchAccepted(recorded.id, raw as Event);
      }
    } else if (decision.kind === "control" && recorded.kind === "inserted") {
      if (decision.reason === "owner_shutdown") {
        // Deliberately not awaited: the drain outlives this event handler, and
        // the relay read loop must not block on it.
        void this.beginOwnerShutdown().catch((error) => {
          log.warn("Buzz owner shutdown failed", {
            endpoint_id: this.endpointId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return false;
      }
      await this.onControl?.({
        endpointId: this.endpointId,
        inboundEventId: recorded.id,
        event: decision.event,
      });
    }
    return decision.event.kind === "membership_change";
  }

  private async dispatchAccepted(id: number, event: Event): Promise<void> {
    if (!this.db.transitionInboundEvent(id, "received", "dispatched")) return;
    try {
      const normalizedEvent = this.adapter.normalizeRecorded(event);
      if (!normalizedEvent) {
        this.db.transitionInboundEvent(
          id,
          "dispatched",
          "rejected",
          "stored event can no longer be normalized",
        );
        return;
      }
      const result = await this.onAccepted?.({
        endpointId: this.endpointId,
        inboundEventId: id,
        event,
        normalizedEvent,
      });
      if (result !== "enqueued") {
        this.db.transitionInboundEvent(id, "dispatched", "processed");
      }
    } catch (error) {
      this.db.transitionInboundEvent(
        id,
        "dispatched",
        "interrupted",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async publish(
    client: BuzzRelayClient,
    event: Event,
  ): Promise<import("../capabilities.js").DeliveryResult> {
    try {
      const result = await client.publish(event);
      if (result.accepted || /duplicate|already exists/i.test(result.message)) {
        return { ok: true, externalMessageId: event.id };
      }
      const stalePreparedEvent =
        /timestamp.*(?:too far|old|past)|created_at.*(?:too far|old|past)/i.test(
          result.message,
        );
      return {
        ok: false,
        retriable: false,
        description: `relay rejected event: ${result.message}`,
        ...(stalePreparedEvent ? { refreshPrepared: true } : {}),
      };
    } catch (error) {
      try {
        const found = await client.query(
          [{ ids: [event.id], limit: 1 }],
          this.subscriptionId(`confirm-${event.id.slice(0, 12)}`),
        );
        if (
          found.some(
            (candidate) =>
              isValidInboundEvent(candidate) && candidate.id === event.id,
          )
        ) {
          return { ok: true, externalMessageId: event.id };
        }
      } catch {
        // The original publication failure remains the useful retry reason.
      }
      return {
        ok: false,
        retriable: true,
        description: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private failLiveHandler(client: BuzzRelayClient, error: unknown): void {
    log.warn("Buzz live event handling failed", {
      endpoint_id: this.endpointId,
      error: error instanceof Error ? error.message : String(error),
    });
    client.close();
  }

  private async monitorLifecycle(client: BuzzRelayClient): Promise<void> {
    const heartbeatMs =
      this.normalized.buzzPlatform.subscription.heartbeat_secs * 1000;
    let nextHeartbeatAt = Date.now() + heartbeatMs;
    const heartbeatTrigger = this.adapter.config.triggers.heartbeat;
    const feedTrigger = this.adapter.config.triggers.feed;
    let nextPromptAt = heartbeatTrigger.enabled
      ? Date.now() + heartbeatTrigger.interval_secs! * 1000
      : Number.POSITIVE_INFINITY;
    let nextFeedAt = feedTrigger.enabled
      ? Date.now() + feedTrigger.interval_secs! * 1000
      : Number.POSITIVE_INFINITY;
    while (this.running && this.client === client) {
      const lifecycle = this.db.getEndpointState(
        this.endpointId,
      )?.lifecycleState;
      // An owner shutdown drives `draining` itself and needs the connection to
      // survive until it has published `offline`; every other transition out
      // of `active` closes here as before.
      if (
        lifecycle !== "active" &&
        !(this.ownerShutdownInProgress && lifecycle === "draining")
      ) {
        client.close();
        return;
      }
      if (!this.ingressEnabled) {
        await this.sleep(this.lifecyclePollMs);
        continue;
      }
      const now = Date.now();
      if (now >= nextHeartbeatAt) {
        await client.query(
          discoveryFilters(this.adapter.config.pubkey),
          this.subscriptionId(`heartbeat-${++this.heartbeatSequence}`),
        );
        await this.publishLifecyclePresence();
        nextHeartbeatAt = Date.now() + heartbeatMs;
      }
      if (now >= nextFeedAt) {
        await this.pollConfiguredFeed(client, feedTrigger.modes);
        nextFeedAt = Date.now() + feedTrigger.interval_secs! * 1000;
      }
      if (now >= nextPromptAt) {
        const channelId = heartbeatTrigger.target_channel!;
        if (this.accessibleChannels.has(channelId)) {
          await this.onProactive?.({
            endpointId: this.endpointId,
            channelId,
            prompt: heartbeatTrigger.prompt!,
          });
        }
        nextPromptAt = Date.now() + heartbeatTrigger.interval_secs! * 1000;
      }
      await this.sleep(
        Math.min(
          this.lifecyclePollMs,
          Math.max(
            1,
            Math.min(nextHeartbeatAt, nextFeedAt, nextPromptAt) - Date.now(),
          ),
        ),
      );
    }
  }

  private async pollConfiguredFeed(
    client: BuzzRelayClient,
    modes: readonly ("mentions" | "needs_action")[],
  ): Promise<void> {
    const kinds = [
      ...(modes.includes("mentions")
        ? [BUZZ_KINDS.streamMessageV1, BUZZ_KINDS.streamMessageV2]
        : []),
      ...(modes.includes("needs_action")
        ? [BUZZ_KINDS.workflowApprovalRequested]
        : []),
    ];
    if (kinds.length === 0) return;
    const since = Math.max(
      0,
      Math.floor(Date.now() / 1000) -
        this.adapter.config.triggers.feed.interval_secs! -
        this.normalized.buzzPlatform.subscription.replay_overlap_secs,
    );
    for (const channelId of this.accessibleChannels) {
      const events = await client.query(
        [
          channelFilter({
            channelId,
            kinds,
            pubkey: this.adapter.config.pubkey,
            since,
            limit: this.normalized.buzzPlatform.subscription.historical_limit,
          }),
        ],
        this.subscriptionId(`feed-${channelId}-${Date.now()}`),
      );
      for (const event of events
        .filter(isValidInboundEvent)
        .sort(
          (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
        )) {
        await this.handleRelayEvent(event);
      }
    }
  }

  /**
   * Owner "Stop" (remote-agents invariant I5): drain, announce offline, and
   * stay down. `disabled` is durable in the endpoints table and survives a
   * process restart, so coming back up is an explicit operator action
   * (`torana endpoints resume`) or a provider deploy — never automatic.
   */
  private async beginOwnerShutdown(): Promise<void> {
    if (this.ownerShutdownInProgress) return;
    log.info("Buzz owner shutdown requested", {
      endpoint_id: this.endpointId,
      agent_id: this.agentId,
    });
    await this.drainAndAnnounceOffline(OWNER_SHUTDOWN);
    this.db.setEndpointLifecycle(this.endpointId, "disabled", OWNER_SHUTDOWN);
    this.state = "disabled";
    this.client?.close();
    log.info("Buzz endpoint stopped by owner", {
      endpoint_id: this.endpointId,
    });
  }

  /**
   * Stop taking work, let in-flight turns finish, then say goodbye while the
   * connection is still up.
   *
   * The ordering is the whole point. Announcing `offline` after the socket is
   * gone is impossible, and skipping it leaves a stopped agent showing online
   * until the relay's 180 s TTL lapses. Callers set the terminal lifecycle
   * state themselves, because "stopped by its owner" and "deleted by its
   * provider" are different facts about the same endpoint.
   */
  async drainAndAnnounceOffline(reason: string): Promise<void> {
    if (this.ownerShutdownInProgress) return;
    this.ownerShutdownInProgress = true;
    try {
      // Intake stops first so nothing new is accepted while we drain, and the
      // lifecycle row shows `draining` to any operator looking at it.
      await this.stopIngress();
      this.db.setEndpointLifecycle(this.endpointId, "draining", reason);
      this.state = "draining";

      const deadline = Date.now() + this.ownerShutdownDrainMs;
      while (Date.now() < deadline) {
        const backlog = this.db.endpointBacklog(this.endpointId);
        if (backlog.running === 0) break;
        await this.sleep(Math.min(this.lifecyclePollMs, 250));
      }
      const remaining = this.db.endpointBacklog(this.endpointId);
      if (remaining.running > 0) {
        log.warn("Buzz endpoint drain timed out", {
          endpoint_id: this.endpointId,
          reason,
          running: remaining.running,
          drain_ms: this.ownerShutdownDrainMs,
        });
      }

      if (!this.outboundOnly) {
        await this.adapter
          .signal(this.signalConversation(), {
            kind: "presence",
            state: "offline",
          })
          .catch(() => false);
      }
    } finally {
      this.ownerShutdownInProgress = false;
    }
  }

  /**
   * Publish the supervisor's own presence refresh — the only signal a Buzz
   * client reads to decide whether this agent is online. The relay expires
   * presence 180 s after the last accepted publish, so a run of failures is a
   * countdown to a healthy agent showing offline, and is treated as a health
   * problem well before the TTL can lapse rather than as a silent no-op.
   */
  private async publishLifecyclePresence(): Promise<BuzzSignalOutcome> {
    this.presence.attempted += 1;
    const outcome = await this.adapter
      .signalDetailed(this.signalConversation(), {
        kind: "presence",
        state: "online",
        lifecycle: true,
      })
      .catch((): BuzzSignalOutcome => "failed");

    if (outcome === "suppressed") {
      // Unreachable while the lifecycle exemption holds. Counted rather than
      // ignored so a regression shows up in metrics instead of as an
      // intermittently offline agent.
      this.presence.suppressed += 1;
      log.warn("Buzz lifecycle presence was rate-limited", {
        endpoint_id: this.endpointId,
      });
      return outcome;
    }

    if (outcome === "published") {
      this.presence.consecutiveFailures = 0;
      this.presence.lastPublishedAt = Date.now();
      if (this.presence.stale) {
        this.presence.stale = false;
        this.alertedPresenceStale = false;
        if (this.state === "unhealthy" && this.lastError === PRESENCE_STALE) {
          this.state = "healthy";
          this.lastError = null;
        }
        log.info("Buzz presence recovered", { endpoint_id: this.endpointId });
      }
      return outcome;
    }

    this.presence.failed += 1;
    this.presence.consecutiveFailures += 1;
    const threshold = this.presenceFailureThreshold();
    log.warn("Buzz presence publish failed", {
      endpoint_id: this.endpointId,
      consecutive_failures: this.presence.consecutiveFailures,
      threshold,
    });
    if (this.presence.consecutiveFailures >= threshold) {
      this.presence.stale = true;
      this.state = "unhealthy";
      this.lastError = PRESENCE_STALE;
      if (!this.alertedPresenceStale) {
        this.alertedPresenceStale = true;
        void this.alerts?.workerDegraded(
          this.agentId,
          `Buzz endpoint ${this.endpointId} failed ${this.presence.consecutiveFailures} consecutive presence publishes; clients will show it offline once the relay's presence TTL lapses`,
        );
      }
    }
    return outcome;
  }

  private presenceFailureThreshold(): number {
    return this.normalized.limits.presence_failure_threshold;
  }

  private maybeAlertDisconnected(): boolean {
    if (!this.disconnectedSince) return false;
    const elapsed = Date.now() - this.disconnectedSince;
    if (elapsed < this.normalized.limits.reconnect_alert_after_secs * 1000)
      return false;
    if (this.alertedDisconnected) return true;
    this.alertedDisconnected = true;
    void this.alerts?.workerDegraded(
      this.agentId,
      `Buzz endpoint ${this.endpointId} disconnected for ${Math.floor(elapsed / 1000)}s`,
    );
    return true;
  }

  private subscriptionId(suffix: string): string {
    return `torana-${this.endpointId}-${suffix}`.slice(0, 120);
  }

  private signalConversation(): import("../types.js").ConversationRef {
    return {
      platform: "buzz",
      communityId: this.endpoint.communityId,
      endpointId: this.endpointId,
      channelId:
        this.accessibleChannels.values().next().value ??
        "00000000-0000-4000-8000-000000000000",
      threadRootId: null,
      workflowRunId: null,
      type: "stream",
    };
  }

  private workflowKinds(): number[] {
    return this.adapter.config.triggers.workflows.enabled
      ? [...this.adapter.config.triggers.workflows.event_kinds]
      : [];
  }

  private channelSubscriptionId(channelId: string): string {
    return this.subscriptionId(`channel-${channelId}`);
  }

  private async sleep(ms: number): Promise<void> {
    if (!this.running) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.sleepResolvers.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.sleepResolvers.add(finish);
    });
  }
}

export async function probeBuzzEndpoint(args: {
  endpoint: NormalizedEndpointConfig;
  normalized: NormalizedConfigModel;
  clientFactory?: BuzzTransportOptions["clientFactory"];
}): Promise<{ channels: string[]; authenticated: true }> {
  const config = args.endpoint.buzz;
  if (!config) throw new Error("not a Buzz endpoint");
  if (!args.normalized.buzzPlatform || !args.normalized.limits) {
    throw new Error("Buzz probe requires normalized Phase 4 limits");
  }
  const factory =
    args.clientFactory ?? ((options) => new BuzzRelayClient(options));
  const client = factory({
    relayUrl: config.relayUrl,
    privateKey: config.privateKey,
    authTag: config.authTag,
    maxFrameBytes: args.normalized.buzzPlatform.max_frame_bytes,
    waitMs: args.normalized.limits.relay_ok_wait_ms,
  });
  try {
    await client.connect();
    const events = await client.query(
      discoveryFilters(config.pubkey),
      `torana-doctor-${args.endpoint.id}-${Date.now()}`.slice(0, 120),
    );
    return {
      authenticated: true,
      channels: discoverChannelIds(events.filter(isValidInboundEvent)),
    };
  } finally {
    client.close();
  }
}
