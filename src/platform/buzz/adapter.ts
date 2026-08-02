import type { Event } from "nostr-tools";
import type { Config } from "../../config/schema.js";
import type {
  NormalizedBuzzRuntimeConfig,
  NormalizedEndpointConfig,
} from "../../config/v2.js";
import type {
  DeliveryResult,
  MessagingEndpoint,
  PlatformAdapter,
  PreparedOutboundOperation,
} from "../capabilities.js";
import type {
  ConversationRef,
  InboundEvent,
  OutboundOperation,
  RemoteAttachment,
} from "../types.js";
import {
  allTags,
  type BuzzChannelMetadata,
  BUZZ_KINDS,
  decodeSecret,
  DEFAULT_MESSAGE_KINDS,
  DEFAULT_MUTATION_KINDS,
  firstTag,
  isValidInboundEvent,
  parseOwnerAuthTag,
  signTemplate,
} from "./protocol.js";

const BUZZ_PHASE5_CAPABILITIES = new Set(["send", "presence"] as const);
const CHANNEL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BuzzInboundDecision =
  | {
      kind: "accepted" | "control" | "rejected";
      event: InboundEvent;
      reason: string | null;
      cursorScope: string;
    }
  | { kind: "malformed"; reason: string }
  | {
      kind: "irrelevant";
      reason: string;
      checkpoint?: { cursorScope: string; createdAt: number; eventId: string };
    };

export class BuzzAdapter implements PlatformAdapter<Event> {
  readonly endpoint: MessagingEndpoint;
  readonly config: NormalizedBuzzRuntimeConfig;
  private channels = new Map<string, BuzzChannelMetadata>();
  private publisher: ((event: Event) => Promise<DeliveryResult>) | null = null;

  constructor(endpoint: NormalizedEndpointConfig) {
    if (endpoint.platform !== "buzz" || !endpoint.buzz) {
      throw new Error("BuzzAdapter requires a normalized Buzz endpoint");
    }
    this.config = endpoint.buzz;
    this.endpoint = {
      id: endpoint.id,
      agentId: endpoint.agentId,
      platform: "buzz",
      communityId: endpoint.communityId,
      capabilities: BUZZ_PHASE5_CAPABILITIES,
    };
  }

  setChannels(channels: ReadonlyMap<string, BuzzChannelMetadata>): void {
    this.channels = new Map(channels);
  }

  channelMetadata(channelId: string): BuzzChannelMetadata | null {
    return this.channels.get(channelId) ?? null;
  }

  setPublisher(
    publisher: ((event: Event) => Promise<DeliveryResult>) | null,
  ): void {
    this.publisher = publisher;
  }

  normalizeInbound(raw: Event): InboundEvent | null {
    const decision = this.evaluateInbound(
      raw,
      new Set([firstTag(raw, "h") ?? ""]),
    );
    return decision.kind === "accepted" || decision.kind === "control"
      ? decision.event
      : null;
  }

  normalizeRecorded(event: Event): InboundEvent | null {
    const channelId = firstTag(event, "h");
    return channelId && CHANNEL_ID.test(channelId)
      ? this.toInboundEvent(event, channelId)
      : null;
  }

