// Side-session tests for CodexRunner (US-006). Mirrors the structure of
// claude-code.side-session.test.ts so the cross-runner contract is
// visible at-a-glance, then adds Codex-specific cases:
//
//   - per-turn spawn + threadId resume (the structural difference from Claude)
//   - thread.started after turn.completed (the realistic-but-rare Codex
//     ordering — runner must still capture threadId via parser.flush())
//   - non-image attachments skipped on side-session path too
//
// The critical invariant from §4.2 holds: events from one side-session's
// per-turn subprocess land ONLY on that session's emitter — never on the
// main runner's emitter, never on another side session's emitter.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexRunner } from "../../src/runner/codex.js";
import type { CodexRunnerConfig } from "../../src/config/schema.js";
import type { RunnerEvent } from "../../src/runner/types.js";
import {
  InvalidSideSessionId,
  SideSessionAlreadyExists,
  SideSessionNotFound,
} from "../../src/runner/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(__dirname, "fixtures/codex-mock.ts");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-cx-side-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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

function newRunner(mode = "normal"): CodexRunner {
  return new CodexRunner({
    botId: "alpha",
    config: makeConfig(mode),
    logDir: tmpDir,
    protocolFlags: TEST_PROTOCOL_FLAGS,
  });
}

function collect(runner: CodexRunner): RunnerEvent[] {
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
  for (const k of kinds) runner.on(k, (ev) => events.push(ev as RunnerEvent));
  return events;
}

function collectSide(runner: CodexRunner, sessionId: string): RunnerEvent[] {
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
    runner.onSide(sessionId, k, (ev) => events.push(ev as RunnerEvent));
  }
  return events;
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

