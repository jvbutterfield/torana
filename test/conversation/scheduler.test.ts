import { describe, expect, test } from "bun:test";

import { ConversationScheduler } from "../../src/conversation/scheduler.js";
import type { RunnerSession } from "../../src/runner/types.js";
import type { ManagedTurnOutcome } from "../../src/core/bot.js";

const session: RunnerSession = {
  id: "session-test",
  sendTurn: (turnId) => ({ accepted: true, turnId }),
  cancel: async () => {},
  reset: async () => {},
  stop: async () => {},
  on: () => () => {},
};

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("ConversationScheduler", () => {
  test("runs separate conversations concurrently but never overlaps a shared session", async () => {
    const rows = [
      {
        id: 1,
        bot_id: "alpha",
        chat_id: 10,
        source_update_id: 1,
        conversation_id: 1,
        session_key: "alias:alpha:shared",
        agent_api_token_name: null,
        received_at: new Date().toISOString(),
        conversation_archived: 0,
      },
      {
        id: 2,
        bot_id: "alpha",
        chat_id: 11,
        source_update_id: 2,
        conversation_id: 2,
        session_key: "alias:alpha:shared",
        agent_api_token_name: null,
        received_at: new Date().toISOString(),
        conversation_archived: 0,
      },
      {
        id: 3,
        bot_id: "alpha",
        chat_id: 12,
        source_update_id: 3,
        conversation_id: 3,
        session_key: "conversation:independent",
        agent_api_token_name: null,
        received_at: new Date().toISOString(),
        conversation_archived: 0,
      },
    ];
    const dispatched: number[] = [];
    const terminals = new Map<number, (outcome: ManagedTurnOutcome) => void>();
    const db = {
      getQueuedConversationTurns: () =>
        rows.filter((row) => !dispatched.includes(row.id)),
      getTurnText: () => "hello",
      getTurnAttachments: () => [],
      setConversationSessionError: () => {},
      getConversationSession: () => null,
      deadLetterTurn: () => true,
    };
    const manager = {
      acquireConversation: async (
        _botId: string,
        durableSessionKey: string,
      ) => ({
        kind: "ok" as const,
        sessionId: durableSessionKey,
        ephemeral: false,
        runnerSession: session,
        durableSessionKey,
      }),
      release: () => {},
    };
    const bot = {
      dispatchSessionTurn: (
        _key: string,
        _session: RunnerSession,
        turnId: number,
        _chatId: number,
        _text: string,
        _attachments: string[],
        terminal: (outcome: ManagedTurnOutcome) => void,
      ) => {
        dispatched.push(turnId);
        terminals.set(turnId, terminal);
        return true;
      },
      cancelManagedTurn: () => {},
    };
    const scheduler = new ConversationScheduler({
      db: db as never,
      registry: { bot: () => bot } as never,
      manager: manager as never,
      normalized: {
        sourceVersion: 2,
        endpoints: [],
        sessions: {
          scope: "conversation",
          idle_process_ttl_ms: 60_000,
          hard_process_ttl_ms: 60_000,
          context_retention_ms: 60_000,
          max_per_agent: 8,
          max_global: 32,
          max_per_token_default: 8,
          max_concurrent_turns_per_agent: 2,
          max_concurrent_turns_global: 2,
          max_queue_depth_per_conversation: 50,
          max_queue_depth_per_agent: 500,
          overflow: "queue",
          aliases: [],
        },
      },
    });

    scheduler.wake();
    await settle();
    expect(dispatched).toEqual([1, 3]);
    expect(dispatched).not.toContain(2);

    terminals.get(1)!({ kind: "completed" });
    await settle();
    expect(dispatched).toEqual([1, 3, 2]);
    terminals.get(2)!({ kind: "completed" });
    terminals.get(3)!({ kind: "completed" });
    scheduler.stop();
  });

  test("interrupts a timed-out turn and releases its session", async () => {
    const row = {
      id: 9,
      bot_id: "alpha",
      chat_id: 10,
      source_update_id: 9,
      conversation_id: 9,
      session_key: "conversation:timeout",
      agent_api_token_name: null,
      received_at: new Date().toISOString(),
      conversation_archived: 0,
    };
    let terminal: ((outcome: ManagedTurnOutcome) => void) | null = null;
    let cancelled = false;
    let released = false;
    const scheduler = new ConversationScheduler({
      db: {
        getQueuedConversationTurns: () => (terminal ? [] : [row]),
        getTurnText: () => "hang",
        getTurnAttachments: () => [],
        setConversationSessionError: () => {},
        getConversationSession: () => null,
        getWorkerState: () => null,
        updateWorkerState: () => {},
      } as never,
      registry: {
        bot: () => ({
          dispatchSessionTurn: (...args: unknown[]) => {
            terminal = args.at(-1) as (outcome: ManagedTurnOutcome) => void;
            return true;
          },
          cancelManagedTurn: () => {
            cancelled = true;
            terminal?.({ kind: "interrupted", reason: "turn timeout" });
            return true;
          },
        }),
      } as never,
      manager: {
        acquireConversation: async () => ({
          kind: "ok" as const,
          sessionId: "session-timeout",
          ephemeral: false,
          runnerSession: session,
          durableSessionKey: row.session_key,
        }),
        cancelConversation: async () => true,
        release: () => {
          released = true;
        },
      } as never,
      normalized: {
        sourceVersion: 2,
        endpoints: [],
        sessions: {
          scope: "conversation",
          idle_process_ttl_ms: 60_000,
          hard_process_ttl_ms: 60_000,
          context_retention_ms: 60_000,
          max_per_agent: 8,
          max_global: 32,
          max_per_token_default: 8,
          max_concurrent_turns_per_agent: 2,
          max_concurrent_turns_global: 2,
          max_queue_depth_per_conversation: 50,
          max_queue_depth_per_agent: 500,
          overflow: "queue",
          aliases: [],
        },
      },
      workerTuning: {
        turn_timeout_secs: 0.01,
        max_consecutive_failures: 3,
      } as never,
    });
    scheduler.wake();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(cancelled).toBe(true);
    expect(released).toBe(true);
    scheduler.stop();
  });

  test("dead-letters stale and archived queue heads before dispatch", async () => {
    const dead: Array<[number, string]> = [];
    let acquired = false;
    const scheduler = new ConversationScheduler({
      db: {
        getQueuedConversationTurns: () => [
          {
            id: 20,
            bot_id: "alpha",
            chat_id: 20,
            source_update_id: 20,
            conversation_id: 20,
            session_key: "conversation:stale",
            agent_api_token_name: null,
            received_at: new Date(Date.now() - 120_000).toISOString(),
            conversation_archived: 0,
          },
          {
            id: 21,
            bot_id: "alpha",
            chat_id: 21,
            source_update_id: 21,
            conversation_id: 21,
            session_key: "conversation:archived",
            agent_api_token_name: null,
            received_at: new Date().toISOString(),
            conversation_archived: 1,
          },
        ],
        deadLetterTurn: (id: number, reason: string) => {
          dead.push([id, reason]);
          return true;
        },
      } as never,
      registry: { bot: () => undefined } as never,
      manager: {
        acquireConversation: async () => {
          acquired = true;
          return { kind: "capacity" as const };
        },
      } as never,
      normalized: {
        sourceVersion: 2,
        endpoints: [],
        sessions: {
          scope: "conversation",
          idle_process_ttl_ms: 60_000,
          hard_process_ttl_ms: 60_000,
          context_retention_ms: 60_000,
          max_per_agent: 8,
          max_global: 32,
          max_per_token_default: 8,
          max_concurrent_turns_per_agent: 2,
          max_concurrent_turns_global: 2,
          max_queue_depth_per_conversation: 50,
          max_queue_depth_per_agent: 500,
          overflow: "queue",
          aliases: [],
        },
      },
    });
    scheduler.wake();
    await settle();
    expect(dead).toEqual([
      [20, "dispatch retention expired"],
      [21, "conversation archived"],
    ]);
    expect(acquired).toBe(false);
    scheduler.stop();
  });

  test("quarantines a poisoned conversation without tripping the agent breaker", async () => {
    const row = {
      id: 30,
      bot_id: "alpha",
      chat_id: 30,
      source_update_id: 30,
      conversation_id: 30,
      session_key: "conversation:poison",
      agent_api_token_name: null,
      received_at: new Date().toISOString(),
      conversation_archived: 0,
    };
    let lastError: string | null = null;
    let deadReason: string | null = null;
    let agentUpdates = 0;
    const scheduler = new ConversationScheduler({
      db: {
        getQueuedConversationTurns: () => [row],
        getConversationSession: () => ({ last_error: lastError }),
        setConversationSessionError: (_key: string, reason: string) => {
          lastError = reason;
        },
        deadLetterNextQueuedSessionTurn: (_key: string, reason: string) => {
          deadReason = reason;
          return row.id;
        },
        getWorkerState: () => ({ consecutive_failures: 0 }),
        updateWorkerState: () => {
          agentUpdates += 1;
        },
      } as never,
      registry: { bot: () => undefined } as never,
      manager: {
        acquireConversation: async () => ({
          kind: "runner_error" as const,
          message: "poisoned conversation state",
        }),
      } as never,
      normalized: {
        sourceVersion: 2,
        endpoints: [],
        sessions: {
          scope: "conversation",
          idle_process_ttl_ms: 60_000,
          hard_process_ttl_ms: 60_000,
          context_retention_ms: 60_000,
          max_per_agent: 8,
          max_global: 32,
          max_per_token_default: 8,
          max_concurrent_turns_per_agent: 2,
          max_concurrent_turns_global: 2,
          max_queue_depth_per_conversation: 50,
          max_queue_depth_per_agent: 500,
          overflow: "queue",
          aliases: [],
        },
      },
      workerTuning: {
        turn_timeout_secs: 60,
        max_consecutive_failures: 2,
      } as never,
    });
    scheduler.wake();
    await settle();
    scheduler.wake();
    await settle();
    expect(String(deadReason)).toContain(
      "conversation quarantined after 2 failures",
    );
    expect(agentUpdates).toBe(0);
    scheduler.stop();
  });
});
