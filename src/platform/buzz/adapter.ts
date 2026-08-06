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
  LocalAttachment,
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
import {
  buildImetaTag,
  downloadBuzzAttachments,
  type BuzzFetch,
  uploadBuzzFiles,
} from "./media.js";

const BUZZ_PHASE6_CAPABILITIES = new Set([
  "send",
  "edit",
  "delete",
  "reaction_add",
  "reaction_remove",
  "forum_post",
  "forum_comment",
  "vote",
  "typing",
  "presence",
  "attachment_download",
] as const);
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

export type BuzzSignalOutcome = "published" | "suppressed" | "failed";

export class BuzzAdapter implements PlatformAdapter<Event> {
  readonly endpoint: MessagingEndpoint;
  readonly config: NormalizedBuzzRuntimeConfig;
  private channels = new Map<string, BuzzChannelMetadata>();
  private publisher: ((event: Event) => Promise<DeliveryResult>) | null = null;
  private rateLimits = {
    edit: 2000,
    reaction: 1000,
    typing: 4000,
    presence: 30_000,
  };
  private lastPublished = new Map<
    "edit" | "reaction" | "typing" | "presence",
    number
  >();
  private mediaFetch: BuzzFetch = fetch;

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
      capabilities: BUZZ_PHASE6_CAPABILITIES,
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

  setRateLimits(limits: Partial<typeof this.rateLimits>): void {
    this.rateLimits = { ...this.rateLimits, ...limits };
  }

  setMediaFetch(fetchImpl: BuzzFetch): void {
    this.mediaFetch = fetchImpl;
  }

