// CommandDispatcher tests — parseCommand + dispatchCommand.
// Covers: /reset, /status, /health, unknown commands, reset-unsupported runner,
// reset error → user-visible error message.

import { describe, expect, test } from "bun:test";
import {
  dispatchCommand,
  parseCommand,
  type CommandContext,
} from "../../src/core/commands.js";
import type { BotConfig } from "../../src/config/schema.js";
import type { AgentRunner } from "../../src/runner/types.js";
import type { TelegramClient } from "../../src/telegram/client.js";

function stubRunner(overrides: Partial<AgentRunner> = {}): AgentRunner {
  return {
    botId: "alpha",
    async start() { /* */ },
    async stop() { /* */ },
    sendTurn: () => ({ accepted: false, reason: "not_ready" }),
    async reset() { /* */ },
    supportsReset: () => true,
    isReady: () => true,
    on: () => () => { /* */ },
    supportsSideSessions: () => false,
    async startSideSession() { throw new Error("unsupported"); },
    sendSideTurn: () => { throw new Error("unsupported"); },
    async stopSideSession() { throw new Error("unsupported"); },
    onSide: () => { throw new Error("unsupported"); },
    ...overrides,
  };
}

function stubTelegram(): { client: TelegramClient; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client = {
    async sendMessage(chatId: number, text: string) {
      calls.push({ method: "sendMessage", args: [chatId, text] });
      return { messageId: 1 };
    },
  } as unknown as TelegramClient;
  return { client, calls };
}

function buildCtx(opts: {
  botConfig: BotConfig;
  runner?: AgentRunner;
  rawText?: string;
}): { ctx: CommandContext; calls: Array<{ method: string; args: unknown[] }> } {
  const { client, calls } = stubTelegram();
  const ctx: CommandContext = {
    botConfig: opts.botConfig,
    chatId: 111,
    messageId: 1,
    fromUserId: 42,
    rawText: opts.rawText ?? "",
    telegram: client,
    runner: opts.runner ?? stubRunner(),
    getStatus: () => ({
      botId: opts.botConfig.id,
      runner_ready: true,
      mailbox_depth: 0,
      last_turn_at: null,
      disabled: false,
      disabled_reason: null,
    }),
  };
  return { ctx, calls };
}

function makeBotConfig(
  commands: BotConfig["commands"],
): BotConfig {
  return {
    id: "alpha",
    token: "TT:AAAA",
    commands,
    reactions: { received_emoji: "👀" },
    runner: {
      type: "claude-code",
      cli_path: "claude",
      args: [],
      env: {},
      pass_continue_flag: true,
    },
  };
}

// --- parseCommand ---

describe("parseCommand", () => {
  test("returns null for non-command text", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand(" hello")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });

  test("parses trigger without arguments", () => {
    expect(parseCommand("/reset")).toEqual({ trigger: "/reset", rest: "" });
  });

  test("parses trigger with arguments", () => {
    expect(parseCommand("/reset now please")).toEqual({
      trigger: "/reset",
      rest: "now please",
    });
  });

  test("trims leading whitespace", () => {
    expect(parseCommand("  /reset")).toEqual({ trigger: "/reset", rest: "" });
  });

  test("handles tab separator", () => {
    expect(parseCommand("/reset\targ")).toEqual({ trigger: "/reset", rest: "arg" });
  });
});

// --- dispatchCommand ---

describe("dispatchCommand: /reset", () => {
  test("calls runner.reset() and replies with confirmation", async () => {
    let resetCalled = false;
    const runner = stubRunner({ async reset() { resetCalled = true; } });
    const { ctx, calls } = buildCtx({
      botConfig: makeBotConfig([{ trigger: "/reset", action: "builtin:reset" }]),
      runner,
    });
    const result = await dispatchCommand(ctx, { trigger: "/reset", rest: "" });
    expect(result.handled).toBe(true);
    expect(resetCalled).toBe(true);
    const reply = calls.find((c) => c.method === "sendMessage");
    expect(reply).toBeDefined();
    expect(String(reply!.args[1])).toMatch(/session cleared/i);
  });

  test("returns handled=false when trigger isn't bound", async () => {
    const { ctx } = buildCtx({
      botConfig: makeBotConfig([]),
    });
    const result = await dispatchCommand(ctx, { trigger: "/reset", rest: "" });
    expect(result.handled).toBe(false);
  });

  test("replies with 'not supported' when runner.supportsReset() is false", async () => {
    const runner = stubRunner({ supportsReset: () => false });
    const { ctx, calls } = buildCtx({
      botConfig: makeBotConfig([{ trigger: "/reset", action: "builtin:reset" }]),
      runner,
    });
    const result = await dispatchCommand(ctx, { trigger: "/reset", rest: "" });
    expect(result.handled).toBe(true);
    const reply = calls.find((c) => c.method === "sendMessage");
    expect(String(reply!.args[1])).toContain("does not support");
  });

  test("reports error to user when runner.reset() throws", async () => {
    const runner = stubRunner({
      async reset() { throw new Error("boom"); },
    });
    const { ctx, calls } = buildCtx({
      botConfig: makeBotConfig([{ trigger: "/reset", action: "builtin:reset" }]),
      runner,
    });
    const result = await dispatchCommand(ctx, { trigger: "/reset", rest: "" });
    expect(result.handled).toBe(true);
    const reply = calls.find((c) => c.method === "sendMessage");
    expect(String(reply!.args[1]).toLowerCase()).toContain("failed");
  });
});

