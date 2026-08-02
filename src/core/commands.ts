// Slash-command dispatcher. Only "builtin:" actions in v1.

import { logger } from "../log.js";
import type { BotConfig } from "../config/schema.js";
import type { PlatformAdapter } from "../platform/capabilities.js";
import { supports } from "../platform/capabilities.js";
import type { ConversationRef } from "../platform/types.js";
import type { AgentRunner } from "../runner/types.js";

const log = logger("commands");

export interface CommandContext {
  botConfig: BotConfig;
  chatId: number;
  messageId: number;
  fromUserId: number;
  rawText: string;
  adapter: PlatformAdapter;
  conversation: ConversationRef;
  runner: AgentRunner;
  /** Bot-level snapshot getter for builtin:status / builtin:health. */
  getStatus: () => BotStatusSnapshot;
  resetConversation?: () => Promise<string>;
  cancelConversation?: () => Promise<string>;
  getConversationStatus?: () => string;
  /** Durable platform-owned reply path used by Buzz owner controls. */
  queueReply?: (text: string) => void;
}

export interface BotStatusSnapshot {
  botId: string;
  runner_ready: boolean;
  mailbox_depth: number;
  last_turn_at: string | null;
  disabled: boolean;
  disabled_reason: string | null;
}

export type CommandResult = { handled: true } | { handled: false };

/** Parse a leading platform command from text. */
export function parseCommand(
  text: string,
): { trigger: string; rest: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") && !trimmed.startsWith("!")) return null;
  const space = trimmed.search(/\s/);
  if (space === -1) return { trigger: trimmed, rest: "" };
  return { trigger: trimmed.slice(0, space), rest: trimmed.slice(space + 1) };
}

export async function dispatchCommand(
  ctx: CommandContext,
  parsed: { trigger: string; rest: string },
): Promise<CommandResult> {
  const intrinsicBuzzAction =
    ctx.conversation.platform === "buzz"
      ? (
          {
            "!rotate": "builtin:reset",
            "!cancel": "builtin:cancel",
            "!status": "builtin:status",
            "!health": "builtin:health",
          } as const
        )[
          parsed.trigger.toLowerCase() as
            | "!rotate"
            | "!cancel"
            | "!status"
            | "!health"
        ]
      : undefined;
  const binding = ctx.botConfig.commands.find(
    (c) => c.trigger === parsed.trigger,
  );
  const action = binding?.action ?? intrinsicBuzzAction;
  if (!action) return { handled: false };

  switch (action) {
    case "builtin:reset":
      await handleReset(ctx);
      return { handled: true };
    case "builtin:cancel":
      await handleCancel(ctx);
      return { handled: true };
    case "builtin:status":
      await handleStatus(ctx);
      return { handled: true };
    case "builtin:health":
      await handleHealth(ctx);
      return { handled: true };
  }
}

async function handleReset(ctx: CommandContext): Promise<void> {
  if (ctx.resetConversation) {
    await sendReply(ctx, await ctx.resetConversation());
    return;
  }
  if (!ctx.runner.supportsReset()) {
    await sendReply(ctx, "This bot does not support /reset.");
    log.warn("reset requested but runner doesn't support it", {
      bot_id: ctx.botConfig.id,
    });
    return;
  }
  try {
    await ctx.runner.reset();
    await sendReply(ctx, "Session cleared. Fresh start ready.");
  } catch (err) {
    log.error("reset failed", {
      bot_id: ctx.botConfig.id,
      error: err instanceof Error ? err.message : String(err),
    });
    await sendReply(ctx, "Reset failed. See logs.");
  }
}

async function handleCancel(ctx: CommandContext): Promise<void> {
  if (!ctx.cancelConversation) {
    await sendReply(
      ctx,
      "No independently cancellable conversation session is active.",
    );
    return;
  }
  await sendReply(ctx, await ctx.cancelConversation());
}

async function handleStatus(ctx: CommandContext): Promise<void> {
  if (ctx.getConversationStatus) {
    await sendReply(ctx, ctx.getConversationStatus());
    return;
  }
  const snap = ctx.getStatus();
  const lines = [
    `Bot: ${snap.botId}`,
    `Runner: ${snap.runner_ready ? "ready" : "not ready"}`,
    `Mailbox: ${snap.mailbox_depth} queued`,
    snap.last_turn_at ? `Last turn: ${snap.last_turn_at}` : "Last turn: —",
    snap.disabled ? `DISABLED: ${snap.disabled_reason ?? "no reason"}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  await sendReply(ctx, lines);
}

async function handleHealth(ctx: CommandContext): Promise<void> {
  const snap = ctx.getStatus();
  const healthy = snap.runner_ready && !snap.disabled && snap.mailbox_depth < 5;
  await sendReply(ctx, healthy ? "✅ healthy" : "⚠️ degraded");
}

async function sendReply(ctx: CommandContext, text: string): Promise<void> {
  if (ctx.queueReply) {
    ctx.queueReply(text);
    return;
  }
  if (supports(ctx.adapter, "send")) {
    await ctx.adapter.deliver(ctx.conversation, {
      kind: "send",
      text,
      files: [],
    });
    return;
  }
  throw new Error("command context has no send-capable endpoint");
}