  evaluateInbound(
    raw: unknown,
    accessibleChannels: ReadonlySet<string>,
  ): BuzzInboundDecision {
    if (!isValidInboundEvent(raw)) {
      return { kind: "malformed", reason: "invalid_event_or_signature" };
    }
    const event = raw;
    const channelId = firstTag(event, "h");
    const membershipEvent =
      event.kind === BUZZ_KINDS.memberAdded ||
      event.kind === BUZZ_KINDS.memberRemoved;
    if (!channelId || !CHANNEL_ID.test(channelId)) {
      return {
        kind: "malformed",
        reason: membershipEvent
          ? "malformed_membership_channel"
          : "missing_channel",
      };
    }
    const cursorScope = membershipEvent
      ? "membership"
      : `channel:${channelId}:messages`;
    const checkpoint = {
      cursorScope,
      createdAt: event.created_at,
      eventId: event.id,
    };
    if (event.pubkey === this.config.pubkey) {
      return { kind: "irrelevant", reason: "self_event", checkpoint };
    }
    if (membershipEvent && !allTags(event, "p").includes(this.config.pubkey)) {
      return {
        kind: "irrelevant",
        reason: "membership_for_other_identity",
        checkpoint,
      };
    }

    const normalized = this.toInboundEvent(event, channelId);
    if (membershipEvent) {
      return {
        kind: "control",
        event: normalized,
        reason: null,
        cursorScope,
      };
    }

    if (!accessibleChannels.has(channelId)) {
      return {
        kind: "rejected",
        event: normalized,
        reason: "channel_not_accessible",
        cursorScope,
      };
    }

    const override = this.config.channelOverrides[channelId];
    const allowedKinds = override?.kinds;
    const isMessage = (DEFAULT_MESSAGE_KINDS as readonly number[]).includes(
      event.kind,
    );
    const isMutation = (DEFAULT_MUTATION_KINDS as readonly number[]).includes(
      event.kind,
    );
    if (
      (!isMessage && !isMutation) ||
      (allowedKinds && !allowedKinds.includes(event.kind))
    ) {
      return {
        kind: "irrelevant",
        reason: "unsupported_or_disabled_kind",
        checkpoint,
      };
    }
    if (isMutation) {
      return {
        kind: "control",
        event: normalized,
        reason: null,
        cursorScope,
      };
    }

    if (!this.authorAllowed(event.pubkey)) {
      return {
        kind: "rejected",
        event: normalized,
        reason: "unauthorized_author",
        cursorScope,
      };
    }
    const mentioned = allTags(event, "p").includes(this.config.pubkey);
    const channelType = this.channels.get(channelId)?.type ?? "stream";
    const isReply = allTags(event, "e").length > 0;
    const ownerCommand =
      event.pubkey === this.config.ownerPubkey &&
      /^!(?:cancel|rotate|status|health)(?:\s|$)/i.test(event.content.trim());
    if (
      /^!(?:cancel|rotate|status|health)(?:\s|$)/i.test(event.content.trim()) &&
      event.pubkey !== this.config.ownerPubkey
    ) {
      return {
        kind: "rejected",
        event: normalized,
        reason: "owner_control_required",
        cursorScope,
      };
    }
    const requireMention = override?.requireMention ?? true;
    // Without a relay-provided human/agent principal registry, a non-owner
    // author is conservatively treated as potentially agent-authored. That
    // preserves the tag-independent loop rule: only an explicit mention can
    // trigger another agent.
    if (
      !mentioned &&
      !ownerCommand &&
      !(channelType === "dm" && event.pubkey === this.config.ownerPubkey) &&
      (requireMention || event.pubkey !== this.config.ownerPubkey)
    ) {
      return {
        kind: "rejected",
        event: normalized,
        reason: "mention_required",
        cursorScope,
      };
    }
    // A sibling can delegate with a top-level direct p-tag. Its generated
    // threaded answer necessarily p-tags the original author for NIP-10
    // context, but that reply must not recursively wake the sibling again.
    // Owner-authored replies remain eligible for normal human conversation.
    if (event.pubkey !== this.config.ownerPubkey && mentioned && isReply) {
      return {
        kind: "rejected",
        event: normalized,
        reason: "agent_reply_not_triggering",
        cursorScope,
      };
    }
    return {
      kind: "accepted",
      event: normalized,
      reason: null,
      cursorScope,
    };
  }

  prepareOutbound(
    conversation: ConversationRef,
    operation: OutboundOperation,
  ): PreparedOutboundOperation {
    if (operation.kind !== "send") {
      return { payloadJson: JSON.stringify(operation) };
    }
    const tags: string[][] = [["h", conversation.channelId]];
    if (operation.replyTo) {
      const root = conversation.threadRootId;
      if (root && root !== operation.replyTo) {
        tags.push(["e", root, "", "root"]);
      }
      tags.push(["e", operation.replyTo, "", "reply"]);
    }
    for (const pubkey of [...new Set(operation.mentions ?? [])]) {
      if (/^[0-9a-f]{64}$/.test(pubkey)) tags.push(["p", pubkey]);
    }
    if (operation.traceId) tags.push(["torana-trace", operation.traceId]);
    if (operation.hop !== undefined) {
      tags.push(["torana-hop", String(operation.hop)]);
    }
    const signed = signTemplate(
      {
        kind: BUZZ_KINDS.streamMessageV1,
        created_at: Math.floor(Date.now() / 1000),
        content: operation.text,
        tags,
      },
      decodeSecret(this.config.privateKey),
      parseOwnerAuthTag(this.config.authTag ?? undefined),
    );
    return {
      payloadJson: JSON.stringify(operation),
      signedPayloadJson: JSON.stringify(signed),
      signedEventId: signed.id,
    };
  }

