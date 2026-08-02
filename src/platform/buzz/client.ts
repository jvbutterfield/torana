import type { Event, Filter } from "nostr-tools";
import {
  buildAuthEvent,
  decodeSecret,
  parseOwnerAuthTag,
  type OwnerAuthTag,
} from "./protocol.js";

type RelayFrame = [string, ...unknown[]];

interface PendingQuery {
  events: unknown[];
  resolve: (events: unknown[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingOk {
  resolve: (result: { accepted: boolean; message: string }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BuzzRelayClientOptions {
  relayUrl: string;
  privateKey: string;
  authTag?: string | null;
  maxFrameBytes: number;
  waitMs?: number;
  onInvalidFrame?: (reason: string) => void;
}

export class BuzzRelayClient {
  readonly relayUrl: string;
  private secret: Uint8Array;
  private ownerAuthTag?: OwnerAuthTag;
  private maxFrameBytes: number;
  private waitMs: number;
  private onInvalidFrame?: (reason: string) => void;
  private socket: WebSocket | null = null;
  private pendingChallenge: string | null = null;
  private challengeResolve: ((challenge: string) => void) | null = null;
  private challengeReject: ((error: Error) => void) | null = null;
  private queries = new Map<string, PendingQuery>();
  private okWaiters = new Map<string, PendingOk>();
  private liveHandlers = new Map<string, (event: unknown) => void>();
  private closedPromise: Promise<void> = Promise.resolve();
  private closedResolve: (() => void) | null = null;
  private closeError: Error | null = null;

  constructor(opts: BuzzRelayClientOptions) {
    this.relayUrl = opts.relayUrl;
    this.secret = decodeSecret(opts.privateKey);
    this.ownerAuthTag = parseOwnerAuthTag(opts.authTag ?? undefined);
    this.maxFrameBytes = opts.maxFrameBytes;
    this.waitMs = opts.waitMs ?? 5000;
    this.onInvalidFrame = opts.onInvalidFrame;
  }

  async connect(): Promise<Event> {
    if (this.socket) throw new Error("relay client is already connected");
    const socket = new WebSocket(this.relayUrl);
    this.socket = socket;
    this.closeError = null;
    this.pendingChallenge = null;
    this.closedPromise = new Promise<void>((resolve) => {
      this.closedResolve = resolve;
    });
    socket.onmessage = (message) => this.handleRawFrame(message.data);
    socket.onclose = (event) => {
      const error = new Error(
        `relay connection closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`,
      );
      this.failPending(error);
      this.socket = null;
      if (event.code !== 1000) this.closeError = error;
      this.closedResolve?.();
      this.closedResolve = null;
    };
    socket.onerror = () => {
      if (socket.readyState === WebSocket.CONNECTING) {
        this.challengeReject?.(
          new Error(`failed to connect to ${this.relayUrl}`),
        );
      }
    };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out opening relay connection")),
        this.waitMs,
      );
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`failed to connect to ${this.relayUrl}`));
      };
    });

