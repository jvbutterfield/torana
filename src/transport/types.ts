import type { BotId } from "../config/schema.js";
import type { TelegramUpdate } from "../telegram/types.js";

export type TransportKind = "webhook" | "polling";

export type OnUpdateHandler = (
  botId: BotId,
  update: TelegramUpdate,
) => Promise<void>;

export interface Transport {
  readonly kind: TransportKind;
  readonly botIds: readonly BotId[];
  start(onUpdate: OnUpdateHandler): Promise<void>;
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