  resetEphemeralRateLimits(): void {
    this.lastPublished.delete("typing");
    this.lastPublished.delete("presence");
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
    const isWorkflow =
      this.config.triggers.workflows.enabled &&
      this.config.triggers.workflows.event_kinds.includes(event.kind);
    const isNeedsAction =
      this.config.triggers.feed.enabled &&
      this.config.triggers.feed.modes.includes("needs_action") &&
      event.kind === BUZZ_KINDS.workflowApprovalRequested;
    if (
      (!isMessage && !isMutation && !isWorkflow && !isNeedsAction) ||
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

    if (isWorkflow || isNeedsAction) {
      return {
        kind: "accepted",
        event: normalized,
        reason: null,
        cursorScope,
      };
    }
    // Owner "Stop" (remote-agents invariant I5). Checked before the author and
    // mention gates so it works identically on every `respond_to` setting: an
    // `anyone` endpoint must not let a non-owner stop it, and a `nobody`
    // endpoint must still obey its owner.
    if (this.isOwnerShutdown(event)) {
      return {
        kind: "control",
        event: normalized,
        reason: "owner_shutdown",
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
    const files = outboundFiles(operation);
    if (files.length > 0) {
      return { payloadJson: JSON.stringify(operation) };
    }
    return this.prepareSignedOutbound(conversation, operation, []);
  }

  async prepareOutboundAsync(
    conversation: ConversationRef,
    operation: OutboundOperation,
    config: Config,
  ): Promise<PreparedOutboundOperation> {
    const files = outboundFiles(operation);
    if (files.length === 0) {
      return this.prepareSignedOutbound(conversation, operation, []);
    }
    const descriptors = await uploadBuzzFiles({
      files,
      maxBytes: config.attachments.max_bytes,
      relayUrl: this.config.relayUrl,
      privateKey: this.config.privateKey,
      authTag: this.config.authTag,
      fetchImpl: this.mediaFetch,
    });
    return this.prepareSignedOutbound(
      conversation,
      operation,
      descriptors.map(buildImetaTag),
    );
  }

  private prepareSignedOutbound(
    conversation: ConversationRef,
    operation: OutboundOperation,
    mediaTags: string[][],
  ): PreparedOutboundOperation {
    const tags: string[][] = [
      [
        "h",
        operation.kind === "forum_post"
          ? operation.channelId
          : conversation.channelId,
      ],
    ];
    let kind: number;
    let content: string;
    if (operation.kind === "send") {
      kind = BUZZ_KINDS.streamMessageV1;
      content = operation.text;
    } else if (operation.kind === "edit") {
      kind = BUZZ_KINDS.streamEdit;
      content = operation.text;
      tags.push(["e", operation.externalMessageId]);
    } else if (operation.kind === "delete") {
      kind = BUZZ_KINDS.nativeDelete;
      content = "";
      tags.push(["e", operation.externalMessageId]);
      if (operation.reason)
        tags.push(["reason", operation.reason.slice(0, 256)]);
    } else if (operation.kind === "reaction_add") {
      kind = BUZZ_KINDS.reaction;
      const reaction = normalizeReaction(
        operation.emoji,
        this.config.customEmojiPalette,
      );
      content = reaction.content;
      tags.push(["e", operation.externalMessageId]);
      if (reaction.custom) {
        tags.push(["emoji", reaction.custom.name, reaction.custom.url]);
      }
    } else if (operation.kind === "reaction_remove") {
      kind = BUZZ_KINDS.deletion;
      content = "";
      tags.push(["e", operation.externalMessageId]);
    } else if (operation.kind === "forum_post") {
      kind = BUZZ_KINDS.forumPost;
      content = operation.title.trim()
        ? `# ${operation.title.trim()}\n\n${operation.text}`
        : operation.text;
    } else if (operation.kind === "forum_comment") {
      kind = BUZZ_KINDS.forumComment;
      content = operation.text;
      tags.push(["e", operation.rootEventId, "", "root"]);
      tags.push(["e", operation.replyTo ?? operation.rootEventId, "", "reply"]);
    } else if (operation.kind === "vote") {
      kind = BUZZ_KINDS.forumVote;
      content = operation.direction === "up" ? "+" : "-";
      tags.push(["e", operation.externalMessageId]);
    } else {
      return { payloadJson: JSON.stringify(operation) };
    }
    if (operation.kind === "send" && operation.replyTo) {
      const root = conversation.threadRootId;
      if (root && root !== operation.replyTo) {
        tags.push(["e", root, "", "root"]);
      }
      tags.push(["e", operation.replyTo, "", "reply"]);
    }
    for (const pubkey of [
      ...new Set(operation.kind === "send" ? (operation.mentions ?? []) : []),
    ]) {
      if (/^[0-9a-f]{64}$/.test(pubkey)) tags.push(["p", pubkey]);
    }
    if (operation.kind === "send" && operation.traceId)
      tags.push(["torana-trace", operation.traceId]);
    if (operation.kind === "send" && operation.hop !== undefined) {
      tags.push(["torana-hop", String(operation.hop)]);
    }
    tags.push(...mediaTags);
    const signed = signTemplate(
      {
        kind,
        created_at: Math.floor(Date.now() / 1000),
        content,
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
    if (
      ![
        "send",
        "edit",
        "delete",
        "reaction_add",
        "reaction_remove",
        "forum_post",
        "forum_comment",
        "vote",
      ].includes(operation.kind)
    ) {
      return {
        ok: false,
        retriable: false,
        description: `Buzz ${operation.kind} delivery is not supported`,
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
    const rateKind =
      operation.kind === "edit"
        ? "edit"
        : operation.kind === "reaction_add" ||
            operation.kind === "reaction_remove"
          ? "reaction"
          : null;
    if (rateKind) {
      const retryAfterMs = this.remainingRateLimit(rateKind);
      if (retryAfterMs > 0) {
        return {
          ok: false,
          retriable: true,
          description: `Buzz ${rateKind} rate limit`,
          retryAfterMs,
        };
      }
    }
    const result = await this.publisher(event);
    if (result.ok && rateKind) this.lastPublished.set(rateKind, Date.now());
    return result;
  }

  async signal(
    conversation: ConversationRef,
    signal: import("../types.js").EphemeralSignal,
  ): Promise<boolean> {
    return (await this.signalDetailed(conversation, signal)) === "published";
  }

  /**
   * `signal()` with the outcome the supervisor needs: a presence refresh that
   * was suppressed by the rate limiter and one that the relay rejected are
   * indistinguishable through a boolean, but only the second is a liveness
   * problem worth alerting on.
   */
  async signalDetailed(
    conversation: ConversationRef,
    signal: import("../types.js").EphemeralSignal,
  ): Promise<BuzzSignalOutcome> {
    if (!this.publisher) return "failed";
    const rateKind = signal.kind;
    if (!this.rateLimitExempt(signal) && this.remainingRateLimit(rateKind) > 0)
      return "suppressed";
    const tags: string[][] = [];
    let content: string;
    let kind: number;
    if (signal.kind === "typing") {
      if (!signal.active) return "published";
      kind = BUZZ_KINDS.typing;
      content = "";
      tags.push(["h", conversation.channelId]);
      if (conversation.threadRootId) {
        tags.push(["e", conversation.threadRootId, "", "reply"]);
      }
    } else {
      kind = BUZZ_KINDS.presence;
      content = signal.state;
      tags.push(["status", signal.state]);
    }
    try {
      const event = signTemplate(
        { kind, created_at: Math.floor(Date.now() / 1000), content, tags },
        decodeSecret(this.config.privateKey),
        parseOwnerAuthTag(this.config.authTag ?? undefined),
      );
      const result = await this.publisher(event);
      if (!result.ok) return "failed";
      this.lastPublished.set(rateKind, Date.now());
      return "published";
    } catch {
      return "failed";
    }
  }

  /**
   * `offline` is the clean-stop announcement — suppressing it would leave a
   * stopped endpoint showing online until the relay's TTL lapses. Lifecycle
   * presence is the heartbeat that keeps that TTL from lapsing at all; with a
   * heartbeat at or inside `presence_min_interval_ms` the limiter would drop
   * every other refresh and halve the safety margin against the relay's
   * 180 s expiry.
   */
  private rateLimitExempt(
    signal: import("../types.js").EphemeralSignal,
  ): boolean {
    return (
      signal.kind === "presence" &&
      (signal.state === "offline" || signal.lifecycle === true)
    );
  }

  async materializeAttachments(event: InboundEvent, config: Config) {
    return await downloadBuzzAttachments({
      event,
      config,
      relayUrl: this.config.relayUrl,
      privateKey: this.config.privateKey,
      authTag: this.config.authTag,
      fetchImpl: this.mediaFetch,
    });
  }

  /**
   * The Desktop's remote-agent "Stop" button. Written against the upstream
   * implementation at the pinned tree rather than against a guess:
   * `is_owner_control_command` (`crates/buzz-acp/src/lib.rs`) requires a stream
   * message whose **trimmed content equals `!shutdown` exactly** and which
   * `p`-tags the agent; the caller then requires the author to be the resolved
   * owner. The Desktop publishes exactly that — `sendChannelMessage(channelId,
   * "!shutdown", …, [agent.pubkey])` — so the mention is a tag, never inline
   * text, and a message that merely contains `!shutdown` is an ordinary prompt.
   *
   * Torana accepts both stream-message kinds where upstream accepts only
   * kind 9. Every other message path here treats V1 and V2 as the same thing,
   * and an owner stop that worked in one channel but not another would be a
   * worse surprise than the divergence.
   */
  private isOwnerShutdown(event: Event): boolean {
    return (
      this.config.ownerShutdown === "enabled" &&
      (event.kind === BUZZ_KINDS.streamMessageV1 ||
        event.kind === BUZZ_KINDS.streamMessageV2) &&
      event.content.trim() === "!shutdown" &&
      this.config.ownerPubkey !== null &&
      event.pubkey === this.config.ownerPubkey &&
      allTags(event, "p").includes(this.config.pubkey)
    );
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

  private remainingRateLimit(
    kind: "edit" | "reaction" | "typing" | "presence",
  ): number {
    const elapsed = Date.now() - (this.lastPublished.get(kind) ?? 0);
    return Math.max(0, this.rateLimits[kind] - elapsed);
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
      event.kind === BUZZ_KINDS.nativeDelete ||
      event.kind === BUZZ_KINDS.reaction ||
      event.kind === BUZZ_KINDS.forumVote
        ? (reply ?? firstTag(event, "e"))
        : null;
    const root =
      event.kind === BUZZ_KINDS.forumPost
        ? event.id
        : (explicitRoot ?? reply ?? null);
    const workflowRunId = workflowRunIdFromEvent(event);
    const kind =
      event.kind === BUZZ_KINDS.memberAdded ||
      event.kind === BUZZ_KINDS.memberRemoved
        ? "membership_change"
        : event.kind === BUZZ_KINDS.streamEdit
          ? "message_edit"
          : event.kind === BUZZ_KINDS.deletion ||
              event.kind === BUZZ_KINDS.nativeDelete
            ? "message_delete"
            : event.kind === BUZZ_KINDS.reaction
              ? "reaction"
              : event.kind === BUZZ_KINDS.forumPost
                ? "forum_post"
                : event.kind === BUZZ_KINDS.forumComment
                  ? "forum_comment"
                  : event.kind === BUZZ_KINDS.forumVote
                    ? "forum_vote"
                    : isWorkflowKind(event.kind)
                      ? "workflow_event"
                      : "message";
    const conversation: ConversationRef = {
      platform: "buzz",
      communityId: this.endpoint.communityId,
      endpointId: this.endpoint.id,
      channelId,
      threadRootId: root,
      workflowRunId,
      type:
        workflowRunId || this.channels.get(channelId)?.type === "workflow"
          ? "workflow"
          : this.channels.get(channelId)?.type === "dm"
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
      workflowRunId,
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

function normalizeReaction(
  emoji: string,
  palette: Readonly<Record<string, string>>,
): { content: string; custom?: { name: string; url: string } } {
  const value = emoji.trim();
  const custom = value.match(/^:([A-Za-z0-9_-]{1,64}):$/);
  if (!custom) {
    if (!value || [...value].length > 64) {
      throw new Error("Buzz reaction must contain 1-64 characters");
    }
    return { content: value };
  }
  const name = custom[1].toLowerCase();
  const url = palette[name];
  if (!url) {
    throw new Error(
      `Buzz custom emoji ':${name}:' requires a URL in custom_emoji_palette`,
    );
  }
  return { content: `:${name}:`, custom: { name, url } };
}

function outboundFiles(operation: OutboundOperation): LocalAttachment[] {
  if (
    operation.kind === "send" ||
    operation.kind === "forum_post" ||
    operation.kind === "forum_comment"
  ) {
    return operation.files ?? [];
  }
  return [];
}

function isWorkflowKind(kind: number): boolean {
  return (
    (kind >= BUZZ_KINDS.workflowTriggered &&
      kind <= BUZZ_KINDS.workflowCancelled) ||
    (kind >= BUZZ_KINDS.workflowApprovalRequested &&
      kind <= BUZZ_KINDS.workflowApprovalDenied)
  );
}

function workflowRunIdFromEvent(event: Event): string | null {
  for (const name of ["run", "run_id", "workflow_run"]) {
    const value = firstTag(event, name);
    if (value) return value;
  }
  try {
    const content = JSON.parse(event.content) as Record<string, unknown>;
    for (const name of ["run_id", "workflow_run_id"]) {
      if (typeof content[name] === "string") return content[name];
    }
  } catch {
    // Workflow content may be plain text; missing run identity is handled below.
  }
  return isWorkflowKind(event.kind) ? event.id : null;
}
