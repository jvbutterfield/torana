// CodexRunner lifecycle tests via a real subprocess (bun running a mock
// fixture that speaks the codex exec --json protocol). Covers:
//   - start() emits ready synthetically (no subprocess yet)
//   - sendTurn: spawns subprocess, parses thread.started + agent_message + turn.completed
//   - thread_id captured and reused on second turn (exec resume)
//   - reset() clears thread_id → next turn starts fresh
//   - sendTurn while busy → {accepted:false, reason:"busy"}
//   - sendTurn before start → {accepted:false, reason:"not_ready"}
//   - subprocess exits without turn.completed → synthetic error event
//   - turn.failed → error event
//   - auth-failure stderr on early exit → fatal(auth)
//   - non-image attachments are skipped with a warning (not passed as --image)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexRunner } from "../../src/runner/codex.js";
import type { CodexRunnerConfig } from "../../src/config/schema.js";
import type { RunnerEvent } from "../../src/runner/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(__dirname, "fixtures/codex-mock.ts");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-cx-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Test invocation: `bun run MOCK exec [resume id] --full-auto --sandbox X mode -`.
// `protocolFlags` is overridden to ["run", MOCK] so the mock script ends up
// between `bun` and the runner-injected `exec` (which would otherwise be parsed
// as bun's own `bun exec` subcommand).
function makeConfig(
  mode: string,
  overrides: Partial<CodexRunnerConfig> = {},
): CodexRunnerConfig {
  return {
    type: "codex",
    cli_path: "bun",
    args: [mode],
    env: {},
    pass_resume_flag: true,
    approval_mode: "full-auto",
    sandbox: "workspace-write",
    acknowledge_dangerous: false,
    ...overrides,
  };
}

const TEST_PROTOCOL_FLAGS = ["run", MOCK];

function track(runner: CodexRunner): {
  events: RunnerEvent[];
  waitFor: (
    kind: RunnerEvent["kind"],
    timeoutMs?: number,
  ) => Promise<RunnerEvent>;
  waitForTurn: (
    kind: "done" | "error" | "text_delta",
    turnId: string,
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
  const waitForTurn = async (
    kind: "done" | "error" | "text_delta",
    turnId: string,
    timeoutMs = 5000,
  ): Promise<RunnerEvent> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = events.find(
        (e) => e.kind === kind && (e as { turnId: string }).turnId === turnId,
      );
      if (found) return found;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(
      `waitForTurn(${kind}, ${turnId}) timed out. Events: ${JSON.stringify(events)}`,
    );
  };
  return { events, waitFor, waitForTurn };
}

