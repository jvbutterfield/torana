// Platform-neutral inbound processing. Platform transports normalize their
// native payloads before entering this path; the v1 database bridge below
// converts canonical decimal external IDs back to integers until Phase 2
// introduces the normalized persistence model.

import type { AlertManager } from "../alerts.js";
import type { BotConfig, Config } from "../config/schema.js";
import type { GatewayDB } from "../db/gateway-db.js";
import { logger } from "../log.js";
import type { PlatformAdapter } from "../platform/capabilities.js";
import { supports } from "../platform/capabilities.js";
import type { InboundEvent } from "../platform/types.js";
import { isAuthorized } from "./acl.js";
import { computeAttachmentsDiskUsage } from "./attachments.js";
import {
  dispatchCommand,
  parseCommand,
  type CommandContext,
} from "./commands.js";

const log = logger("process-inbound-event");

export interface ProcessInboundOutcome {
  status:
    | "enqueued"
    | "replay_skipped"
    | "rejected_acl"
    | "rejected_unsupported_media"
    | "rejected_command_handled"
    | "dropped_malformed"
    | "dropped_no_text";
  turnId?: number;
  errors?: string[];
}

export interface ProcessInboundDeps {
  config: Config;
  db: GatewayDB;
  botConfig: BotConfig;
  adapter: PlatformAdapter;
  alerts?: AlertManager;
  onEnqueued?: (turnId: number) => void;
  commandContextFactory?: (args: {
    chatId: number;
    messageId: number;
    fromUserId: number;
    rawText: string;
  }) => CommandContext | null;
}

export async function processInboundEvent(
  deps: ProcessInboundDeps,
  event: InboundEvent,
): Promise<ProcessInboundOutcome> {
  const { config, db, botConfig, adapter } = deps;
  if (!event.conversation || !event.externalMessageId) {
    return { status: "dropped_malformed" };
  }

  const updateId = legacyDecimal(event.externalEventId, "external event ID");
  const chatId = legacyDecimal(event.conversation.channelId, "channel ID");
  const messageId = legacyDecimal(
    event.externalMessageId,
    "external message ID",
  );
  const fromUserId = legacyDecimal(event.sender.id, "external principal ID");
  const payloadJson = JSON.stringify(event.raw);

  const existing = db.getInboundUpdateStatus(botConfig.id, updateId);
  if (
    existing &&
    (existing.status === "enqueued" ||
      existing.status === "processed" ||
      existing.status === "rejected")
  ) {
    log.debug("dedup — confirmed replay", {
      bot_id: botConfig.id,
      external_event_id: event.externalEventId,
      status: existing.status,
    });
    return { status: "replay_skipped" };
  }

  if (!isAuthorized(config, botConfig, fromUserId)) {
    db.insertUpdate(
      botConfig.id,
      updateId,
      chatId,
      messageId,
      event.sender.id,
      payloadJson,
      "rejected",
    );
    log.info("unauthorized sender", {
      bot_id: botConfig.id,
      external_principal_id: event.sender.id,
    });
    return { status: "rejected_acl" };
  }

  const receivedEmoji = botConfig.reactions.received_emoji;
  if (receivedEmoji && supports(adapter, "reaction_add")) {
    void adapter
      .deliver(event.conversation, {
        kind: "reaction_add",
        externalMessageId: event.externalMessageId,
        emoji: receivedEmoji,
      })
      .catch(() => {});
  }

  const parsed = parseCommand(event.text);
  if (parsed && deps.commandContextFactory) {
    const ctx = deps.commandContextFactory({
      chatId,
      messageId,
      fromUserId,
      rawText: event.text,
    });
    if (ctx && (await dispatchCommand(ctx, parsed)).handled) {
      db.insertUpdate(
        botConfig.id,
        updateId,
        chatId,
        messageId,
        event.sender.id,
        payloadJson,
        "rejected",
      );
      return { status: "rejected_command_handled" };
    }
  }

  const hasText = event.text.trim().length > 0;
  const downloadable = event.attachments.filter(
    (attachment) =>
      attachment.kind === "image" || attachment.kind === "document",
  );
  const hasUnsupported = event.attachments.length > downloadable.length;
  if (!hasText && hasUnsupported) {
    db.insertUpdate(
      botConfig.id,
      updateId,
      chatId,
      messageId,
      event.sender.id,
      payloadJson,
      "rejected",
    );
    await deliverNotice(
      adapter,
      event,
      "This bot doesn't accept that media type yet.",
    );
    return { status: "rejected_unsupported_media" };
  }

  if (!hasText && downloadable.length === 0) {
    return { status: "dropped_no_text" };
  }

  let attachmentPaths: string[] = [];
  let errors: string[] = [];
  if (downloadable.length > 0) {
    const diskUsage = await computeAttachmentsDiskUsage(
      config.gateway.data_dir,
    );
    if (diskUsage >= config.attachments.disk_usage_cap_bytes) {
      if (deps.alerts) void deps.alerts.attachmentDiskFull();
      await deliverNotice(
        adapter,
        event,
        "Attachment storage is full — please try again later.",
      );
      return { status: "dropped_malformed", errors: ["disk_usage_cap"] };
    }

    if (!supports(adapter, "attachment_download")) {
      return {
        status: "dropped_malformed",
        errors: ["attachment_download_unsupported"],
      };
    }
    const result = await adapter.materializeAttachments(event, config);
    attachmentPaths = result.attachments.map((attachment) => attachment.path);
    errors = result.errors;
  }

  for (const error of errors) {
    log.warn("attachment download issue", {
      bot_id: botConfig.id,
      error,
    });
  }

  let turnId: number | null = null;
  try {
    turnId = db.transaction(() => {
      const inboundId = db.insertUpdate(
        botConfig.id,
        updateId,
        chatId,
        messageId,
        event.sender.id,
        payloadJson,
        "received",
      );
      if (inboundId === null) return null;
      const createdTurnId = db.createTurn(
        botConfig.id,
        chatId,
        inboundId,
        attachmentPaths.length > 0 ? attachmentPaths : undefined,
      );
      db.setUpdateStatus(inboundId, "enqueued");
      db.upsertUserChat(botConfig.id, event.sender.id, chatId);
      return createdTurnId;
    });
  } catch (error) {
    log.error("enqueue transaction failed", {
      bot_id: botConfig.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (turnId === null) return { status: "replay_skipped" };
  deps.onEnqueued?.(turnId);
  return {
    status: "enqueued",
    turnId,
    errors: errors.length > 0 ? errors : undefined,
  };
}

async function deliverNotice(
  adapter: PlatformAdapter,
  event: InboundEvent,
  text: string,
): Promise<void> {
  if (!event.conversation || !supports(adapter, "send")) return;
  try {
    await adapter.deliver(event.conversation, {
      kind: "send",
      text,
      files: [],
    });
  } catch {
    // Best effort, matching the pre-adapter Telegram behavior.
  }
}

function legacyDecimal(value: string, label: string): number {
  if (!/^-?[1-9]\d*$/.test(value)) {
    throw new Error(`${label} must be a canonical decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} is outside the safe integer range`);
  }
  return parsed;
}
