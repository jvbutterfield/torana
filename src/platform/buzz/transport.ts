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
import { BuzzAdapter } from "./adapter.js";
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
  adapters?: ReadonlyMap<string, PlatformAdapter>;
  clientFactory?: (
    options: ConstructorParameters<typeof BuzzRelayClient>[0],
  ) => BuzzRelayClient;
  random?: () => number;
  lifecyclePollMs?: number;
}

export class BuzzTransport implements Transport {
  readonly kind = "buzz" as const;
  readonly botIds: readonly string[];
  private supervisors: BuzzEndpointSupervisor[];

  constructor(opts: BuzzTransportOptions) {
    this.supervisors = opts.endpoints
      .filter((endpoint) => endpoint.platform === "buzz" && endpoint.buzz)
      .map((endpoint) => new BuzzEndpointSupervisor({ ...opts, endpoint }));
    this.botIds = this.supervisors.map((item) => item.agentId);
  }

  async start(_onUpdate: OnUpdateHandler): Promise<void> {
    for (const supervisor of this.supervisors) supervisor.start();
  }

  async stop(): Promise<void> {
    await Promise.all(this.supervisors.map((item) => item.stop()));
  }

  snapshots(): BuzzEndpointHealth[] {
    return this.supervisors.map((item) => item.snapshot());
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
  private clientFactory: NonNullable<BuzzTransportOptions["clientFactory"]>;
  private random: () => number;
  private lifecyclePollMs: number;
  private client: BuzzRelayClient | null = null;
  private running = false;
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

  constructor(opts: SupervisorOptions) {
    this.endpoint = opts.endpoint;
    this.endpointId = opts.endpoint.id;
    this.agentId = opts.endpoint.agentId;
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
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.adapter
      .signal(this.signalConversation(), { kind: "presence", state: "offline" })
      .catch(() => false);
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
        await this.adapter.signal(this.signalConversation(), {
          kind: "presence",
          state: "online",
        });
        await this.recoverAcceptedEvents();
        this.subscribeMembership(client);
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
      discovered.size === 0
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
    for (const channel of initial ? [...discovered] : added) {
      await this.drainAndSubscribeChannel(client, channel);
    }
  }

  private subscribeMembership(client: BuzzRelayClient): void {
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
    if (this.activeChannelSubscriptions.has(channelId)) return;
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
      return {
        ok: false,
        retriable: false,
        description: `relay rejected event: ${result.message}`,
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
    while (this.running && this.client === client) {
      const lifecycle = this.db.getEndpointState(
        this.endpointId,
      )?.lifecycleState;
      if (lifecycle !== "active") {
        client.close();
        return;
      }
      const now = Date.now();
      if (now >= nextHeartbeatAt) {
        await client.query(
          discoveryFilters(this.adapter.config.pubkey),
          this.subscriptionId(`heartbeat-${++this.heartbeatSequence}`),
        );
        await this.adapter.signal(this.signalConversation(), {
          kind: "presence",
          state: "online",
        });
        nextHeartbeatAt = Date.now() + heartbeatMs;
      }
      await this.sleep(
        Math.min(
          this.lifecyclePollMs,
          Math.max(1, nextHeartbeatAt - Date.now()),
        ),
      );
    }
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