    const challenge =
      this.pendingChallenge ??
      (await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.challengeResolve = null;
          this.challengeReject = null;
          reject(new Error("relay did not issue a NIP-42 challenge"));
        }, this.waitMs);
        this.challengeResolve = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        this.challengeReject = (error) => {
          clearTimeout(timer);
          reject(error);
        };
      }));
    this.pendingChallenge = null;
    this.challengeResolve = null;
    this.challengeReject = null;
    const auth = buildAuthEvent({
      relayUrl: this.relayUrl,
      challenge,
      secret: this.secret,
      ownerAuthTag: this.ownerAuthTag,
    });
    const accepted = this.waitForOk(auth.id);
    this.send(["AUTH", auth]);
    const result = await accepted;
    if (!result.accepted) {
      this.close();
      throw new Error(
        `relay rejected NIP-42 authentication: ${result.message}`,
      );
    }
    return auth;
  }

  async query(filters: Filter[], subscriptionId: string): Promise<unknown[]> {
    if (
      this.queries.has(subscriptionId) ||
      this.liveHandlers.has(subscriptionId)
    ) {
      throw new Error(`duplicate relay subscription id '${subscriptionId}'`);
    }
    const result = new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queries.delete(subscriptionId);
        reject(new Error(`timed out waiting for EOSE on ${subscriptionId}`));
      }, this.waitMs);
      this.queries.set(subscriptionId, { events: [], resolve, reject, timer });
    });
    this.send(["REQ", subscriptionId, ...filters]);
    try {
      return await result;
    } finally {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.send(["CLOSE", subscriptionId]);
      }
    }
  }

  subscribe(
    subscriptionId: string,
    filters: Filter[],
    onEvent: (event: unknown) => void,
  ): void {
    if (
      this.queries.has(subscriptionId) ||
      this.liveHandlers.has(subscriptionId)
    ) {
      throw new Error(`duplicate relay subscription id '${subscriptionId}'`);
    }
    this.liveHandlers.set(subscriptionId, onEvent);
    this.send(["REQ", subscriptionId, ...filters]);
  }

  closeSubscription(subscriptionId: string): void {
    if (!this.liveHandlers.delete(subscriptionId)) return;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send(["CLOSE", subscriptionId]);
    }
  }

  async publish(event: Event): Promise<{ accepted: boolean; message: string }> {
    const result = this.waitForOk(event.id);
    this.send(["EVENT", event]);
    return await result;
  }

  async waitUntilClosed(): Promise<void> {
    await this.closedPromise;
    if (this.closeError) throw this.closeError;
  }

  close(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    this.failPending(new Error("relay client closed"));
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close(1000, "gateway shutdown");
    }
  }

  private waitForOk(
    eventId: string,
  ): Promise<{ accepted: boolean; message: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.okWaiters.delete(eventId);
        reject(new Error(`timed out waiting for relay OK for ${eventId}`));
      }, this.waitMs);
      this.okWaiters.set(eventId, { resolve, reject, timer });
    });
  }

  private send(frame: RelayFrame): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("relay is not connected");
    }
    this.socket.send(JSON.stringify(frame));
  }

  private handleRawFrame(raw: unknown): void {
    const text = typeof raw === "string" ? raw : String(raw);
    if (new TextEncoder().encode(text).byteLength > this.maxFrameBytes) {
      this.onInvalidFrame?.("frame_too_large");
      return;
    }
    let frame: RelayFrame;
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed) || typeof parsed[0] !== "string") {
        throw new Error("not a relay frame");
      }
      frame = parsed as RelayFrame;
    } catch {
      this.onInvalidFrame?.("malformed_json_frame");
      return;
    }

    if (frame[0] === "AUTH") {
      if (typeof frame[1] !== "string") {
        this.challengeReject?.(
          new Error("relay sent malformed AUTH challenge"),
        );
      } else {
        if (this.challengeResolve) this.challengeResolve(frame[1]);
        else this.pendingChallenge = frame[1];
      }
      return;
    }
    if (frame[0] === "OK" && typeof frame[1] === "string") {
      const waiter = this.okWaiters.get(frame[1]);
      if (!waiter) return;
      this.okWaiters.delete(frame[1]);
      clearTimeout(waiter.timer);
      waiter.resolve({
        accepted: frame[2] === true,
        message: String(frame[3] ?? ""),
      });
      return;
    }
    if (frame[0] === "EVENT" && typeof frame[1] === "string") {
      const query = this.queries.get(frame[1]);
      if (query) query.events.push(frame[2]);
      else this.liveHandlers.get(frame[1])?.(frame[2]);
      return;
    }
    if (frame[0] === "EOSE" && typeof frame[1] === "string") {
      const query = this.queries.get(frame[1]);
      if (!query) return;
      this.queries.delete(frame[1]);
      clearTimeout(query.timer);
      query.resolve(query.events);
      return;
    }
    if (frame[0] === "CLOSED" && typeof frame[1] === "string") {
      const query = this.queries.get(frame[1]);
      if (query) {
        this.queries.delete(frame[1]);
        clearTimeout(query.timer);
        query.reject(
          new Error(`subscription closed: ${String(frame[2] ?? "")}`),
        );
      }
      this.liveHandlers.delete(frame[1]);
    }
  }

  private failPending(error: Error): void {
    this.challengeReject?.(error);
    for (const [id, query] of this.queries) {
      clearTimeout(query.timer);
      query.reject(error);
      this.queries.delete(id);
    }
    for (const [id, waiter] of this.okWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.okWaiters.delete(id);
    }
    this.liveHandlers.clear();
  }
}
