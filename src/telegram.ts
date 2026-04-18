import { logger } from "./log.js";
import type { PersonaName } from "./config.js";

const log = logger("telegram");

export class TelegramClient {
  private token: string;
  private persona: PersonaName;

  constructor(persona: PersonaName, token: string) {
    this.persona = persona;
    this.token = token;
  }

  private async api(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: any; description?: string }> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json() as any;
    if (!data.ok) {
      log.warn(`${method} failed`, { persona: this.persona, status: resp.status, description: data.description });
    }
    return data;
  }

  async setWebhook(webhookUrl: string, secret: string): Promise<boolean> {
    log.info("setting webhook", { persona: this.persona, url: webhookUrl });
    const result = await this.api("setWebhook", {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    });
    if (result.ok) {
      log.info("webhook set", { persona: this.persona });
    }
    return result.ok;
  }

  async sendMessage(chatId: number, text: string, parseMode?: string): Promise<{ messageId: number } | null> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;
    const result = await this.api("sendMessage", body);
    if (result.ok && result.result) {
      return { messageId: result.result.message_id };
    }
    return null;
  }

  async editMessageText(chatId: number, messageId: number, text: string, parseMode?: string): Promise<boolean> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (parseMode) body.parse_mode = parseMode;
    const result = await this.api("editMessageText", body);
    return result.ok;
  }

  async setMessageReaction(chatId: number, messageId: number, emoji: string): Promise<boolean> {
    const result = await this.api("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
    });
    return result.ok;
  }

  async sendChatAction(chatId: number, action: string = "typing"): Promise<boolean> {
    const result = await this.api("sendChatAction", { chat_id: chatId, action });
    return result.ok;
  }

  async getFile(fileId: string): Promise<{ filePath: string } | null> {
    const result = await this.api("getFile", { file_id: fileId });
    if (result.ok && result.result?.file_path) {
      return { filePath: result.result.file_path };
    }
    return null;
  }

  async downloadFile(filePath: string): Promise<ArrayBuffer | null> {
    const url = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        log.warn("file download failed", { persona: this.persona, status: resp.status, filePath });
        return null;
      }
      return await resp.arrayBuffer();
    } catch (err) {
      log.error("file download error", { persona: this.persona, filePath, error: String(err) });
      return null;
    }
  }
}
