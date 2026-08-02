import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationSessionManager } from "../../src/conversation/manager.js";
import {
  agentApiSessionKey,
  runnerSessionId,
} from "../../src/conversation/session-key.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations } from "../../src/db/migrate.js";
import {
  RunnerEventEmitter,
  type AgentRunner,
  type RunnerEventHandler,
  type RunnerEventKind,
  type SideSessionStartOptions,
} from "../../src/runner/types.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

class FakeRunner implements AgentRunner {
  readonly botId = "alpha";
  readonly starts: Array<{
    id: string;
    resumeState: Record<string, unknown> | undefined;
  }> = [];
  private emitters = new Map<string, RunnerEventEmitter>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  sendTurn() {
    return { accepted: false as const, reason: "not_ready" as const };
  }
  async reset(): Promise<void> {}
  supportsReset(): boolean {
    return true;
  }
  isReady(): boolean {
    return true;
  }
  on<E extends RunnerEventKind>(_event: E, _handler: RunnerEventHandler<E>) {
    return () => {};
  }
  supportsSideSessions(): boolean {
    return true;
  }
  async startSideSession(
    id: string,
    options: SideSessionStartOptions = {},
  ): Promise<void> {
    this.starts.push({ id, resumeState: options.resumeState });
    this.emitters.set(id, new RunnerEventEmitter());
    options.onResumeStateChanged?.({ version: 1, thread_id: "thread-123" });
  }
  sendSideTurn(_id: string, turnId: string) {
    return { accepted: true as const, turnId };
  }
  async stopSideSession(id: string): Promise<void> {
    this.emitters.delete(id);
  }
  onSide<E extends RunnerEventKind>(
    id: string,
    event: E,
    handler: RunnerEventHandler<E>,
  ) {
    return this.emitters.get(id)!.on(event, handler);
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function setup(
  runner: FakeRunner,
  options: { clock?: () => number; contextRetentionMs?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "torana-conversation-manager-"));
  dirs.push(dir);
  const dbPath = join(dir, "gateway.db");
  applyMigrations(dbPath);
  const db = new GatewayDB(dbPath);
  const botConfig = makeTestBotConfig("alpha", {
    runner: {
      type: "codex",
      cli_path: "codex",
      args: [],
      env: {},
      pass_resume_flag: true,
      approval_mode: "full-auto",
      sandbox: "workspace-write",
      acknowledge_dangerous: false,
    },
  });
  const config = makeTestConfig([botConfig]);
  const registry = {
    bot: (id: string) => (id === "alpha" ? { botConfig, runner } : undefined),
  };
  return {
    db,
    dbPath,
    manager: new ConversationSessionManager({
      config,
      db,
      registry: registry as never,
      clock: options.clock,
      contextRetentionMs: options.contextRetentionMs,
    }),
  };
}

describe("ConversationSessionManager", () => {
  test("runner id is stable, opaque, lowercase base32, and 46 chars", () => {
    const id = runnerSessionId("conversation:contains-sensitive-chat-id");
    expect(id).toHaveLength(46);
    expect(id).toMatch(/^session-[a-z2-7]{38}$/);
    expect(id).toBe(runnerSessionId("conversation:contains-sensitive-chat-id"));
  });

  test("persists provider state and lazily restores it after restart", async () => {
    const firstRunner = new FakeRunner();
    const first = setup(firstRunner);
    const key = "conversation:abc";
    const acquired = await first.manager.acquireConversation("alpha", key);
    expect(acquired.kind).toBe("ok");
    if (acquired.kind !== "ok") throw new Error("acquire failed");
    expect(firstRunner.starts[0]?.id).toBe(runnerSessionId(key));
    first.manager.release("alpha", acquired.sessionId);
    await first.manager.shutdown(10);
    first.db.close();

    // Reopen the same durable database with a fresh manager/runner process.
    const db = new GatewayDB(first.dbPath);
    const secondRunner = new FakeRunner();
    const botConfig = makeTestBotConfig("alpha", {
      runner: {
        type: "codex",
        cli_path: "codex",
        args: [],
        env: {},
        pass_resume_flag: true,
        approval_mode: "full-auto",
        sandbox: "workspace-write",
        acknowledge_dangerous: false,
      },
    });
    const config = makeTestConfig([botConfig]);
    const manager = new ConversationSessionManager({
      config,
      db,
      registry: {
        bot: () => ({ botConfig, runner: secondRunner }),
      } as never,
    });
    const restored = await manager.acquireConversation("alpha", key);
    expect(restored.kind).toBe("ok");
    expect(secondRunner.starts[0]?.resumeState).toEqual({
      version: 1,
      thread_id: "thread-123",
    });
    await manager.shutdown(10);
    db.close();
  });

  test("same durable session is busy while acquired", async () => {
    const runner = new FakeRunner();
    const { db, manager } = setup(runner);
    const first = await manager.acquireConversation(
      "alpha",
      "alias:alpha:shared",
    );
    const second = await manager.acquireConversation(
      "alpha",
      "alias:alpha:shared",
    );
    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("busy");
    await manager.shutdown(10);
    db.close();
  });

  test("context expiration clears Codex resume state without process eviction", async () => {
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    const runner = new FakeRunner();
    const { db, manager } = setup(runner, {
      clock: () => now,
      contextRetentionMs: 1_000,
    });
    const key = "conversation:expires";
    const first = await manager.acquireConversation("alpha", key);
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") throw new Error("acquire failed");
    manager.release("alpha", first.sessionId);
    expect(runner.starts[0]?.resumeState).toBeUndefined();

    now += 2_000;
    const rotated = await manager.acquireConversation("alpha", key);
    expect(rotated.kind).toBe("ok");
    expect(runner.starts).toHaveLength(2);
    expect(runner.starts[1]?.resumeState).toBeUndefined();
    expect(db.getConversationSession(key)?.generation).toBe(1);
    await manager.shutdown(10);
    db.close();
  });

  test("Agent API keyed session key follows the normalized contract", () => {
    expect(agentApiSessionKey("alpha", "caller-key")).toBe(
      "agent-api:alpha:session:caller-key",
    );
  });
});
