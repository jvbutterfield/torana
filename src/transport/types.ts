import type { BotId } from "../config/schema.js";
import type { TelegramUpdate } from "../telegram/types.js";
export type TransportKind = "webhook" | "polling" | "buzz";

export type OnUpdateHandler = (
  endpointOrAgentId: BotId,
  update: TelegramUpdate,
) => Promise<void>;

export interface Transport {
  readonly kind: TransportKind;
  readonly botIds: readonly BotId[];
  start(onUpdate: OnUpdateHandler): Promise<void>;
  /** Stop new inbound work while preserving any outbound connection. */
  stopIngress(): Promise<void>;
  /** Fully close the transport after accepted work and outbox delivery drain. */
  stop(): Promise<void>;
}

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD";

/** In-process HTTP router contract. server.ts implements this; transports consume it. */
export interface HttpRouter {
  route(method: HttpMethod, path: string, handler: RouteHandler): Unregister;
  setFallback(handler: (req: Request) => Promise<Response>): void;
  setErrorHandler(
    handler: (err: unknown, req: Request) => Promise<Response>,
  ): void;
}

export type RouteHandler = (
  req: Request,
  params: Record<string, string>,
) => Promise<Response>;

export type Unregister = () => void;
