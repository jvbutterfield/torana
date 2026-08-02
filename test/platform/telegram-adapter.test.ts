import { describe, expect, test } from "bun:test";

import { TelegramAdapter } from "../../src/platform/telegram/adapter.js";
import { TelegramClient } from "../../src/telegram/client.js";
import type { TelegramUpdate } from "../../src/telegram/types.js";

type CapturedCall = { method: string; body: Record<string, unknown> };

function harness(
  responses: Array<{
    ok: boolean;
    result?: unknown;
    description?: string;
  }> = [],
) {
  const calls: CapturedCall[] = [];
  const client = new TelegramClient({
    botId: "alpha",
    token: "test-token",
    fetchImpl: (async (input, init) => {
      const url = String(input);
      calls.push({
        method: url.slice(url.lastIndexOf("/") + 1),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      const response = responses.shift() ?? {
        ok: true,
        result: { message_id: 9001 },
      };
      return new Response(
        JSON.stringify(
          response.ok
            ? response
            : {
                ok: false,
                error_code: 400,
                description: response.description ?? "bad request",
              },
        ),
        { status: response.ok ? 200 : 400 },
      );
    }) as typeof fetch,
  });
  return { adapter: new TelegramAdapter("alpha", client), calls };
}

function update(): TelegramUpdate {
  return {
    update_id: 42,
    message: {
      message_id: 77,
      date: 1_700_000_000,
      chat: { id: -100123, type: "supergroup" },
      from: {
        id: 1234,
        is_bot: false,
        first_name: "Ada",
        last_name: "Lovelace",
        username: "ada",
      },
      caption: "Review these",
      photo: [
        {
          file_id: "small",
          file_unique_id: "s",
          width: 10,
          height: 10,
          file_size: 100,
        },
        {
          file_id: "large",
          file_unique_id: "l",
          width: 100,
          height: 100,
          file_size: 1_000,
        },
      ],
      document: {
        file_id: "doc",
        file_unique_id: "d",
        file_name: "brief.pdf",
        mime_type: "application/pdf",
        file_size: 2_000,
      },
      voice: { file_id: "voice", duration: 2 },
    },
  };
}

describe("TelegramAdapter", () => {
  test("normalizes native IDs, principals, conversations, and attachments", () => {
    const { adapter } = harness();
    const event = adapter.normalizeInbound(update());

    expect(event).not.toBeNull();
    expect(event).toMatchObject({
      platform: "telegram",
      endpointId: "alpha",
      agentId: "alpha",
      externalEventId: "42",
      externalMessageId: "77",
      text: "Review these",
      sender: {
        id: "1234",
        kind: "human",
        displayName: "Ada Lovelace",
        username: "ada",
      },
      conversation: {
        platform: "telegram",
        endpointId: "alpha",
        channelId: "-100123",
        type: "group",
      },
    });
    expect(event?.attachments.map((attachment) => attachment.kind)).toEqual([
      "image",
      "document",
      "voice",
    ]);
    expect(event?.attachments[0]?.externalId).toBe("large");
    expect(event?.receivedSeq).toBe(1);
    expect(adapter.normalizeInbound(update())?.receivedSeq).toBe(2);
  });

  test("advertises only implemented endpoint capabilities", () => {
    const { adapter } = harness();
    expect([...adapter.endpoint.capabilities].sort()).toEqual([
      "attachment_download",
      "edit",
      "reaction_add",
      "send",
      "typing",
    ]);
  });

  test("delivers send/edit/reaction/typing with unchanged Telegram shapes", async () => {
    const { adapter, calls } = harness([
      { ok: true, result: { message_id: 9001 } },
      { ok: true, result: true },
      { ok: true, result: true },
      { ok: true, result: true },
    ]);
    const conversation = adapter.normalizeInbound(update())!.conversation!;

    await expect(
      adapter.deliver(conversation, {
        kind: "send",
        text: "**hello**",
        files: [],
      }),
    ).resolves.toEqual({ ok: true, externalMessageId: "9001" });
    await adapter.deliver(conversation, {
      kind: "edit",
      externalMessageId: "77",
      text: "updated",
    });
    await adapter.deliver(conversation, {
      kind: "reaction_add",
      externalMessageId: "77",
      emoji: "👀",
    });
    await adapter.signal(conversation, { kind: "typing", active: true });

    expect(calls).toEqual([
      {
        method: "sendMessage",
        body: {
          chat_id: -100123,
          text: "<b>hello</b>",
          parse_mode: "HTML",
        },
      },
      {
        method: "editMessageText",
        body: {
          chat_id: -100123,
          message_id: 77,
          text: "updated",
          parse_mode: "HTML",
        },
      },
      {
        method: "setMessageReaction",
        body: {
          chat_id: -100123,
          message_id: 77,
          reaction: [{ type: "emoji", emoji: "👀" }],
        },
      },
      {
        method: "sendChatAction",
        body: { chat_id: -100123, action: "typing" },
      },
    ]);
  });

  test("keeps the HTML-to-plain-text fallback inside the adapter", async () => {
    const { adapter, calls } = harness([
      { ok: false, description: "can't parse entities" },
      { ok: true, result: { message_id: 9 } },
    ]);
    const conversation = adapter.normalizeInbound(update())!.conversation!;

    await expect(
      adapter.deliver(conversation, {
        kind: "send",
        text: "**hello**",
        files: [],
      }),
    ).resolves.toEqual({ ok: true, externalMessageId: "9" });
    expect(calls[0]?.body.parse_mode).toBe("HTML");
    expect(calls[1]?.body).toEqual({ chat_id: -100123, text: "**hello**" });
  });

  test("fails unsupported operations without invoking Telegram", async () => {
    const { adapter, calls } = harness();
    const conversation = adapter.normalizeInbound(update())!.conversation!;
    const result = await adapter.deliver(conversation, {
      kind: "delete",
      externalMessageId: "77",
    });
    expect(result).toEqual({
      ok: false,
      retriable: false,
      description: "Telegram endpoint does not support delete",
    });
    expect(calls).toHaveLength(0);
  });
});
