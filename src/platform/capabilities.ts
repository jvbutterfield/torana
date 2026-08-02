import type { Config } from "../config/schema.js";
import type {
  ConversationRef,
  EphemeralSignal,
  InboundEvent,
  LocalAttachment,
  OutboundOperation,
  PlatformKind,
} from "./types.js";

export type EndpointCapability =
  | OutboundOperation["kind"]
  | EphemeralSignal["kind"]
  | "attachment_download";

export interface MessagingEndpoint {
  id: string;
  agentId: string;
  platform: PlatformKind;
  communityId: string | null;
  capabilities: ReadonlySet<EndpointCapability>;
}

export type DeliveryResult =
  | { ok: true; externalMessageId?: string }
  | {
      ok: false;
      retriable: boolean;
      description: string;
      retryAfterMs?: number;
      notModified?: boolean;
    };

export interface MaterializedAttachments {
  attachments: LocalAttachment[];
  errors: string[];
}

export interface PreparedOutboundOperation {
  payloadJson?: string;
  signedPayloadJson?: string | null;
  signedEventId?: string | null;
}

export interface PlatformAdapter<RawInbound = unknown> {
  readonly endpoint: MessagingEndpoint;
  normalizeInbound(raw: RawInbound): InboundEvent | null;
  deliver(
    conversation: ConversationRef,
    operation: OutboundOperation,
    prepared?: PreparedOutboundOperation,
  ): Promise<DeliveryResult>;
  prepareOutbound?(
    conversation: ConversationRef,
    operation: OutboundOperation,
  ): PreparedOutboundOperation;
  signal(
    conversation: ConversationRef,
    signal: EphemeralSignal,
  ): Promise<boolean>;
  materializeAttachments(
    event: InboundEvent,
    config: Config,
  ): Promise<MaterializedAttachments>;
}

export function supports(
  adapter: PlatformAdapter,
  capability: EndpointCapability,
): boolean {
  return adapter.endpoint.capabilities.has(capability);
}
