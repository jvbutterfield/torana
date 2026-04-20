// Side-session tests for ClaudeCodeRunner (US-005). The critical invariant:
// events from a side-session subprocess must land ONLY on that session's
// emitter — never on the main runner's emitter, never on another side
// session's emitter.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeCodeRunner } from "../../src/runner/claude-code.js";
import type { ClaudeCodeRunnerConfig } from "../../src/config/schema.js";
import type { RunnerEvent } from "../../src/runner/types.js";
import {
  InvalidSideSessionId,
  SideSessionAlreadyExists,
  SideSessionNotFound,
} from "../../src/runner/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(__dirname, "fixtures/claude-mock.ts");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-cc-side-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(mode: string): ClaudeCodeRunnerConfig {
  return {
    type: "claude-code",
    cli_path: "bun",
    args: ["run", MOCK, mode],
    env: {},
    pass_continue_flag: false,
  };
}

function newRunner(mode = "normal"): ClaudeCodeRunner {
  return new ClaudeCodeRunner({
    botId: "alpha",
    config: makeConfig(mode),
    logDir: tmpDir,
    protocolFlags: [],
    startupMs: 100,
  });
}

function collect(runner: ClaudeCodeRunner): RunnerEvent[] {
  const events: RunnerEvent[] = [];
  const kinds = ["ready", "text_delta", "done", "error", "fatal", "rate_limit", "status"] as const;
  for (const k of kinds) runner.on(k, (ev) => events.push(ev as RunnerEvent));
  return events;
}

