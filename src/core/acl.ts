// ACL resolution — per-bot overrides replace the global list (§3.4).

import type { BotConfig, Config } from "../config/schema.js";

export function resolveAllowedUserIds(
  config: Config,
  bot: BotConfig,
): readonly number[] {
  if (bot.access_control) return bot.access_control.allowed_user_ids;
  return config.access_control.allowed_user_ids;
}

export function isAuthorized(
  config: Config,
  bot: BotConfig,
  userId: number,
): boolean {
  const allowed = resolveAllowedUserIds(config, bot);
  return allowed.includes(userId);
}
