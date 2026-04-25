// Exercises Bot's crash-loop backoff via a stub runner that can be forced to
// emit `fatal`. No subprocess spawning — pure unit-level coverage of the
// onFatal → schedule-restart logic.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Bot } from "../../src/core/bot.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { Metrics } from "../../src/metrics.js";
import { AlertManager } from "../../src/alerts.js";
import { OutboxProcessor } from "../../src/outbox.js";
import { StreamManager } from "../../src/streaming.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";
import { RunnerEventEmitter } from "../../src/runner/types.js";
import type {
  AgentRunner,
  RunnerEvent,
  RunnerEventHandler,
  RunnerEventKind,
  SendTurnResult,
  Unsubscribe,
} from "../../src/runner/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSchema(dbPath: string): void {
  const sql =
    readFileSync(resolve(__dirname, "../../src/db/schema.sql"), "utf8") +
    "\nPRAGMA user_version=1;";
  const raw = new Database(dbPath, { create: true });
  raw.exec(sql);
  raw.close();
}

/** Stub runner whose lifecycle the test controls directly. */
class StubRunner implements AgentRunner {
  readonly botId: string;
  private emitter = new RunnerEventEmitter();
  startCalls = 0;
  stopCalls = 0;
  private _isReady = false;

  constructor(botId: string) {
    this.botId = botId;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    this._isReady = true;
    this.emitter.emit({ kind: "ready" });
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this._isReady = false;
  }

  sendTurn(): SendTurnResult {
    return { accepted: false, reason: "not_ready" };
  }

  async reset(): Promise<void> {}

  supportsReset(): boolean {
    return true;
  }

  isReady(): boolean {
    return this._isReady;
  }

  on<E extends RunnerEventKind>(
    event: E,
    handler: RunnerEventHandler<E>,
  ): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  supportsSideSessions(): boolean {
    return false;
  }
  async startSideSession(): Promise<void> {
    throw new Error("not supported");
  }
  sendSideTurn(): SendTurnResult {
    throw new Error("not supported");
  }
  async stopSideSession(): Promise<void> {
    throw new Error("not supported");
  }
  onSide(): Unsubscribe {
    throw new Error("not supported");
  }

  simulateFatal(
    code: "auth" | "exit" | "spawn" | "protocol",
    message: string,
  ): void {
    this._isReady = false;
    this.emitter.emit({ kind: "fatal", code, message });
  }
}

/** Build a Bot whose runner is the StubRunner (bypass instantiateRunner). */
function buildBotWithStubRunner(
  db: GatewayDB,
  tmpDir: string,
  overrides: { maxFailures?: number; baseMs?: number; capMs?: number } = {},
) {
  const botConfig = makeTestBotConfig("alpha");
  const config = makeTestConfig([botConfig], {
    gateway: {
      port: 3000,
      bind_host: "127.0.0.1",
      data_dir: tmpDir,
      db_path: join(tmpDir, "gateway.db"),
      log_level: "warn",
    },
    worker_tuning: {
      startup_timeout_secs: 10,
      stall_timeout_secs: 90,
      turn_timeout_secs: 60,
      crash_loop_backoff_base_ms: overrides.baseMs ?? 50,
      crash_loop_backoff_cap_ms: overrides.capMs ?? 500,
      max_consecutive_failures: overrides.maxFailures ?? 5,
    },
  });

  const metrics = new Metrics(config);
  const alerts = new AlertManager(config, new Map());
  const outbox = new OutboxProcessor(config, db, new Map(), metrics);
  const streaming = new StreamManager(config, db, outbox, new Map());

  const stub = new StubRunner("alpha");
  const bot = new Bot({
    config,
    botConfig,
    db,
    telegram: null as never,
    streaming,
    outbox,
    metrics,
    alerts,
    runner: stub,
  });
  return { bot, stub, db };
}

