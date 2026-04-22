// Resolve a send call's target to a concrete chat_id.
//
// Callers may pass `user_id` (lookup the most-recent authorized chat via
// the `user_chats` table populated by processUpdate) or `chat_id` directly
// (must still belong to this bot — prevents forging messages into chats
// the caller has never DMed).
//
// See tasks/impl-agent-api.md §6.3.

import type { BotId } from "../config/schema.js";
import type { GatewayDB } from "../db/gateway-db.js";

export type ResolveChatResult =
  | { kind: "ok"; chatId: number }
  | {
      kind: "err";
      code: "missing_target" | "user_not_opened_bot" | "chat_not_permitted";
    };

export function resolveChatId(
  db: GatewayDB,
  botId: BotId,
  input: { user_id?: string; chat_id?: number },
): ResolveChatResult {
  if (input.chat_id !== undefined) {
    const rows = db.listUserChatsByBot(botId);
    if (!rows.some((r) => r.chat_id === input.chat_id)) {
      return { kind: "err", code: "chat_not_permitted" };
    }
    return { kind: "ok", chatId: input.chat_id };
  }
  if (input.user_id !== undefined) {
    const row = db.getLastChatForUser(botId, input.user_id);
    if (!row) return { kind: "err", code: "user_not_opened_bot" };
    return { kind: "ok", chatId: row.chat_id };
  }
  return { kind: "err", code: "missing_target" };
}