  async deliver(
    _conversation: ConversationRef,
    operation: OutboundOperation,
    prepared?: PreparedOutboundOperation,
  ): Promise<DeliveryResult> {
    if (operation.kind !== "send") {
      return {
        ok: false,
        retriable: false,
        description: `Buzz ${operation.kind} delivery begins after Phase 5`,
      };
    }
    if (!prepared?.signedPayloadJson || !prepared.signedEventId) {
      return {
        ok: false,
        retriable: false,
        description: "Buzz outbox row is missing its persisted signed event",
      };
    }
    let event: unknown;
    try {
      event = JSON.parse(prepared.signedPayloadJson);
    } catch {
      event = null;
    }
    if (
      !isValidInboundEvent(event) ||
      event.id !== prepared.signedEventId ||
      event.pubkey !== this.config.pubkey
    ) {
      return {
        ok: false,
        retriable: false,
        description: "Buzz outbox signed event failed local verification",
      };
    }
    if (!this.publisher) {
      return {
        ok: false,
        retriable: true,
        description: "Buzz relay is not connected",
      };
    }
    return await this.publisher(event);
  }

  async signal(): Promise<boolean> {
    return false;
  }

  async materializeAttachments(_event: InboundEvent, _config: Config) {
    return { attachments: [], errors: [] };
  }

  private authorAllowed(pubkey: string): boolean {
    switch (this.config.respondTo) {
      case "nobody":
        return false;
      case "anyone":
        return true;
      case "owner_only":
        return pubkey === this.config.ownerPubkey;
      case "allowlist":
        return this.config.allowedPubkeys.includes(pubkey);
    }
  }

  private toInboundEvent(event: Event, channelId: string): InboundEvent {
    const explicitRoot = event.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "root",
    )?.[1];
    const reply = event.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "reply",
    )?.[1];
    const mutationTarget =
      event.kind === BUZZ_KINDS.streamEdit ||
      event.kind === BUZZ_KINDS.deletion ||
      event.kind === BUZZ_KINDS.nativeDelete
        ? (reply ?? firstTag(event, "e"))
        : null;
    const root = explicitRoot ?? reply ?? null;
    const kind =
      event.kind === BUZZ_KINDS.memberAdded ||
      event.kind === BUZZ_KINDS.memberRemoved
        ? "membership_change"
        : event.kind === BUZZ_KINDS.streamEdit
          ? "message_edit"
          : event.kind === BUZZ_KINDS.deletion ||
              event.kind === BUZZ_KINDS.nativeDelete
            ? "message_delete"
            : "message";
    const conversation: ConversationRef = {
      platform: "buzz",
      communityId: this.endpoint.communityId,
      endpointId: this.endpoint.id,
      channelId,
      threadRootId: root,
      workflowRunId: null,
      type:
        this.channels.get(channelId)?.type === "dm"
          ? "direct"
          : this.channels.get(channelId)?.type === "forum"
            ? "forum"
            : "stream",
    };
    return {
      platform: "buzz",
      endpointId: this.endpoint.id,
      agentId: this.endpoint.agentId,
      communityId: this.endpoint.communityId,
      conversation,
      externalEventId: event.id,
      externalMessageId: event.id,
      targetExternalEventId: mutationTarget ?? null,
      workflowRunId: null,
      sender: {
        id: event.pubkey,
        kind: "unknown",
        displayName: null,
        username: null,
        raw: { pubkey: event.pubkey },
      },
      kind,
      text: event.content,
      markdown: true,
      replyTo: reply ?? null,
      rootEventId: root ?? null,
      mentions: allTags(event, "p"),
      attachments: parseImetaAttachments(event),
      occurredAt: event.created_at,
      receivedSeq: 0,
      raw: event,
    };
  }
}

function parseImetaAttachments(event: Event): RemoteAttachment[] {
  const result: RemoteAttachment[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "imeta") continue;
    const fields = new Map<string, string>();
    for (const field of tag.slice(1)) {
      const split = field.indexOf(" ");
      if (split > 0) fields.set(field.slice(0, split), field.slice(split + 1));
    }
    const mimeType = fields.get("m") ?? null;
    const size = fields.get("size");
    const kind = mimeType?.startsWith("image/")
      ? "image"
      : mimeType?.startsWith("video/")
        ? "video"
        : mimeType?.startsWith("audio/")
          ? "audio"
          : "document";
    result.push({
      externalId:
        fields.get("x") ?? fields.get("url") ?? `imeta:${result.length}`,
      kind,
      mimeType,
      originalFilename: fields.get("filename") ?? null,
      sizeBytes: size && /^\d+$/.test(size) ? Number(size) : null,
      raw: tag,
    });
  }
  return result;
}
