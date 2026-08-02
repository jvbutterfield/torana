// Telegram compatibility entry point. Webhook and polling transports still
// deliver TelegramUpdate in config v1; the adapter normalizes the payload and
// the platform-neutral processor owns all subsequent policy and enqueue work.

import type { AlertManager } from "../alerts.js";
import type { BotConfig, Config } from "../config/schema.js";
import type { GatewayDB } from "../db/gateway-db.js";
import { TelegramAdapter } from "../platform/telegram/adapter.js";
import type { TelegramClient } from "../telegram/client.js";
import type { TelegramUpdate } from "../telegram/types.js";
import type { CommandContext } from "./commands.js";
import {
  processInboundEvent,
  type ProcessInboundOutcome,
} from "./process-inbound-event.js";

export type ProcessUpdateOutcome = ProcessInboundOutcome;

export interface ProcessUpdateDeps {
  config: Config;
  db: GatewayDB;
  botConfig: BotConfig;
  telegram: TelegramClient;
  alerts?: AlertManager;
  onEnqueued?: (turnId: number) => void;
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
  const adapter = new TelegramAdapter(deps.botConfig.id, deps.telegram);
  const event = adapter.normalizeInbound(update);
  if (!event) return { status: "dropped_malformed" };
  return await processInboundEvent({ ...deps, adapter }, event);
}