function collectSide(runner: ClaudeCodeRunner, sessionId: string): RunnerEvent[] {
  const events: RunnerEvent[] = [];
  const kinds = ["ready", "text_delta", "done", "error", "fatal", "rate_limit", "status"] as const;
  for (const k of kinds) runner.onSide(sessionId, k, (ev) => events.push(ev as RunnerEvent));
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

describe("ClaudeCodeRunner side-sessions", () => {
  test("id validation rejects bad shapes", async () => {
    const r = newRunner();
    await r.start();
    try {
      await expect(r.startSideSession("")).rejects.toBeInstanceOf(InvalidSideSessionId);
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
    expect(() => r.onSide("nope", "done", () => {})).toThrow(SideSessionNotFound);
  });

  test("side sendSideTurn: ready → text_delta + done land only on side emitter", async () => {
    const r = newRunner();
    await r.start();
    const mainEvents = collect(r);
    try {
      await r.startSideSession("s1");
      const sideEvents = collectSide(r, "s1");

      const res = r.sendSideTurn("s1", "turn-1", "hello-side", []);
      expect(res.accepted).toBe(true);
      await waitFor(() => sideEvents.find((e) => e.kind === "done"), 5000);

      // Main emitter saw the main ready event only; no side events bled in.
      const mainTextDeltas = mainEvents.filter((e) => e.kind === "text_delta");
      const mainDones = mainEvents.filter((e) => e.kind === "done");
      expect(mainTextDeltas.length).toBe(0);
      expect(mainDones.length).toBe(0);

      // Side emitter got both text_delta and done for the expected turn.
      const sideText = sideEvents.find((e) => e.kind === "text_delta");
      const sideDone = sideEvents.find((e) => e.kind === "done");
      expect(sideText && (sideText as { text: string }).text).toBe("echo: hello-side");
      expect(sideDone && (sideDone as { turnId: string }).turnId).toBe("turn-1");
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  });

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

      await waitFor(() => e1.find((e) => e.kind === "done"), 5000);
      await waitFor(() => e2.find((e) => e.kind === "done"), 5000);

      const t1 = e1.find((e) => e.kind === "text_delta") as { text: string } | undefined;
      const t2 = e2.find((e) => e.kind === "text_delta") as { text: string } | undefined;
      expect(t1?.text).toBe("echo: payload-one");
      expect(t2?.text).toBe("echo: payload-two");

      // Neither side saw the other's payload.
      expect(e1.every((e) => e.kind !== "text_delta" || (e as { text: string }).text.includes("one"))).toBe(
        true,
      );
      expect(e2.every((e) => e.kind !== "text_delta" || (e as { text: string }).text.includes("two"))).toBe(
        true,
      );
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stopSideSession("s2", 500);
      await r.stop(500);
    }
  });

  test("sendSideTurn while session is busy → {accepted:false, reason:'busy'}", async () => {
    const r = newRunner();
    await r.start();
    try {
      await r.startSideSession("s1");
      const first = r.sendSideTurn("s1", "t1", "hi", []);
      expect(first.accepted).toBe(true);
      // Without waiting for done, the second call must be rejected.
      const second = r.sendSideTurn("s1", "t2", "hi2", []);
      expect(second).toEqual({ accepted: false, reason: "busy" });
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  });

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
      await waitFor(() => e.find((x) => x.kind === "done"), 5000);
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  });

  test("unexpected exit mid-turn → fatal on side emitter only", async () => {
    // Use "crash-on-turn" mock so the first side turn kills the subprocess.
    const r = new ClaudeCodeRunner({
      botId: "alpha",
      config: makeConfig("crash-on-turn"),
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 100,
    });
    await r.start();
    const mainEvents = collect(r);
    try {
      await r.startSideSession("s1");
      const sideEvents = collectSide(r, "s1");
      const res = r.sendSideTurn("s1", "t1", "boom", []);
      expect(res.accepted).toBe(true);
      // Expect fatal on side.
      await waitFor(() => sideEvents.find((e) => e.kind === "fatal"), 5000);
      // Main runner is unaffected (still ready).
      expect(mainEvents.find((e) => e.kind === "fatal")).toBeUndefined();
    } finally {
      await r.stop(500);
    }
  });

  test("side log file lands at <data_dir>/<bot_id>.side.<sessionId>.log (US-005)", async () => {
    // PRD US-005: "Each side-session gets its own log file at
    // <data_dir>/logs/<bot_id>.side.<sessionId>.log using the same writer
    // the main runner uses." Codex has 6 explicit log-path assertions;
    // Claude had none until this test landed.
    const r = newRunner();
    await r.start();
    try {
      await r.startSideSession("logged-1");
      const sideEvents = collectSide(r, "logged-1");
      const send = r.sendSideTurn("logged-1", "log-turn", "log-me", []);
      expect(send.accepted).toBe(true);
      await waitFor(() => sideEvents.find((e) => e.kind === "done"), 5000);

      const logPath = resolve(tmpDir, "alpha.side.logged-1.log");
      const file = Bun.file(logPath);
      expect(await file.exists()).toBe(true);
      const text = await file.text();
      // Log captures the runner stdio — at minimum the echo response.
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain("echo: log-me");
    } finally {
      await r.stopSideSession("logged-1", 500);
      await r.stop(500);
    }
  });

  test("claude --session-id receives a UUID, not the pool's sessionId (CLI 2.1+ compat)", async () => {
    // Regression guard for §12.4 ask-claude E2E. Claude CLI 2.1+
    // rejects non-UUID values with `Invalid session ID. Must be a
    // valid UUID.` The pool's sessionId can be any
    // [A-Za-z0-9_-]{1,64} (commonly `eph-<uuid>`), so the runner
    // mints a fresh UUID per startSideSession and passes that to
    // --session-id. The public API still uses the pool's sessionId.
    const captured: string[][] = [];
    const r = new ClaudeCodeRunner({
      botId: "alpha",
      config: makeConfig("normal"),
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 100,
      spawnImpl: ((opts: Parameters<typeof import("bun").spawn>[0]) => {
        const cmd = (opts as { cmd?: unknown }).cmd;
        if (Array.isArray(cmd)) captured.push([...cmd] as string[]);
        // Delegate to real spawn so the rest of the runner machinery
        // works. We just snoop the argv.
        return (require("bun") as typeof import("bun")).spawn(opts);
      }) as never,
    });
    await r.start();
    try {
      const poolSessionId = "eph-not-a-uuid-prefix-123";
      await r.startSideSession(poolSessionId);
      try {
        // Find the side-session argv (second spawn call; first is main.start).
        const sideArgv = captured.find(
          (cmd) => cmd.includes("--session-id"),
        );
        expect(sideArgv).toBeDefined();
        const idx = sideArgv!.indexOf("--session-id");
        const passedId = sideArgv![idx + 1]!;
        // Must NOT echo the pool's session id (which is not UUID-shaped).
        expect(passedId).not.toBe(poolSessionId);
        // Must match a UUID v4 shape (hex blocks separated by dashes).
        expect(passedId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      } finally {
        await r.stopSideSession(poolSessionId, 500);
      }
    } finally {
      await r.stop(500);
    }
  });

  test("spawn failure leaves no phantom entry in the sideSessions map", async () => {
    const r = new ClaudeCodeRunner({
      botId: "alpha",
      config: {
        type: "claude-code",
        cli_path: "/nonexistent/binary-xyzzy",
        args: [],
        env: {},
        pass_continue_flag: false,
      },
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 100,
    });
    // main.start() will eventually fatal but we only care about side behaviour.
    try {
      await r.startSideSession("s1").then(
        () => {
          throw new Error("expected startSideSession to reject");
        },
        () => {
          /* expected */
        },
      );
      // Entry was scrubbed — retrying a different id should NOT see leftover state.
      expect(() => r.onSide("s1", "done", () => {})).toThrow(SideSessionNotFound);
    } finally {
      await r.stop(500);
    }
  });
});
