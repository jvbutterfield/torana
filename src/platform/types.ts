export type PlatformKind = "telegram" | "buzz" | "agent_api";

export interface ConversationRef {
  platform: PlatformKind;
  communityId: string | null;
  endpointId: string;
  channelId: string;
  threadRootId: string | null;
  workflowRunId: string | null;
  type: "direct" | "stream" | "forum" | "workflow" | "group" | "api";
}

export interface ExternalPrincipal {
  id: string;
  kind: "human" | "agent" | "service" | "unknown";
  displayName: string | null;
  username: string | null;
  raw: unknown;
}

export type AttachmentKind =
  | "image"
  | "document"
  | "video"
  | "voice"
  | "audio"
  | "sticker"
  | "animation"
  | "unknown";

export interface RemoteAttachment {
  externalId: string;
  kind: AttachmentKind;
  mimeType: string | null;
  originalFilename: string | null;
  sizeBytes: number | null;
  raw: unknown;
}

export interface LocalAttachment {
  kind: "photo" | "document";
  path: string;
  mime_type?: string;
  original_filename?: string;
  bytes: number;
}

export type InboundEventKind =
  | "message"
  | "message_edit"
  | "message_delete"
  | "reaction"
  | "forum_post"
  | "forum_comment"
  | "forum_vote"
  | "workflow_event"
  | "control"
  | "membership_change"
  | "channel_lifecycle"
  | "presence"
  | "typing";

export interface InboundEvent {
  platform: PlatformKind;
  endpointId: string;
  agentId: string;
  communityId: string | null;
  conversation: ConversationRef | null;
  externalEventId: string;
  externalMessageId: string | null;
  targetExternalEventId: string | null;
  workflowRunId: string | null;
  sender: ExternalPrincipal;
  kind: InboundEventKind;
  text: string;
  markdown: boolean;
  replyTo: string | null;
  rootEventId: string | null;
  mentions: string[];
  attachments: RemoteAttachment[];
  occurredAt: number;
  receivedSeq: number;
  raw: unknown;
}

export type OutboundOperation =
  | {
      kind: "send";
      text: string;
      files: LocalAttachment[];
      replyTo?: string;
      /** Platform-native recipients to tag on a generated reply. */
      mentions?: string[];
      /** Cooperative diagnostic metadata; local rate limits remain authoritative. */
      traceId?: string;
      hop?: number;
    }
  | { kind: "edit"; externalMessageId: string; text: string }
  | { kind: "delete"; externalMessageId: string; reason?: string }
  | {
      kind: "reaction_add";
      externalMessageId: string;
      emoji: string;
    }
  | {
      kind: "reaction_remove";
      externalMessageId: string;
      emoji: string;
    }
  | {
      kind: "forum_post";
      channelId: string;
      title: string;
      text: string;
      files?: LocalAttachment[];
    }
  | {
      kind: "forum_comment";
      rootEventId: string;
      text: string;
      replyTo?: string;
      files?: LocalAttachment[];
    }
  | {
      kind: "vote";
      externalMessageId: string;
      direction: "up" | "down";
    };

export type EphemeralSignal =
  | { kind: "typing"; active: boolean }
  | { kind: "presence"; state: "online" | "away" | "offline" };
