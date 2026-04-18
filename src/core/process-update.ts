// Shared processUpdate path (§3.6). Both webhook and polling transports
// route into this function. The steps in order:
//   1. Shape-validate the update
//   2. Quick dedup check (read-only)
//   3. ACL
//   4. Reaction ack (fire-and-forget)
//   5. Unsupported-media handling
//   6. Attachment download
//   7. Dedup + enqueue (single transaction)
//   8. Return; caller acks to Telegram

import { logger } from "../log.js";
import type { BotConfig, Config } from "../config/schema.js";
import type { GatewayDB } from "../db/gateway-db.js";
import type { TelegramClient } from "../telegram/client.js";
import type { TelegramUpdate } from "../telegram/types.js";
import {
  downloadAttachments,
  computeAttachmentsDiskUsage,
} from "./attachments.js";
import { isAuthorized } from "./acl.js";
import { dispatchCommand, parseCommand, type CommandContext } from "./commands.js";

const log = logger("process-update");

export interface ProcessUpdateOutcome {
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

export interface ProcessUpdateDeps {
  config: Config;
  db: GatewayDB;
  botConfig: BotConfig;
  telegram: TelegramClient;
  /** Callback fired when a new turn has been enqueued — dispatcher will pick it up. */
  onEnqueued?: (turnId: number) => void;
  /** Provides the command dispatcher context (runner + status snapshot). */
  commandContextFactory?: (args: {
    chatId: number;
    messageId: number;
    fromUserId: number;
    rawText: string;
  }) => CommandContext | null;
}

export async function processUpdate(
  deps: ProcessUpdateDeps,
  update: TelegramUpdate,
): Promise<ProcessUpdateOutcome> {
  const { config, db, botConfig, telegram } = deps;

  // Step 1 — shape validation.
  const message = update.message;
  if (!message) return { status: "dropped_malformed" };
  const chatId = message.chat?.id;
  const messageId = message.message_id;
  const fromUserId = message.from?.id;
  if (!chatId || !messageId || fromUserId === undefined) {
    return { status: "dropped_malformed" };
  }

  // Step 2 — quick dedup.
  const existing = db.getInboundUpdateStatus(botConfig.id, update.update_id);
  if (existing) {
    if (
      existing.status === "enqueued" ||
      existing.status === "processed" ||
      existing.status === "rejected"
    ) {
      log.debug("dedup — confirmed replay", {
        bot_id: botConfig.id,
        update_id: update.update_id,
        status: existing.status,
      });
      return { status: "replay_skipped" };
    }
    // status === "received" → retry the rest of the flow.
  }

  // Step 3 — ACL.
  if (!isAuthorized(config, botConfig, fromUserId)) {
    const payloadJson = JSON.stringify(update);
    db.insertUpdate(
      botConfig.id,
      update.update_id,
      chatId,
      messageId,
      String(fromUserId),
      payloadJson,
      "rejected",
    );
    log.info("unauthorized sender", {
      bot_id: botConfig.id,
      from_user_id: fromUserId,
    });
    return { status: "rejected_acl" };
  }

  // Step 4 — reaction ack (fire-and-forget).
  const receivedEmoji = botConfig.reactions.received_emoji;
  if (receivedEmoji) {
    telegram
      .setMessageReaction(chatId, messageId, receivedEmoji)
      .catch(() => {
        /* best-effort */
      });
  }

  // Slash commands: parse before turn-enqueue so /reset and friends don't get
  // forwarded to the runner.
  const text = message.text ?? message.caption ?? "";
  const parsed = parseCommand(text);
  if (parsed && deps.commandContextFactory) {
    const ctx = deps.commandContextFactory({
      chatId,
      messageId,
      fromUserId,
      rawText: text,
    });
    if (ctx) {
      const result = await dispatchCommand(ctx, parsed);
      if (result.handled) {
        const payloadJson = JSON.stringify(update);
        db.insertUpdate(
          botConfig.id,
          update.update_id,
          chatId,
          messageId,
          String(fromUserId),
          payloadJson,
          "rejected", // "rejected" here means "not forwarded as a turn" — dedup-terminal
        );
        return { status: "rejected_command_handled" };
      }
    }
  }

  // Step 5 — unsupported-media handling.
  const hasText = text.trim().length > 0;
  const hasUnsupported =
    !!message.video ||
    !!message.voice ||
    !!message.audio ||
    !!message.sticker ||
    !!message.animation;
  if (!hasText && hasUnsupported) {
    const payloadJson = JSON.stringify(update);
    db.insertUpdate(
      botConfig.id,
      update.update_id,
      chatId,
      messageId,
      String(fromUserId),
      payloadJson,
      "rejected",
    );
    try {
      await telegram.sendMessage(
        chatId,
        "This bot doesn't accept that media type yet.",
      );
    } catch {
      /* ignore */
    }
    return { status: "rejected_unsupported_media" };
  }

  if (!hasText && !message.photo && !message.document) {
    // Nothing to forward and nothing rejected.
    return { status: "dropped_no_text" };
  }

  // Step 6 — attachment download.
  const diskUsage = await computeAttachmentsDiskUsage(config.gateway.data_dir);
  if (diskUsage >= config.attachments.disk_usage_cap_bytes) {
    await telegram
      .sendMessage(
        chatId,
        "Attachment storage is full — please try again later.",
      )
      .catch(() => {});
    return { status: "dropped_malformed", errors: ["disk_usage_cap"] };
  }

  const { attachments, errors } = await downloadAttachments(
    config,
    botConfig.id,
    update.update_id,
    message,
    telegram,
  );
  if (errors.length > 0) {
    for (const err of errors) {
      log.warn("attachment download issue", { bot_id: botConfig.id, error: err });
    }
  }

  // Step 7 — dedup + enqueue (single transaction).
  const payloadJson = JSON.stringify(update);
  const attachmentPaths = attachments.map((a) => a.path);

  let turnId: number | null = null;
  try {
    turnId = db.transaction(() => {
      const inboundId = db.insertUpdate(
        botConfig.id,
        update.update_id,
        chatId,
        messageId,
        String(fromUserId),
        payloadJson,
        "received",
      );
      if (inboundId === null) {
        // Already present (race with another delivery) — treat as replay.
        return null;
      }
      const tid = db.createTurn(
        botConfig.id,
        chatId,
        inboundId,
        attachmentPaths.length > 0 ? attachmentPaths : undefined,
      );
      db.setUpdateStatus(inboundId, "enqueued");
      return tid;
    });
  } catch (err) {
    log.error("enqueue transaction failed", {
      bot_id: botConfig.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (turnId === null) {
    return { status: "replay_skipped" };
  }

  deps.onEnqueued?.(turnId);
  return { status: "enqueued", turnId, errors: errors.length ? errors : undefined };
}
