// Spawns the shipped examples/side-session-runner/session-runner.ts under
// CommandRunner and drives one main-session turn + one side-session turn,
// asserting disjoint event streams. This guards Phase 2c's contract at
// the published-example boundary: if the example drifts from what the
// protocol parser expects, this test catches it before release.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CommandRunner } from "../../src/runner/command.js";
import type { CommandRunnerConfig } from "../../src/config/schema.js";
import type { RunnerEvent } from "../../src/runner/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = resolve(
  __dirname,
  "../../examples/side-session-runner/session-runner.ts",
);

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-example-side-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(): CommandRunnerConfig {
  return {
    type: "command",
    cmd: ["bun", "run", EXAMPLE],
    protocol: "claude-ndjson",
    env: {},
    on_reset: "signal",
  };
}

async function waitFor<T>(
  get: () => T | undefined,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = get();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

describe("examples/side-session-runner", () => {
  test("main turn + side turn produce disjoint events with correct session labels", async () => {
    const r = new CommandRunner({
      botId: "alpha",
      config: makeConfig(),
      logDir: tmpDir,
      sideStartupMs: 500,
    });
    await r.start();

    const mainEvents: RunnerEvent[] = [];
    for (const k of [
      "ready",
      "text_delta",
      "done",
      "error",
      "fatal",
    ] as const) {
      r.on(k, (ev) => mainEvents.push(ev as RunnerEvent));
    }

    try {
      // Wait for the main subprocess to report ready so sendTurn lands.
      await waitFor(() => mainEvents.find((e) => e.kind === "ready"), 5000);

      // Drive main-session turn.
      const mainRes = r.sendTurn("M1", "hello-main", []);
      expect(mainRes.accepted).toBe(true);
      await waitFor(() => mainEvents.find((e) => e.kind === "done"), 5000);
      const mainText = mainEvents.find((e) => e.kind === "text_delta") as
        | { text: string }
        | undefined;
      expect(mainText?.text).toContain("[main#1]");
      expect(mainText?.text).toContain("hello-main");

      // Drive side-session turn — dedicated subprocess, own turn counter.
      await r.startSideSession("demo");
      const sideEvents: RunnerEvent[] = [];
      for (const k of [
        "ready",
        "text_delta",
        "done",
        "error",
        "fatal",
      ] as const) {
        r.onSide("demo", k, (ev) => sideEvents.push(ev as RunnerEvent));
      }

      const sideRes = r.sendSideTurn("demo", "S1", "hello-side", []);
      expect(sideRes.accepted).toBe(true);
      await waitFor(() => sideEvents.find((e) => e.kind === "done"), 5000);

      const sideText = sideEvents.find((e) => e.kind === "text_delta") as
        | { text: string; turnId: string }
        | undefined;
      expect(sideText?.turnId).toBe("S1");
      expect(sideText?.text).toContain("[demo#1]"); // side subprocess has its own counter
      expect(sideText?.text).toContain("hello-side");

      // Cross-contamination guard: main emitter never saw [demo#…] text;
      // side emitter never saw [main#…] text.
      expect(
        mainEvents.every(
          (e) =>
            e.kind !== "text_delta" ||
            !(e as { text: string }).text.includes("[demo"),
        ),
      ).toBe(true);
      expect(
        sideEvents.every(
          (e) =>
            e.kind !== "text_delta" ||
            !(e as { text: string }).text.includes("[main"),
        ),
      ).toBe(true);
    } finally {
      await r.stopSideSession("demo", 500);
      await r.stop(500);
    }
  }, 20_000);
});
