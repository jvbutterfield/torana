import type { Event, Filter } from "nostr-tools";
import {
  BUZZ_KINDS,
  EventDeduper,
  buildAuthEvent,
  buildThreadedReply,
  channelFilter,
  discoverChannelIds,
  discoveryFilters,
  isValidInboundEvent,
  publicKey,
  type OwnerAuthTag,
} from "./protocol";

type RelayFrame = [string, ...unknown[]];

export type PublishResult = { accepted: boolean; message: string };

export class BuzzSpikeClient {
  readonly #relayUrl: string;
  readonly #secret: Uint8Array;
  readonly #ownerAuthTag?: OwnerAuthTag;
  #socket?: WebSocket;
  #queue: RelayFrame[] = [];
  #waiters: Array<(frame: RelayFrame) => void> = [];

  constructor(
    relayUrl: string,
    secret: Uint8Array,
    ownerAuthTag?: OwnerAuthTag,
  ) {
    this.#relayUrl = relayUrl;
    this.#secret = secret;
    this.#ownerAuthTag = ownerAuthTag;
  }

  get pubkey(): string {
    return publicKey(this.#secret);
  }

  async connect(): Promise<Event> {
    const socket = new WebSocket(this.#relayUrl);
    this.#socket = socket;
    socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data)) as RelayFrame;
      const waiter = this.#waiters.shift();
      if (waiter) waiter(frame);
      else this.#queue.push(frame);
    };
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () =>
        reject(new Error(`failed to connect to ${this.#relayUrl}`));
    });

    const challenge = await this.#nextMatching((frame) => frame[0] === "AUTH");
    if (typeof challenge[1] !== "string")
      throw new Error("relay sent malformed AUTH challenge");
    const auth = buildAuthEvent({
      relayUrl: this.#relayUrl,
      challenge: challenge[1],
      secret: this.#secret,
      ownerAuthTag: this.#ownerAuthTag,
    });
    socket.send(JSON.stringify(["AUTH", auth]));
    const ok = await this.#waitForOk(auth.id);
    if (!ok.accepted)
      throw new Error(`relay rejected NIP-42 authentication: ${ok.message}`);
    return auth;
  }

  close(): void {
    this.#socket?.close();
    this.#socket = undefined;
    this.#queue = [];
    this.#waiters = [];
  }

  async query(filters: Filter[], subscriptionId: string): Promise<Event[]> {
    this.#send(["REQ", subscriptionId, ...filters]);
    const events: Event[] = [];
    while (true) {
      const frame = await this.#nextMatching(
        (candidate) =>
          (candidate[0] === "EVENT" && candidate[1] === subscriptionId) ||
          (candidate[0] === "EOSE" && candidate[1] === subscriptionId) ||
          (candidate[0] === "CLOSED" && candidate[1] === subscriptionId),
      );
      if (frame[0] === "EOSE") return events;
      if (frame[0] === "CLOSED")
        throw new Error(`subscription closed: ${String(frame[2])}`);
      const event = frame[2] as Event;
      if (!isValidInboundEvent(event))
        throw new Error(`invalid event received: ${event.id}`);
      events.push(event);
    }
  }

  async discoverChannels(): Promise<string[]> {
    const memberships = await this.query(
      discoveryFilters(this.pubkey),
      "phase0-discovery",
    );
    return discoverChannelIds(memberships);
  }

  async receiveMention(channelId: string, since?: number): Promise<Event> {
    const events = await this.query(
      [
        channelFilter({
          channelId,
          pubkey: this.pubkey,
          kinds: [BUZZ_KINDS.streamMessageV1, BUZZ_KINDS.streamMessageV2],
          since,
        }),
      ],
      `phase0-channel-${channelId}`,
    );
    const mention = events.find((event) =>
      event.tags.some((tag) => tag[0] === "p" && tag[1] === this.pubkey),
    );
    if (!mention) throw new Error(`no mention found in channel ${channelId}`);
    return mention;
  }

  buildReply(channelId: string, mention: Event, content: string): Event {
    const root = mention.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "root",
    )?.[1];
    return buildThreadedReply({
      channelId,
      content,
      replyTo: mention.id,
      rootId: root,
      mentionPubkey: mention.pubkey,
      secret: this.#secret,
      ownerAuthTag: this.#ownerAuthTag,
    });
  }

  async publish(event: Event): Promise<PublishResult> {
    this.#send(["EVENT", event]);
    return this.#waitForOk(event.id);
  }

  #send(frame: RelayFrame): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN)
      throw new Error("relay is not connected");
    this.#socket.send(JSON.stringify(frame));
  }

  async #waitForOk(eventId: string): Promise<PublishResult> {
    const frame = await this.#nextMatching(
      (candidate) => candidate[0] === "OK" && candidate[1] === eventId,
    );
    return { accepted: frame[2] === true, message: String(frame[3] ?? "") };
  }

  async #nextMatching(
    predicate: (frame: RelayFrame) => boolean,
  ): Promise<RelayFrame> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const queuedIndex = this.#queue.findIndex(predicate);
      if (queuedIndex >= 0) return this.#queue.splice(queuedIndex, 1)[0];
      const remaining = deadline - Date.now();
      const frame = await Promise.race([
        new Promise<RelayFrame>((resolve) => this.#waiters.push(resolve)),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), remaining),
        ),
      ]);
      if (!frame) break;
      if (predicate(frame)) return frame;
      this.#queue.push(frame);
    }
    throw new Error("timed out waiting for relay frame");
  }
}

export async function proveReconnectAndDedup(args: {
  relayUrl: string;
  secret: Uint8Array;
  ownerAuthTag?: OwnerAuthTag;
  channelId: string;
}): Promise<{ first: Event; replay: Event; duplicateRejected: boolean }> {
  const deduper = new EventDeduper();
  const firstClient = new BuzzSpikeClient(
    args.relayUrl,
    args.secret,
    args.ownerAuthTag,
  );
  await firstClient.connect();
  const first = await firstClient.receiveMention(args.channelId);
  deduper.accept(first);
  firstClient.close();

  const secondClient = new BuzzSpikeClient(
    args.relayUrl,
    args.secret,
    args.ownerAuthTag,
  );
  await secondClient.connect();
  const replay = await secondClient.receiveMention(
    args.channelId,
    first.created_at - 5,
  );
  const duplicateRejected = !deduper.accept(replay);
  secondClient.close();
  return { first, replay, duplicateRejected };
}
