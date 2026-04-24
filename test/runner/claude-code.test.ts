// ClaudeCodeRunner lifecycle tests via a real subprocess (bun running a mock
// fixture that speaks the stream-json protocol). Covers:
//   - spawn + ready via system init (parser path, not timer fallback)
//   - sendTurn: stdin framing, text_delta → done
//   - concurrent sendTurn while busy → {accepted:false, reason:"busy"}
//   - sendTurn when not_ready → {accepted:false, reason:"not_ready"}
//   - reset(): restarts subprocess, activates freshSession (omits --continue)
//   - SIGTERM graceful stop
//   - SIGTERM→SIGKILL escalation when subprocess ignores SIGTERM
//   - crash on spawn → fatal (exit)
//   - auth-failure stderr → fatal (auth)
//   - crash during turn → fatal, activeTurn cleared

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeCodeRunner } from "../../src/runner/claude-code.js";
import type { ClaudeCodeRunnerConfig } from "../../src/config/schema.js";
import type { RunnerEvent } from "../../src/runner/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(__dirname, "fixtures/claude-mock.ts");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-cc-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(
  mode: string,
  pass_continue_flag = true,
): ClaudeCodeRunnerConfig {
  return {
    type: "claude-code",
    cli_path: "bun",
    args: ["run", MOCK, mode],
    env: {},
    pass_continue_flag,
    acknowledge_dangerous: true,
  };
}

/** Subscribe to every runner event; returns collected + helper. */
function track(runner: ClaudeCodeRunner): {
  events: RunnerEvent[];
  waitFor: (
    kind: RunnerEvent["kind"],
    timeoutMs?: number,
  ) => Promise<RunnerEvent>;
} {
  const events: RunnerEvent[] = [];
  const kinds = [
    "ready",
    "text_delta",
    "done",
    "error",
    "fatal",
    "rate_limit",
    "status",
  ] as const;
  for (const k of kinds) {
    runner.on(k, (ev) => events.push(ev as RunnerEvent));
  }
  const waitFor = async (
    kind: RunnerEvent["kind"],
    timeoutMs = 5000,
  ): Promise<RunnerEvent> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = events.find((e) => e.kind === kind);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(
      `waitFor(${kind}) timed out. Events: ${JSON.stringify(events)}`,
    );
  };
  return { events, waitFor };
}

