import type { BotId, Config } from "../../config/schema.js";
import { downloadAttachments } from "../../core/attachments.js";
import { markdownToTelegramHtml } from "../../format.js";
import type { TelegramClient } from "../../telegram/client.js";
import type { TelegramMessage, TelegramUpdate } from "../../telegram/types.js";
import type {
  DeliveryResult,
  MessagingEndpoint,
  PlatformAdapter,
} from "../capabilities.js";
import type {
  ConversationRef,
  InboundEvent,
  RemoteAttachment,
} from "../types.js";

const TELEGRAM_CAPABILITIES = new Set([
  "send",
  "edit",
  "reaction_add",
  "typing",
  "attachment_download",
] as const);

export class TelegramAdapter implements PlatformAdapter<TelegramUpdate> {
  readonly endpoint: MessagingEndpoint;
  readonly client: TelegramClient;
  private receivedSeq = 0;

  constructor(endpointId: BotId, client: TelegramClient, agentId = endpointId) {
    this.client = client;
    this.endpoint = {
      id: endpointId,
      agentId,
      platform: "telegram",
      communityId: null,
      capabilities: TELEGRAM_CAPABILITIES,
    };
  }

  normalizeInbound(update: TelegramUpdate): InboundEvent | null {
    const message = update.message;
    const chatId = message?.chat?.id;
    const messageId = message?.message_id;
    const sender = message?.from;
    if (!message || !chatId || !messageId || !sender) return null;

    const conversation: ConversationRef = {
      platform: "telegram",
      communityId: null,
      endpointId: this.endpoint.id,
      channelId: String(chatId),
      threadRootId: null,
      workflowRunId: null,
      type: message.chat.type === "private" ? "direct" : "group",
    };

    return {
      platform: "telegram",
      endpointId: this.endpoint.id,
      agentId: this.endpoint.agentId,
      communityId: null,
      conversation,
      externalEventId: String(update.update_id),
      externalMessageId: String(messageId),
      targetExternalEventId: null,
      workflowRunId: null,
      sender: {
        id: String(sender.id),
        kind: sender.is_bot ? "agent" : "human",
        displayName:
          [sender.first_name, sender.last_name].filter(Boolean).join(" ") ||
          null,
        username: sender.username ?? null,
        raw: sender,
      },
      kind: "message",
      text: message.text ?? message.caption ?? "",
      markdown: false,
      replyTo: null,
      rootEventId: null,
      mentions: [],
      attachments: normalizeAttachments(message),
      occurredAt: message.date,
      receivedSeq: ++this.receivedSeq,
      raw: update,
    };
  }

  async deliver(
    conversation: ConversationRef,
    operation: Parameters<PlatformAdapter["deliver"]>[1],
  ): Promise<DeliveryResult> {
    const chatId = decimalId(conversation.channelId, "Telegram chat ID");

    if (operation.kind === "send") {
      const formatted = markdownToTelegramHtml(operation.text);
      let result = await this.client.sendMessage(chatId, formatted, "HTML");
      if (!result.ok && formatted !== operation.text) {
        result = await this.client.sendMessage(chatId, operation.text);
      }
      return result.ok
        ? { ok: true, externalMessageId: String(result.messageId) }
        : result;
    }

    if (operation.kind === "edit") {
      const messageId = decimalId(
        operation.externalMessageId,
        "Telegram message ID",
      );
      const formatted = markdownToTelegramHtml(operation.text);
      let result = await this.client.editMessageText(
        chatId,
        messageId,
        formatted,
        "HTML",
      );
      if (!result.ok && !result.notModified && formatted !== operation.text) {
        result = await this.client.editMessageText(
          chatId,
          messageId,
          operation.text,
        );
      }
      return result;
    }

    if (operation.kind === "reaction_add") {
      const messageId = decimalId(
        operation.externalMessageId,
        "Telegram message ID",
      );
      const ok = await this.client.setMessageReaction(
        chatId,
        messageId,
        operation.emoji,
      );
      return ok
        ? { ok: true }
        : {
            ok: false,
            retriable: false,
            description: "Telegram reaction was rejected",
          };
    }

    return {
      ok: false,
      retriable: false,
      description: `Telegram endpoint does not support ${operation.kind}`,
    };
  }

  async signal(
    conversation: ConversationRef,
    signal: Parameters<PlatformAdapter["signal"]>[1],
  ): Promise<boolean> {
    if (signal.kind !== "typing" || !signal.active) return false;
    const chatId = decimalId(conversation.channelId, "Telegram chat ID");
    return await this.client.sendChatAction(chatId);
  }

  async materializeAttachments(event: InboundEvent, config: Config) {
    const update = event.raw as TelegramUpdate;
    if (!update.message) return { attachments: [], errors: [] };
    return await downloadAttachments(
      config,
      this.endpoint.agentId as BotId,
      decimalId(event.externalEventId, "Telegram update ID"),
      update.message,
      this.client,
    );
  }
}

function normalizeAttachments(message: TelegramMessage): RemoteAttachment[] {
  const attachments: RemoteAttachment[] = [];
  const photo = message.photo?.at(-1);
  if (photo) {
    attachments.push({
      externalId: photo.file_id,
      kind: "image",
      mimeType: "image/jpeg",
      originalFilename: null,
      sizeBytes: photo.file_size ?? null,
      raw: photo,
    });
  }
  if (message.document) {
    attachments.push({
      externalId: message.document.file_id,
      kind: "document",
      mimeType: message.document.mime_type ?? null,
      originalFilename: message.document.file_name ?? null,
      sizeBytes: message.document.file_size ?? null,
      raw: message.document,
    });
  }
  for (const [kind, value] of [
    ["video", message.video],
    ["voice", message.voice],
    ["audio", message.audio],
    ["sticker", message.sticker],
    ["animation", message.animation],
  ] as const) {
    if (!value) continue;
    attachments.push({
      externalId: value.file_id,
      kind,
      mimeType: "mime_type" in value ? (value.mime_type ?? null) : null,
      originalFilename: null,
      sizeBytes: "file_size" in value ? (value.file_size ?? null) : null,
      raw: value,
    });
  }
  return attachments;
}

function decimalId(value: string, label: string): number {
  if (!/^-?[1-9]\d*$/.test(value)) {
    throw new Error(`${label} must be a canonical decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} is outside the safe integer range`);
  }
  return parsed;
}

export function telegramConversation(
  endpointId: string,
  chatId: number,
): ConversationRef {
  return {
    platform: "telegram",
    communityId: null,
    endpointId,
    channelId: String(chatId),
    threadRootId: null,
    workflowRunId: null,
    type: "direct",
  };
}

export function coerceTelegramAdapters(
  sources: ReadonlyMap<BotId, TelegramClient | PlatformAdapter>,
): Map<BotId, PlatformAdapter> {
  const adapters = new Map<BotId, PlatformAdapter>();
  for (const [endpointId, source] of sources) {
    adapters.set(
      endpointId,
      isPlatformAdapter(source)
        ? source
        : new TelegramAdapter(endpointId, source),
    );
  }
  return adapters;
}

function isPlatformAdapter(
  value: TelegramClient | PlatformAdapter,
): value is PlatformAdapter {
  return "endpoint" in value && typeof value.deliver === "function";
}