describe("CodexRunner lifecycle", () => {
  test("start() emits ready immediately (no subprocess required)", async () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("normal"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 1000);
    expect(runner.isReady()).toBe(true);
    await runner.stop(2000);
  }, 10_000);

  test("sendTurn before start → not_ready", () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("normal"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    const result = runner.sendTurn("T1", "hi", []);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("not_ready");
  });

  test("happy path: sendTurn → text_delta + done", async () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("normal"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    const { events, waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 1000);

    const result = runner.sendTurn("T1", "hello world", []);
    expect(result.accepted).toBe(true);

    await waitFor("text_delta", 5000);
    await waitFor("done", 5000);

    const td = events.find((e) => e.kind === "text_delta") as {
      kind: "text_delta";
      turnId: string;
      text: string;
    };
    expect(td.turnId).toBe("T1");
    expect(td.text).toBe("echo: hello world");

    expect(runner.isReady()).toBe(true);
    await runner.stop(2000);
  }, 15_000);

  test("concurrent sendTurn during active turn → busy", async () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("slow"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 1000);

    const first = runner.sendTurn("T1", "hi", []);
    expect(first.accepted).toBe(true);
    const second = runner.sendTurn("T2", "hi2", []);
    expect(second.accepted).toBe(false);
    if (!second.accepted) expect(second.reason).toBe("busy");

    await waitFor("done", 5000);
    await runner.stop(2000);
  }, 15_000);

  test("second turn passes `exec resume <thread_id>` argv", async () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("replay-resume"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    const { waitFor, waitForTurn } = track(runner);
    await runner.start();
    await waitFor("ready", 1000);

    runner.sendTurn("T1", "first", []);
    await waitForTurn("done", "T1", 5000);

    runner.sendTurn("T2", "second", []);
    await waitForTurn("done", "T2", 5000);

    // Inspect the per-bot log to verify the second invocation included
    // `exec resume tid-replay`.
    const logPath = resolve(tmpDir, "alpha.log");
    const content = await Bun.file(logPath).text();
    const lines = content
      .split("\n")
      .filter((l) => l.includes('"thread.started"'))
      .map((l) => JSON.parse(l) as { __argv?: string[]; __resuming?: boolean });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const first = lines[0];
    const second = lines[1];
    expect(first.__resuming).toBe(false);
    expect(second.__resuming).toBe(true);
    expect(second.__argv?.join(" ")).toContain("resume tid-replay");

    await runner.stop(2000);
  }, 20_000);

  test("reset() clears thread_id → next turn starts fresh", async () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("replay-resume"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    const { waitFor, waitForTurn } = track(runner);
    await runner.start();
    await waitFor("ready", 1000);

    runner.sendTurn("T1", "first", []);
    await waitForTurn("done", "T1", 5000);

    await runner.reset();

    runner.sendTurn("T2", "second", []);
    await waitForTurn("done", "T2", 5000);

    const logPath = resolve(tmpDir, "alpha.log");
    const content = await Bun.file(logPath).text();
    const lines = content
      .split("\n")
      .filter((l) => l.includes('"thread.started"'))
      .map((l) => JSON.parse(l) as { __resuming?: boolean });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0].__resuming).toBe(false);
    expect(lines[1].__resuming).toBe(false);

    await runner.stop(2000);
  }, 20_000);

  test("subprocess exits without turn.completed → synthetic error", async () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("no-completion"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 1000);

    runner.sendTurn("T1", "hi", []);
    const ev = (await waitFor("error", 5000)) as {
      kind: "error";
      turnId: string;
      message: string;
    };
    expect(ev.turnId).toBe("T1");
    expect(ev.message).toMatch(/before completing the turn/);
    expect(runner.isReady()).toBe(true);
    await runner.stop(2000);
  }, 15_000);

  test("turn.failed emits error", async () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("turn-failed"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 1000);

    runner.sendTurn("T1", "hi", []);
    const ev = (await waitFor("error", 5000)) as {
      kind: "error";
      message: string;
    };
    expect(ev.message).toBe("model refused");
    await runner.stop(2000);
  }, 15_000);

  test("auth-failure stderr on early exit → fatal(auth)", async () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("auth-fail"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 1000);

    runner.sendTurn("T1", "hi", []);
    const ev = (await waitFor("fatal", 5000)) as {
      kind: "fatal";
      code?: string;
      message: string;
    };
    expect(ev.code).toBe("auth");
    // Auth signal lives in `code`, not in the message.
    expect(ev.message.toLowerCase()).not.toContain("not logged in");
    await runner.stop(2000);
  }, 15_000);

  test("non-image attachments are skipped (not passed as --image)", async () => {
    const docPath = join(tmpDir, "ignored.txt");
    writeFileSync(docPath, "doc content");

    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("replay-resume"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 1000);

    runner.sendTurn("T1", "hi", [
      { kind: "document", path: docPath, bytes: 0 },
    ]);
    await waitFor("done", 5000);

    const logPath = resolve(tmpDir, "alpha.log");
    const content = await Bun.file(logPath).text();
    const line = content
      .split("\n")
      .filter((l) => l.includes('"thread.started"'))
      .map((l) => JSON.parse(l) as { __argv?: string[] })[0];
    expect(line.__argv?.join(" ")).not.toContain("--image");

    await runner.stop(2000);
  }, 15_000);

  test("image attachments are passed as --image", async () => {
    const imgPath = join(tmpDir, "pic.png");
    writeFileSync(imgPath, "fake png");

    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("replay-resume"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 1000);

    runner.sendTurn("T1", "describe", [
      { kind: "photo", path: imgPath, bytes: 0 },
    ]);
    await waitFor("done", 5000);

    const logPath = resolve(tmpDir, "alpha.log");
    const content = await Bun.file(logPath).text();
    const line = content
      .split("\n")
      .filter((l) => l.includes('"thread.started"'))
      .map((l) => JSON.parse(l) as { __argv?: string[] })[0];
    const argv = line.__argv?.join(" ") ?? "";
    expect(argv).toContain("--image");
    expect(argv).toContain(imgPath);

    await runner.stop(2000);
  }, 15_000);

  test("supportsReset() returns true", () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("normal"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    expect(runner.supportsReset()).toBe(true);
  });

  test("reset() while active turn throws", async () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("slow"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 1000);
    runner.sendTurn("T1", "hi", []);
    await expect(runner.reset()).rejects.toThrow(/in flight/);
    await waitFor("done", 5000);
    await runner.stop(2000);
  }, 15_000);

  test("start() called twice without stop throws", async () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("normal"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    await runner.start();
    await expect(runner.start()).rejects.toThrow(/in state/);
    await runner.stop(2000);
  });

  test("initialThreadId seeds resume on the first turn", async () => {
    // Prove the cross-restart contract: a runner constructed with a thread id
    // hydrated from persisted state issues `exec resume <id>` on its very
    // first turn, instead of starting a fresh thread.
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("replay-resume"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
      initialThreadId: "tid-restored",
    });
    const { waitFor, waitForTurn } = track(runner);
    await runner.start();
    await waitFor("ready", 1000);

    runner.sendTurn("T1", "hi", []);
    await waitForTurn("done", "T1", 5000);

    const logPath = resolve(tmpDir, "alpha.log");
    const content = await Bun.file(logPath).text();
    const line = content
      .split("\n")
      .filter((l) => l.includes('"thread.started"'))
      .map(
        (l) => JSON.parse(l) as { __argv?: string[]; __resuming?: boolean },
      )[0];
    expect(line.__resuming).toBe(true);
    expect(line.__argv?.join(" ")).toContain("resume tid-restored");

    await runner.stop(2000);
  }, 15_000);

  test("onThreadIdChanged fires on capture and on reset", async () => {
    const events: Array<string | null> = [];
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("replay-resume"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
      onThreadIdChanged: (id) => events.push(id),
    });
    const { waitFor, waitForTurn } = track(runner);
    await runner.start();
    await waitFor("ready", 1000);

    runner.sendTurn("T1", "hi", []);
    await waitForTurn("done", "T1", 5000);

    expect(events).toEqual(["tid-replay"]);

    await runner.reset();
    expect(events).toEqual(["tid-replay", null]);

    await runner.stop(2000);
  }, 15_000);

  test("initialThreadId is ignored when pass_resume_flag is false", async () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("replay-resume", { pass_resume_flag: false }),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
      initialThreadId: "tid-restored",
    });
    const { waitFor, waitForTurn } = track(runner);
    await runner.start();
    await waitFor("ready", 1000);

    runner.sendTurn("T1", "hi", []);
    await waitForTurn("done", "T1", 5000);

    const logPath = resolve(tmpDir, "alpha.log");
    const content = await Bun.file(logPath).text();
    const line = content
      .split("\n")
      .filter((l) => l.includes('"thread.started"'))
      .map((l) => JSON.parse(l) as { __resuming?: boolean })[0];
    expect(line.__resuming).toBe(false);

    await runner.stop(2000);
  }, 15_000);

  test("writes stderr to <bot_id>.log with [stderr] prefix", async () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig("auth-fail"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    const { waitFor } = track(runner);
    await runner.start();
    await waitFor("ready", 1000);
    runner.sendTurn("T1", "hi", []);
    await waitFor("fatal", 5000);
    await new Promise((r) => setTimeout(r, 100));

    const logPath = resolve(tmpDir, "alpha.log");
    const content = await Bun.file(logPath).text();
    expect(content).toContain("[stderr]");
    expect(content.toLowerCase()).toContain("not logged in");

    await runner.stop(2000);
  }, 15_000);
});