describe("dispatchCommand: /status", () => {
  test("replies with a multi-line status summary", async () => {
    const { ctx, calls } = buildCtx({
      botConfig: makeBotConfig([{ trigger: "/status", action: "builtin:status" }]),
    });
    await dispatchCommand(ctx, { trigger: "/status", rest: "" });
    const reply = calls.find((c) => c.method === "sendMessage");
    const text = String(reply!.args[1]);
    expect(text).toContain("Bot: alpha");
    expect(text).toContain("Runner: ready");
    expect(text).toContain("Mailbox: 0 queued");
  });

  test("shows 'DISABLED' when bot is disabled", async () => {
    const { client, calls } = stubTelegram();
    const ctx: CommandContext = {
      botConfig: makeBotConfig([{ trigger: "/status", action: "builtin:status" }]),
      chatId: 111,
      messageId: 1,
      fromUserId: 42,
      rawText: "/status",
      telegram: client,
      runner: stubRunner(),
      getStatus: () => ({
        botId: "alpha",
        runner_ready: false,
        mailbox_depth: 0,
        last_turn_at: null,
        disabled: true,
        disabled_reason: "token invalid",
      }),
    };
    await dispatchCommand(ctx, { trigger: "/status", rest: "" });
    const reply = calls.find((c) => c.method === "sendMessage");
    const text = String(reply!.args[1]);
    expect(text).toContain("DISABLED");
    expect(text).toContain("token invalid");
    expect(text).toContain("Runner: not ready");
  });
});

describe("dispatchCommand: /health", () => {
  test("replies with ✅ healthy when ready+not-disabled+empty mailbox", async () => {
    const { ctx, calls } = buildCtx({
      botConfig: makeBotConfig([{ trigger: "/health", action: "builtin:health" }]),
    });
    await dispatchCommand(ctx, { trigger: "/health", rest: "" });
    const reply = calls.find((c) => c.method === "sendMessage");
    expect(String(reply!.args[1])).toContain("healthy");
  });

  test("replies with ⚠️ degraded when runner not ready", async () => {
    const { client, calls } = stubTelegram();
    const ctx: CommandContext = {
      botConfig: makeBotConfig([{ trigger: "/health", action: "builtin:health" }]),
      chatId: 111,
      messageId: 1,
      fromUserId: 42,
      rawText: "/health",
      telegram: client,
      runner: stubRunner({ isReady: () => false }),
      getStatus: () => ({
        botId: "alpha",
        runner_ready: false,
        mailbox_depth: 0,
        last_turn_at: null,
        disabled: false,
        disabled_reason: null,
      }),
    };
    await dispatchCommand(ctx, { trigger: "/health", rest: "" });
    const reply = calls.find((c) => c.method === "sendMessage");
    expect(String(reply!.args[1])).toContain("degraded");
  });

  test("replies with ⚠️ degraded when mailbox_depth >= 5", async () => {
    const { client, calls } = stubTelegram();
    const ctx: CommandContext = {
      botConfig: makeBotConfig([{ trigger: "/health", action: "builtin:health" }]),
      chatId: 111,
      messageId: 1,
      fromUserId: 42,
      rawText: "/health",
      telegram: client,
      runner: stubRunner(),
      getStatus: () => ({
        botId: "alpha",
        runner_ready: true,
        mailbox_depth: 8,
        last_turn_at: null,
        disabled: false,
        disabled_reason: null,
      }),
    };
    await dispatchCommand(ctx, { trigger: "/health", rest: "" });
    const reply = calls.find((c) => c.method === "sendMessage");
    expect(String(reply!.args[1])).toContain("degraded");
  });
});