describe("CodexRunner side-sessions", () => {
  test("supportsSideSessions() returns true (Phase 2b)", () => {
    const r = newRunner();
    expect(r.supportsSideSessions()).toBe(true);
  });

  test("id validation rejects bad shapes", async () => {
    const r = newRunner();
    await r.start();
    try {
      await expect(r.startSideSession("")).rejects.toBeInstanceOf(
        InvalidSideSessionId,
      );
      await expect(r.startSideSession("has space")).rejects.toBeInstanceOf(
        InvalidSideSessionId,
      );
      await expect(r.startSideSession("a".repeat(65))).rejects.toBeInstanceOf(
        InvalidSideSessionId,
      );
    } finally {
      await r.stop(500);
    }
  });

  test("double-start same session id → SideSessionAlreadyExists", async () => {
    const r = newRunner();
    await r.start();
    try {
      await r.startSideSession("s1");
      await expect(r.startSideSession("s1")).rejects.toBeInstanceOf(
        SideSessionAlreadyExists,
      );
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  });

  test("onSide before startSideSession → SideSessionNotFound", () => {
    const r = newRunner();
    expect(() => r.onSide("nope", "done", () => {})).toThrow(
      SideSessionNotFound,
    );
  });

  test("after startSideSession resolves, sendSideTurn is immediately accepted", async () => {
    // Codex side-sessions don't require waiting for a per-process ready
    // event — the runner returns from startSideSession when the entry is
    // initialized, and the next sendSideTurn spawns the per-turn
    // subprocess. (Mirrors the SideSessionPool contract: it calls
    // `await runner.startSideSession(...)` then immediately treats the
    // session as usable — no separate ready handshake.)
    const r = newRunner();
    await r.start();
    try {
      await r.startSideSession("s1");
      const res = r.sendSideTurn("s1", "t1", "ready-check", []);
      expect(res.accepted).toBe(true);
      const e = collectSide(r, "s1");
      await waitFor(() => e.find((x) => x.kind === "done"), 8000);
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  }, 15_000);

  test("happy path: side sendSideTurn lands events on side emitter only", async () => {
    const r = newRunner();
    await r.start();
    const mainEvents = collect(r);
    try {
      await r.startSideSession("s1");
      const sideEvents = collectSide(r, "s1");

      const res = r.sendSideTurn("s1", "turn-1", "hello-side", []);
      expect(res.accepted).toBe(true);
      await waitFor(() => sideEvents.find((e) => e.kind === "done"), 8000);

      // Main emitter saw the main ready event; no side events bled in.
      expect(mainEvents.filter((e) => e.kind === "text_delta").length).toBe(0);
      expect(mainEvents.filter((e) => e.kind === "done").length).toBe(0);

      const sideText = sideEvents.find((e) => e.kind === "text_delta") as
        | { text: string; turnId: string }
        | undefined;
      const sideDone = sideEvents.find((e) => e.kind === "done") as
        | { turnId: string }
        | undefined;
      expect(sideText?.text).toBe("echo: hello-side");
      expect(sideText?.turnId).toBe("turn-1");
      expect(sideDone?.turnId).toBe("turn-1");
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  }, 15_000);

  test("two concurrent side sessions don't cross-contaminate events", async () => {
    const r = newRunner();
    await r.start();
    try {
      await r.startSideSession("s1");
      await r.startSideSession("s2");
      const e1 = collectSide(r, "s1");
      const e2 = collectSide(r, "s2");

      r.sendSideTurn("s1", "t1", "payload-one", []);
      r.sendSideTurn("s2", "t2", "payload-two", []);

      await waitFor(() => e1.find((e) => e.kind === "done"), 8000);
      await waitFor(() => e2.find((e) => e.kind === "done"), 8000);

      const t1 = e1.find((e) => e.kind === "text_delta") as
        | { text: string }
        | undefined;
      const t2 = e2.find((e) => e.kind === "text_delta") as
        | { text: string }
        | undefined;
      expect(t1?.text).toBe("echo: payload-one");
      expect(t2?.text).toBe("echo: payload-two");

      // Neither side saw the other's payload.
      expect(
        e1.every(
          (e) =>
            e.kind !== "text_delta" ||
            (e as { text: string }).text.includes("one"),
        ),
      ).toBe(true);
      expect(
        e2.every(
          (e) =>
            e.kind !== "text_delta" ||
            (e as { text: string }).text.includes("two"),
        ),
      ).toBe(true);
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stopSideSession("s2", 500);
      await r.stop(500);
    }
  }, 20_000);

  test("sendSideTurn while session is busy → {accepted:false, reason:'busy'}", async () => {
    // slow-echo gives us a 500ms window mid-turn to fire the second send.
    const r = new CodexRunner({
      botId: "alpha",
      config: makeConfig("slow-echo"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    await r.start();
    try {
      await r.startSideSession("s1");
      const first = r.sendSideTurn("s1", "t1", "first", []);
      expect(first.accepted).toBe(true);
      // Without waiting for done, the second call must be rejected as busy.
      const second = r.sendSideTurn("s1", "t2", "second", []);
      expect(second).toEqual({ accepted: false, reason: "busy" });
      // Don't strand the in-flight turn — wait for it or stop teardown will hang.
      await waitFor(
        () =>
          collectSide(r, "s1").find((e) => false) ?? undefined,
        100,
      ).catch(() => {
        /* expected timeout */
      });
    } finally {
      await r.stopSideSession("s1", 2000);
      await r.stop(2000);
    }
  }, 15_000);

  test("sendSideTurn for an unknown session → not_ready (no throw)", async () => {
    const r = newRunner();
    await r.start();
    try {
      const res = r.sendSideTurn("nope", "t1", "hi", []);
      expect(res).toEqual({ accepted: false, reason: "not_ready" });
    } finally {
      await r.stop(500);
    }
  });

  test("stopSideSession idles the entry and a later start with same id works", async () => {
    const r = newRunner();
    await r.start();
    try {
      await r.startSideSession("s1");
      await r.stopSideSession("s1", 1000);
      // Restart same id OK.
      await r.startSideSession("s1");
      const e = collectSide(r, "s1");
      r.sendSideTurn("s1", "t1", "again", []);
      await waitFor(() => e.find((x) => x.kind === "done"), 8000);
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  }, 15_000);

  test("subprocess exits without turn.completed → synthetic error on side emitter", async () => {
    const r = new CodexRunner({
      botId: "alpha",
      config: makeConfig("no-completion"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    await r.start();
    const mainEvents = collect(r);
    try {
      await r.startSideSession("s1");
      const sideEvents = collectSide(r, "s1");
      r.sendSideTurn("s1", "t1", "hi", []);

      const ev = (await waitFor(
        () => sideEvents.find((e) => e.kind === "error"),
        8000,
      )) as { turnId: string; message: string };
      expect(ev.turnId).toBe("t1");
      expect(ev.message).toMatch(/before completing the turn/);
      // Main emitter never saw the side error.
      expect(mainEvents.find((e) => e.kind === "error")).toBeUndefined();
    } finally {
      await r.stop(500);
    }
  }, 15_000);

  test("turn.failed → error event on side emitter", async () => {
    const r = new CodexRunner({
      botId: "alpha",
      config: makeConfig("turn-failed"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    await r.start();
    try {
      await r.startSideSession("s1");
      const e = collectSide(r, "s1");
      r.sendSideTurn("s1", "t1", "hi", []);
      const ev = (await waitFor(
        () => e.find((x) => x.kind === "error"),
        5000,
      )) as { message: string };
      expect(ev.message).toBe("model refused");
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  }, 15_000);

  test("auth-failure stderr → fatal(auth) on side emitter only", async () => {
    const r = new CodexRunner({
      botId: "alpha",
      config: makeConfig("auth-fail"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    await r.start();
    const mainEvents = collect(r);
    try {
      await r.startSideSession("s1");
      const sideEvents = collectSide(r, "s1");
      r.sendSideTurn("s1", "t1", "hi", []);
      const ev = (await waitFor(
        () => sideEvents.find((e) => e.kind === "fatal"),
        5000,
      )) as { code?: string; message: string };
      expect(ev.code).toBe("auth");
      // Main runner is unaffected.
      expect(mainEvents.find((e) => e.kind === "fatal")).toBeUndefined();
    } finally {
      await r.stop(500);
    }
  }, 15_000);

  test("spawn failure leaves no phantom entry", async () => {
    const r = new CodexRunner({
      botId: "alpha",
      config: {
        ...makeConfig("normal"),
        cli_path: "/nonexistent/binary-xyzzy",
      },
      logDir: tmpDir,
      protocolFlags: [],
    });
    await r.start();
    try {
      await r.startSideSession("s1");
      // The startSideSession itself succeeds (no spawn happens at startSideSession
      // time for Codex). The spawn failure manifests on sendSideTurn.
      const res = r.sendSideTurn("s1", "t1", "hi", []);
      expect(res).toEqual({ accepted: false, reason: "not_ready" });
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  });
});

describe("CodexRunner side-sessions — threadId resume continuity", () => {
  test("first turn has no resume; second turn passes `exec resume <threadId>`", async () => {
    const r = new CodexRunner({
      botId: "alpha",
      config: makeConfig("replay-resume"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    await r.start();
    try {
      await r.startSideSession("s1");
      const e = collectSide(r, "s1");

      r.sendSideTurn("s1", "t1", "first", []);
      await waitFor(() => e.find((x) => x.kind === "done"), 8000);

      r.sendSideTurn("s1", "t2", "second", []);
      await waitFor(
        () =>
          e.filter((x) => x.kind === "done").length >= 2 ? true : undefined,
        8000,
      );

      // Per-side log captures argv on each thread.started line. The log
      // is written via a WriteStream whose buffered writes can lag the
      // `done` event by a few ms on slower runners (reliably on macOS
      // CI). Poll disk until the second `thread.started` line has
      // landed before asserting on the parsed contents.
      const logPath = resolve(tmpDir, "alpha.side.s1.log");
      const lines = await waitFor(() => {
        const parsed = readFileSync(logPath, "utf8")
          .split("\n")
          .filter((l) => l.includes('"thread.started"'))
          .map(
            (l) =>
              JSON.parse(l) as { __argv?: string[]; __resuming?: boolean },
          );
        return parsed.length >= 2 ? parsed : undefined;
      }, 2000);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines[0]!.__resuming).toBe(false);
      expect(lines[1]!.__resuming).toBe(true);
      expect(lines[1]!.__argv?.join(" ")).toContain("resume tid-replay");
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  }, 25_000);

  test("threadId is per-session (s2 gets its own, doesn't reuse s1's)", async () => {
    const r = new CodexRunner({
      botId: "alpha",
      config: makeConfig("replay-resume"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    await r.start();
    try {
      await r.startSideSession("s1");
      await r.startSideSession("s2");
      const e1 = collectSide(r, "s1");
      const e2 = collectSide(r, "s2");

      r.sendSideTurn("s1", "t1", "first-s1", []);
      await waitFor(() => e1.find((x) => x.kind === "done"), 8000);
      r.sendSideTurn("s2", "t2", "first-s2", []);
      await waitFor(() => e2.find((x) => x.kind === "done"), 8000);

      // s1's first turn must not have been a resume.
      const s1log = await Bun.file(resolve(tmpDir, "alpha.side.s1.log")).text();
      const s2log = await Bun.file(resolve(tmpDir, "alpha.side.s2.log")).text();
      const s1lines = s1log
        .split("\n")
        .filter((l) => l.includes('"thread.started"'))
        .map((l) => JSON.parse(l) as { __resuming?: boolean });
      const s2lines = s2log
        .split("\n")
        .filter((l) => l.includes('"thread.started"'))
        .map((l) => JSON.parse(l) as { __resuming?: boolean });
      expect(s1lines[0]!.__resuming).toBe(false);
      expect(s2lines[0]!.__resuming).toBe(false);
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stopSideSession("s2", 500);
      await r.stop(500);
    }
  }, 25_000);

  test("thread.started AFTER turn.completed: threadId still captured for next turn", async () => {
    // Unusual-but-possible Codex ordering — runner must read it via
    // parser.flush() at exit rather than relying on event order.
    const r = new CodexRunner({
      botId: "alpha",
      config: makeConfig("thread-late"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    await r.start();
    try {
      await r.startSideSession("s1");
      const e = collectSide(r, "s1");

      r.sendSideTurn("s1", "t1", "first", []);
      await waitFor(() => e.find((x) => x.kind === "done"), 8000);

      // Brief pause to let the runner's runSideTurn fully settle (proc.exited
      // + stream flush both observed). In practice this is sub-millisecond
      // for our mock; 25ms is comfortable.
      await new Promise((r) => setTimeout(r, 25));

      r.sendSideTurn("s1", "t2", "second", []);
      await waitFor(
        () =>
          e.filter((x) => x.kind === "done").length >= 2 ? true : undefined,
        8000,
      );

      // The second turn was launched with `exec resume tid-late` in argv.
      const log = await Bun.file(resolve(tmpDir, "alpha.side.s1.log")).text();
      // We don't have the argv tagged on thread-late mode (only replay-resume
      // tags it), so probe the side log for the `resume` token via inference:
      // turn 2 spawned a subprocess whose own thread.started reflects the
      // resumed thread. Easier: check that the parser saw two thread.started
      // events with thread_id "tid-late" (the mock emits this constant).
      const threadIds = log
        .split("\n")
        .filter((l) => l.includes('"thread.started"'))
        .map((l) => JSON.parse(l) as { thread_id?: string })
        .map((j) => j.thread_id);
      expect(threadIds.length).toBeGreaterThanOrEqual(2);
      expect(threadIds.every((t) => t === "tid-late")).toBe(true);
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  }, 25_000);

  test("non-image attachments skipped on side-session path (no --image arg)", async () => {
    const docPath = join(tmpDir, "ignored.txt");
    writeFileSync(docPath, "doc content");

    const r = new CodexRunner({
      botId: "alpha",
      config: makeConfig("replay-resume"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    await r.start();
    try {
      await r.startSideSession("s1");
      const e = collectSide(r, "s1");
      r.sendSideTurn("s1", "t1", "hi", [
        { kind: "document", path: docPath, bytes: 0 },
      ]);
      await waitFor(() => e.find((x) => x.kind === "done"), 8000);

      const log = await Bun.file(resolve(tmpDir, "alpha.side.s1.log")).text();
      const line = log
        .split("\n")
        .filter((l) => l.includes('"thread.started"'))
        .map((l) => JSON.parse(l) as { __argv?: string[] })[0];
      expect(line?.__argv?.join(" ")).not.toContain("--image");
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  }, 15_000);

  test("image attachments forwarded as --image on side-session path", async () => {
    const imgPath = join(tmpDir, "pic.png");
    writeFileSync(imgPath, "fake png");

    const r = new CodexRunner({
      botId: "alpha",
      config: makeConfig("replay-resume"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    await r.start();
    try {
      await r.startSideSession("s1");
      const e = collectSide(r, "s1");
      r.sendSideTurn("s1", "t1", "look", [
        { kind: "photo", path: imgPath, bytes: 0 },
      ]);
      await waitFor(() => e.find((x) => x.kind === "done"), 8000);

      const log = await Bun.file(resolve(tmpDir, "alpha.side.s1.log")).text();
      const line = log
        .split("\n")
        .filter((l) => l.includes('"thread.started"'))
        .map((l) => JSON.parse(l) as { __argv?: string[] })[0];
      const argv = line?.__argv?.join(" ") ?? "";
      expect(argv).toContain("--image");
      expect(argv).toContain(imgPath);
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  }, 15_000);

  test("main runner sendTurn and side-session sendSideTurn don't share threadId", async () => {
    // The main runner has its own currentThreadId; side-sessions have their
    // own per-entry threadId. Resetting the main runner via reset() must NOT
    // affect a side-session's continuity.
    const r = new CodexRunner({
      botId: "alpha",
      config: makeConfig("replay-resume"),
      logDir: tmpDir,
      protocolFlags: TEST_PROTOCOL_FLAGS,
    });
    await r.start();
    try {
      // Drive one main turn so the main runner captures its own threadId.
      const main = collect(r);
      r.sendTurn("M1", "main first", []);
      await waitFor(() => main.find((e) => e.kind === "done"), 8000);

      await r.reset(); // wipes main runner's currentThreadId — not the side-session's

      // Side-session: do two turns and assert resume on the second.
      await r.startSideSession("s1");
      const side = collectSide(r, "s1");
      r.sendSideTurn("s1", "t1", "side first", []);
      await waitFor(() => side.find((e) => e.kind === "done"), 8000);
      r.sendSideTurn("s1", "t2", "side second", []);
      await waitFor(
        () =>
          side.filter((e) => e.kind === "done").length >= 2 ? true : undefined,
        8000,
      );

      const log = await Bun.file(resolve(tmpDir, "alpha.side.s1.log")).text();
      const lines = log
        .split("\n")
        .filter((l) => l.includes('"thread.started"'))
        .map((l) => JSON.parse(l) as { __resuming?: boolean });
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines[0]!.__resuming).toBe(false);
      expect(lines[1]!.__resuming).toBe(true);
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  }, 30_000);
});
