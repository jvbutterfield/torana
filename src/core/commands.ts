// Slash-command dispatcher. Only "builtin:" actions in v1.

import { logger } from "../log.js";
import type { BotConfig } from "../config/schema.js";
import type { AgentRunner } from "../runner/types.js";
import type { TelegramClient } from "../telegram/client.js";

const log = logger("commands");

export interface CommandContext {
  botConfig: BotConfig;
  chatId: number;
  messageId: number;
  fromUserId: number;
  rawText: string;
  telegram: TelegramClient;
  runner: AgentRunner;
  /** Bot-level snapshot getter for builtin:status / builtin:health. */
  getStatus: () => BotStatusSnapshot;
}

export interface BotStatusSnapshot {
  botId: string;
  runner_ready: boolean;
  mailbox_depth: number;
  last_turn_at: string | null;
  disabled: boolean;
  disabled_reason: string | null;
}

export type CommandResult =
  | { handled: true }
  | { handled: false };

/** Parse a leading /command from text. Returns null if the message isn't a command. */
export function parseCommand(text: string): { trigger: string; rest: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const space = trimmed.search(/\s/);
  if (space === -1) return { trigger: trimmed, rest: "" };
  return { trigger: trimmed.slice(0, space), rest: trimmed.slice(space + 1) };
}

export async function dispatchCommand(
  ctx: CommandContext,
  parsed: { trigger: string; rest: string },
): Promise<CommandResult> {
  const binding = ctx.botConfig.commands.find((c) => c.trigger === parsed.trigger);
  if (!binding) return { handled: false };

  switch (binding.action) {
    case "builtin:reset":
      await handleReset(ctx);
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
  if (!ctx.runner.supportsReset()) {
    await ctx.telegram.sendMessage(
      ctx.chatId,
      "This bot does not support /reset.",
    );
    log.warn("reset requested but runner doesn't support it", {
      bot_id: ctx.botConfig.id,
    });
    return;
  }
  try {
    await ctx.runner.reset();
    await ctx.telegram.sendMessage(
      ctx.chatId,
      "Session cleared. Fresh start ready.",
    );
  } catch (err) {
    log.error("reset failed", {
      bot_id: ctx.botConfig.id,
      error: err instanceof Error ? err.message : String(err),
    });
    await ctx.telegram.sendMessage(ctx.chatId, "Reset failed. See logs.");
  }
}

async function handleStatus(ctx: CommandContext): Promise<void> {
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
  await ctx.telegram.sendMessage(ctx.chatId, lines);
}

async function handleHealth(ctx: CommandContext): Promise<void> {
  const snap = ctx.getStatus();
  const healthy = snap.runner_ready && !snap.disabled && snap.mailbox_depth < 5;
  await ctx.telegram.sendMessage(
    ctx.chatId,
    healthy ? "✅ healthy" : "⚠️ degraded",
  );
}
