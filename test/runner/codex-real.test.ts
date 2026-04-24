// CodexRunner end-to-end test against the REAL `codex` binary. Skipped unless
// the CODEX_E2E env var is set, because it (a) requires an authenticated
// codex install and (b) consumes API quota.
//
// Run locally with:  CODEX_E2E=1 bun test test/runner/codex-real.test.ts
//
// Purpose: catch schema drift between the parser's assumptions and the live
// CLI's output. The mock-based tests verify the state machine; this verifies
// our reading of the actual JSONL stream.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CodexRunner } from "../../src/runner/codex.js";
import type { CodexRunnerConfig } from "../../src/config/schema.js";
import type { RunnerEvent } from "../../src/runner/types.js";

const enabled = process.env.CODEX_E2E === "1";
const describeOrSkip = enabled ? describe : describe.skip;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-cx-real-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(
  overrides: Partial<CodexRunnerConfig> = {},
): CodexRunnerConfig {
  return {
    type: "codex",
    cli_path: "codex",
    args: [],
    env: {
      // Pass through whatever the host has — codex uses ~/.codex/auth.json or
      // OPENAI_API_KEY. We cannot fabricate either.
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
      HOME: process.env.HOME ?? "",
    },
    pass_resume_flag: true,
    approval_mode: "full-auto",
    sandbox: "workspace-write",
    acknowledge_dangerous: false,
    ...overrides,
  };
}

function track(runner: CodexRunner) {
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
  const waitForTurn = async (
    kind: "done" | "error" | "text_delta",
    turnId: string,
    timeoutMs = 60_000,
  ): Promise<RunnerEvent> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = events.find(
        (e) => e.kind === kind && (e as { turnId: string }).turnId === turnId,
      );
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      `waitForTurn(${kind}, ${turnId}) timed out. Events: ${JSON.stringify(events)}`,
    );
  };
  return { events, waitForTurn };
}

describeOrSkip("CodexRunner against live codex CLI", () => {
  test("simple turn: parser reads agent_message and turn.completed correctly", async () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig(),
      logDir: tmpDir,
    });
    const { events, waitForTurn } = track(runner);

    await runner.start();
    runner.sendTurn("T1", "respond with the single word: pong", []);

    await waitForTurn("done", "T1", 60_000);

    const text = events
      .filter(
        (e): e is Extract<RunnerEvent, { kind: "text_delta" }> =>
          e.kind === "text_delta",
      )
      .map((e) => e.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
    // We can't assert on exact model output — just that we got SOME text.

    const done = events.find((e) => e.kind === "done") as Extract<
      RunnerEvent,
      { kind: "done" }
    >;
    expect(done.turnId).toBe("T1");
    expect(done.usage?.input_tokens).toBeGreaterThan(0);
    expect(done.usage?.output_tokens).toBeGreaterThan(0);

    await runner.stop(5000);
  }, 90_000);

  test("session continuity: second turn references first via captured thread_id", async () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig(),
      logDir: tmpDir,
    });
    const { events, waitForTurn } = track(runner);

    await runner.start();

    runner.sendTurn(
      "T1",
      "Pick a random integer between 1 and 1000. Reply with ONLY that number, no other text.",
      [],
    );
    await waitForTurn("done", "T1", 60_000);

    const firstNumber = events
      .filter(
        (e): e is Extract<RunnerEvent, { kind: "text_delta" }> =>
          e.kind === "text_delta",
      )
      .map((e) => e.text)
      .join("");

    runner.sendTurn(
      "T2",
      "What was the number you picked? Reply with ONLY that number.",
      [],
    );
    await waitForTurn("done", "T2", 60_000);

    const secondNumber = events
      .filter(
        (e): e is Extract<RunnerEvent, { kind: "text_delta" }> =>
          e.kind === "text_delta" && e.turnId === "T2",
      )
      .map((e) => e.text)
      .join("");

    // If the resume worked, the second answer should reference the first
    // number. We extract digits and compare.
    const digits1 = firstNumber.match(/\d+/)?.[0];
    const digits2 = secondNumber.match(/\d+/)?.[0];
    expect(digits1).toBeDefined();
    expect(digits2).toBeDefined();
    expect(digits2).toBe(digits1);

    // Verify the runner's log shows resume for the second turn.
    const logPath = resolve(tmpDir, "alpha.log");
    const content = await Bun.file(logPath).text();
    const threadIds = [
      ...content.matchAll(/"type":"thread\.started","thread_id":"([^"]+)"/g),
    ].map((m) => m[1]);
    expect(threadIds.length).toBeGreaterThanOrEqual(2);
    // Same thread_id reused across turns when resuming.
    expect(threadIds[0]).toBe(threadIds[1]);

    await runner.stop(5000);
  }, 180_000);

  test("turn.failed event is parsed as kind:error", async () => {
    // Force a model error by requesting a non-existent model.
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig({ model: "nonexistent-model-xyz-9999" }),
      logDir: tmpDir,
    });
    const { events, waitForTurn } = track(runner);

    await runner.start();
    runner.sendTurn("T1", "anything", []);

    const ev = (await waitForTurn("error", "T1", 30_000)) as {
      kind: "error";
      message: string;
    };
    expect(ev.message.length).toBeGreaterThan(0);
    expect(ev.message).toMatch(/nonexistent-model-xyz-9999|invalid|error/i);

    // No `done` event should have been emitted for T1.
    const done = events.find(
      (e) => e.kind === "done" && (e as { turnId: string }).turnId === "T1",
    );
    expect(done).toBeUndefined();

    await runner.stop(5000);
  }, 60_000);

  test("reset() clears thread_id → next turn starts a new session", async () => {
    const runner = new CodexRunner({
      botId: "alpha",
      config: makeConfig(),
      logDir: tmpDir,
    });
    const { waitForTurn } = track(runner);

    await runner.start();
    runner.sendTurn("T1", "respond with: ok", []);
    await waitForTurn("done", "T1", 60_000);

    await runner.reset();

    runner.sendTurn("T2", "respond with: ok", []);
    await waitForTurn("done", "T2", 60_000);

    const logPath = resolve(tmpDir, "alpha.log");
    const content = await Bun.file(logPath).text();
    const threadIds = [
      ...content.matchAll(/"type":"thread\.started","thread_id":"([^"]+)"/g),
    ].map((m) => m[1]);
    expect(threadIds.length).toBeGreaterThanOrEqual(2);
    // After reset, second turn should have a DIFFERENT thread_id.
    expect(threadIds[0]).not.toBe(threadIds[1]);

    await runner.stop(5000);
  }, 180_000);
});