describe("ClaudeCodeRunner lifecycle", () => {
  test("normal happy path: spawn → ready → turn → text_delta + done", async () => {
    const runner = new ClaudeCodeRunner({
      botId: "alpha",
      config: makeConfig("normal"),
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 100,
    });
    const { events, waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 3000);

    expect(runner.isReady()).toBe(true);

    const turn = runner.sendTurn("T1", "hello", []);
    expect(turn.accepted).toBe(true);

    await waitFor("text_delta", 5000);
    await waitFor("done", 5000);

    // text_delta should carry turnId=T1 and text starts with "echo:"
    const td = events.find((e) => e.kind === "text_delta") as {
      kind: "text_delta";
      turnId: string;
      text: string;
    };
    expect(td.turnId).toBe("T1");
    expect(td.text).toContain("echo:");

    // After done: runner is ready again (status promoted).
    expect(runner.isReady()).toBe(true);

    await runner.stop(2000);
  }, 20_000);

  test("sendTurn when not_ready → returns not_ready", async () => {
    const runner = new ClaudeCodeRunner({
      botId: "alpha",
      config: makeConfig("normal"),
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 10_000, // no timer promotion
    });
    // status still "stopped" before start().
    const result = runner.sendTurn("T1", "hi", []);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("not_ready");
  });

  test("concurrent sendTurn during active turn → busy", async () => {
    const runner = new ClaudeCodeRunner({
      botId: "alpha",
      config: makeConfig("normal"),
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 100,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 3000);

    const first = runner.sendTurn("T1", "hi", []);
    expect(first.accepted).toBe(true);
    // Immediately attempt another turn without waiting for "done".
    const second = runner.sendTurn("T2", "hi2", []);
    expect(second.accepted).toBe(false);
    if (!second.accepted) expect(second.reason).toBe("busy");

    await waitFor("done", 5000);
    await runner.stop(2000);
  }, 20_000);

  test("stop(): SIGTERM allows graceful exit", async () => {
    const runner = new ClaudeCodeRunner({
      botId: "alpha",
      config: makeConfig("normal"),
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 100,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 3000);

    const t0 = Date.now();
    await runner.stop(5000);
    const elapsed = Date.now() - t0;
    // Bun subprocess should exit quickly on SIGTERM.
    expect(elapsed).toBeLessThan(3000);
    expect(runner.isReady()).toBe(false);
  }, 20_000);

  test("stop(): SIGKILL escalation on SIGTERM-ignoring subprocess", async () => {
    const runner = new ClaudeCodeRunner({
      botId: "alpha",
      config: makeConfig("stubborn"),
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 100,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 3000);

    const graceMs = 300;
    const t0 = Date.now();
    await runner.stop(graceMs);
    const elapsed = Date.now() - t0;
    // Should take >=graceMs (SIGTERM phase) and finish reasonably soon after SIGKILL.
    expect(elapsed).toBeGreaterThanOrEqual(graceMs);
    expect(elapsed).toBeLessThan(graceMs + 2000);
  }, 20_000);

  test("crash during spawn: subprocess exits immediately → fatal(exit)", async () => {
    const runner = new ClaudeCodeRunner({
      botId: "alpha",
      config: makeConfig("crash-on-start"),
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 10_000, // don't let the timer mask the exit
    });
    const { waitFor } = track(runner);
    await runner.start();
    const ev = (await waitFor("fatal", 5000)) as {
      kind: "fatal";
      code?: string;
    };
    expect(ev.code).toBe("exit");
  }, 20_000);

  test("auth-like stderr on early exit → fatal(auth)", async () => {
    const runner = new ClaudeCodeRunner({
      botId: "alpha",
      config: makeConfig("auth-fail"),
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 10_000,
    });
    const { waitFor } = track(runner);
    await runner.start();
    const ev = (await waitFor("fatal", 5000)) as {
      kind: "fatal";
      code?: string;
      message: string;
    };
    // Auth signal lives in `code`, not in the message: the message must not
    // carry subprocess stderr (which could contain third-party secrets).
    expect(ev.code).toBe("auth");
    expect(ev.message.toLowerCase()).not.toContain("not logged in");
  }, 20_000);

  test("crash during turn → fatal, activeTurn cleared", async () => {
    const runner = new ClaudeCodeRunner({
      botId: "alpha",
      config: makeConfig("crash-on-turn"),
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 100,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 3000);

    const turn = runner.sendTurn("T1", "hello", []);
    expect(turn.accepted).toBe(true);

    const ev = (await waitFor("fatal", 5000)) as {
      kind: "fatal";
      code?: string;
    };
    expect(ev.code).toBe("exit");
    expect(runner.isReady()).toBe(false);
  }, 20_000);

  test("supportsReset() returns true", () => {
    const runner = new ClaudeCodeRunner({
      botId: "alpha",
      config: makeConfig("normal"),
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 100,
    });
    expect(runner.supportsReset()).toBe(true);
  });

  test("reset(): kills + respawns, pendingFreshSession omits --continue", async () => {
    // Use replay-continue mode so the mock emits its argv in the init event.
    const runner = new ClaudeCodeRunner({
      botId: "alpha",
      config: {
        type: "claude-code",
        cli_path: "bun",
        args: ["run", MOCK, "replay-continue"],
        env: {},
        pass_continue_flag: true,
        acknowledge_dangerous: true,
      },
      logDir: tmpDir,
      protocolFlags: [],
      freshSession: false, // first spawn should include --continue per config
      startupMs: 100,
    });
    const events: RunnerEvent[] = [];
    runner.on("ready", (e) => events.push(e));

    // Capture raw stream_event lines from stdout via internal subscription?
    // The parser does NOT emit system init fields up — it translates to
    // {kind:"ready"}. To verify --continue, look at process args via the
    // log file the runner writes.
    await runner.start();
    await new Promise((r) => setTimeout(r, 500));

    // Now reset: it kills the proc, which triggers respawn with freshSession.
    await runner.reset();
    await new Promise((r) => setTimeout(r, 800));

    // Verify that the log file recorded both a first init AND a second init.
    const logPath = resolve(tmpDir, "alpha.log");
    const content = await Bun.file(logPath).text();
    // Count occurrences of init events.
    const initCount = (content.match(/"subtype":"init"/g) ?? []).length;
    expect(initCount).toBeGreaterThanOrEqual(2);

    // First spawn should have included --continue (pass_continue_flag && !freshSession),
    // second (post-reset) should NOT include --continue.
    const initLines = content
      .split("\n")
      .filter((l) => l.includes('"subtype":"init"'));
    expect(initLines.length).toBeGreaterThanOrEqual(2);
    const first = JSON.parse(initLines[0]) as { argv: string[] };
    const second = JSON.parse(initLines[1]) as { argv: string[] };
    expect(first.argv).toContain("--continue");
    expect(second.argv).not.toContain("--continue");

    await runner.stop(2000);
  }, 30_000);

  test("reset() while active turn throws", async () => {
    const runner = new ClaudeCodeRunner({
      botId: "alpha",
      config: makeConfig("normal"),
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 100,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 3000);
    runner.sendTurn("T1", "hi", []);
    await expect(runner.reset()).rejects.toThrow(/in flight/);
    await runner.stop(2000);
  }, 20_000);

  test("start() called twice without stop throws", async () => {
    const runner = new ClaudeCodeRunner({
      botId: "alpha",
      config: makeConfig("normal"),
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 100,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 3000);
    await expect(runner.start()).rejects.toThrow(/in state/);
    await runner.stop(2000);
  }, 20_000);

  test("writes stderr to <bot_id>.log with [stderr] prefix", async () => {
    const runner = new ClaudeCodeRunner({
      botId: "alpha",
      config: makeConfig("auth-fail"),
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 10_000,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("fatal", 5000);
    // give the log stream a moment to flush before reading
    await new Promise((r) => setTimeout(r, 100));

    const logPath = resolve(tmpDir, "alpha.log");
    const content = await Bun.file(logPath).text();
    expect(content).toContain("[stderr]");
    expect(content.toLowerCase()).toContain("not logged in");
  }, 20_000);
});