let tmpDir: string;
let db: GatewayDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-backoff-"));
  loadSchema(join(tmpDir, "gateway.db"));
  db = new GatewayDB(join(tmpDir, "gateway.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Bot crash-loop backoff", () => {
  test("non-auth fatal increments consecutive_failures and schedules restart", async () => {
    const { stub, db: bdb } = buildBotWithStubRunner(db, tmpDir, {
      baseMs: 30,
    });
    bdb.initWorkerState("alpha");

    await stub.start();
    expect(stub.startCalls).toBe(1);

    // Inject a fatal; the Bot's onFatal handler is wired at construction.
    // The fatal message includes content that must NOT be persisted (it can
    // contain subprocess stderr with third-party secrets). onFatal should
    // store the stable code instead.
    stub.simulateFatal("exit", "process died: secret=sk-leak-123");

    const row = bdb.getWorkerState("alpha");
    expect(row?.consecutive_failures).toBe(1);
    expect(row?.last_error).toBe("runner_exit");
    expect(row?.last_error).not.toContain("secret");
    expect(row?.last_error).not.toContain("sk-leak");

    // Wait past the backoff window and confirm restart fired.
    await new Promise((r) => setTimeout(r, 150));
    expect(stub.startCalls).toBe(2);

    // Successful restart resets the failure counter.
    const recovered = bdb.getWorkerState("alpha");
    expect(recovered?.consecutive_failures).toBe(0);
  });

  test("auth fatal disables bot and does NOT schedule restart", async () => {
    const { bot, stub, db: bdb } = buildBotWithStubRunner(db, tmpDir);
    await bot.start();
    expect(stub.startCalls).toBe(1);

    // Auth-fatal message may contain stderr of the form
    //   "Authentication failed. Token=sk-ant-api03-SECRET123"
    // which must not be persisted into `bot_state.disabled_reason`
    // (served via the unauthenticated /health endpoint).
    stub.simulateFatal("auth", "401: token=sk-ant-api03-secret123 rejected");

    const botState = bdb.getBotState("alpha");
    expect(botState?.disabled).toBe(1);
    // Regression: reason should be the stable code, never the raw message.
    expect(botState?.disabled_reason).toBe("auth_failure");
    expect(botState?.disabled_reason).not.toContain("sk-ant");
    expect(botState?.disabled_reason).not.toContain("secret");

    await new Promise((r) => setTimeout(r, 200));
    expect(stub.startCalls).toBe(1);
  });

  test("max_consecutive_failures halts retries", async () => {
    const { stub, db: bdb } = buildBotWithStubRunner(db, tmpDir, {
      baseMs: 10,
      capMs: 30,
      maxFailures: 3,
    });
    bdb.initWorkerState("alpha");

    // Simulate three back-to-back fatals with no successful restart between
    // them (we never let the stub finish its 'start' → 'ready' cycle to
    // reset the counter).
    bdb.updateWorkerState("alpha", { consecutive_failures: 2 });

    // Directly set counter to 2 and then emit a fatal — this crosses the max.
    stub.simulateFatal("exit", "crash #3");

    const row = bdb.getWorkerState("alpha");
    expect(row?.consecutive_failures).toBe(3);
    expect(row?.status).toBe("degraded");

    // Should not be restarted — already exceeded max.
    const before = stub.startCalls;
    await new Promise((r) => setTimeout(r, 80));
    expect(stub.startCalls).toBe(before);
  });

  test("stop() clears pending restart timer", async () => {
    const {
      bot,
      stub,
      db: bdb,
    } = buildBotWithStubRunner(db, tmpDir, { baseMs: 100 });
    bdb.initWorkerState("alpha");
    await stub.start();

    stub.simulateFatal("exit", "die");
    // Immediately stop before the backoff timer fires.
    await bot.stop();
    const before = stub.startCalls;
    await new Promise((r) => setTimeout(r, 200));
    expect(stub.startCalls).toBe(before);
  });
});
