// Subset of the Telegram Bot API types we actually use. Hand-written to keep
// the dep surface small; adding a full third-party type package is not worth
// the churn for the 10 fields we care about.

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  mime_type?: string;
  file_size?: number;
  duration?: number;
}

export interface TelegramVoice {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramSticker {
  file_id: string;
  type: string;
}

export interface TelegramAnimation {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  sticker?: TelegramSticker;
  animation?: TelegramAnimation;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramWebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  ip_address?: string;
  last_error_date?: number;
  last_error_message?: string;
}

/** Normalized attachment passed to runners. */
export interface Attachment {
  kind: "photo" | "document";
  path: string;
  mime_type?: string;
  original_filename?: string;
  bytes: number;
}
