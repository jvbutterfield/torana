// Side-session tests for CommandRunner (US-007, Phase 2c). Three protocol
// branches:
//
//   - `claude-ndjson`   → side-sessions supported (long-lived subprocess).
//   - `codex-jsonl`     → side-sessions supported (long-lived subprocess).
//   - `jsonl-text`      → side-sessions unsupported; methods throw.
//
// The critical invariant matches claude-code/codex: events from a side
// subprocess land ONLY on that session's emitter — never on the main
// runner's emitter, never on another side session's emitter. Each
// side-session runs the user's `cmd` again with `TORANA_SESSION_ID=<id>`
// set so the wrapper can distinguish main vs side.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CommandRunner } from "../../src/runner/command.js";
import type { CommandRunnerConfig } from "../../src/config/schema.js";
import type { RunnerEvent } from "../../src/runner/types.js";
import {
  InvalidSideSessionId,
  RunnerDoesNotSupportSideSessions,
  SideSessionAlreadyExists,
  SideSessionNotFound,
} from "../../src/runner/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NDJSON_MOCK = resolve(__dirname, "fixtures/command-ndjson-mock.ts");
const CODEX_MOCK = resolve(__dirname, "fixtures/command-codex-mock.ts");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-cmd-side-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(
  protocol: "claude-ndjson" | "codex-jsonl" | "jsonl-text",
  mockPath: string,
  mode = "normal",
): CommandRunnerConfig {
  return {
    type: "command",
    cmd: ["bun", "run", mockPath, mode],
    protocol,
    env: {},
    on_reset: "signal",
  };
}

function newRunner(
  protocol: "claude-ndjson" | "codex-jsonl",
  mode = "normal",
): CommandRunner {
  const mock = protocol === "claude-ndjson" ? NDJSON_MOCK : CODEX_MOCK;
  return new CommandRunner({
    botId: "alpha",
    config: makeConfig(protocol, mock, mode),
    logDir: tmpDir,
    sideStartupMs: 500,
  });
}

function collect(runner: CommandRunner): RunnerEvent[] {
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

function collectSide(runner: CommandRunner, sessionId: string): RunnerEvent[] {
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

// ---------------------------------------------------------------------------
// jsonl-text — side-sessions unsupported (Phase 2c explicitly does NOT flip
// this protocol's bit; its wire format has no session semantics).
// ---------------------------------------------------------------------------

describe("CommandRunner side-sessions — jsonl-text (unsupported)", () => {
  test("supportsSideSessions() is false", () => {
    const r = new CommandRunner({
      botId: "alpha",
      config: makeConfig("jsonl-text", NDJSON_MOCK),
      logDir: tmpDir,
    });
    expect(r.supportsSideSessions()).toBe(false);
  });

  test("all side-session methods throw RunnerDoesNotSupportSideSessions", async () => {
    const r = new CommandRunner({
      botId: "alpha",
      config: makeConfig("jsonl-text", NDJSON_MOCK),
      logDir: tmpDir,
    });
    await expect(r.startSideSession("s1")).rejects.toBeInstanceOf(
      RunnerDoesNotSupportSideSessions,
    );
    expect(() => r.sendSideTurn("s1", "t1", "hi", [])).toThrow(
      RunnerDoesNotSupportSideSessions,
    );
    expect(() => r.onSide("s1", "done", () => {})).toThrow(
      RunnerDoesNotSupportSideSessions,
    );
    await expect(r.stopSideSession("s1")).rejects.toBeInstanceOf(
      RunnerDoesNotSupportSideSessions,
    );
  });
});

// ---------------------------------------------------------------------------
// Shared contract tests, driven against BOTH side-session-capable protocols
// so regressions in either can't sneak past one-protocol coverage.
// ---------------------------------------------------------------------------

for (const protocol of ["claude-ndjson", "codex-jsonl"] as const) {
  describe(`CommandRunner side-sessions — ${protocol}`, () => {
    test("supportsSideSessions() returns true", () => {
      const r = newRunner(protocol);
      expect(r.supportsSideSessions()).toBe(true);
    });

    test("id validation rejects bad shapes", async () => {
      const r = newRunner(protocol);
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
        /* no live sessions to clean up */
      }
    });

    test("double-start same session id → SideSessionAlreadyExists", async () => {
      const r = newRunner(protocol);
      try {
        await r.startSideSession("s1");
        await expect(r.startSideSession("s1")).rejects.toBeInstanceOf(
          SideSessionAlreadyExists,
        );
      } finally {
        await r.stopSideSession("s1", 500);
      }
    });

    test("onSide before startSideSession → SideSessionNotFound", () => {
      const r = newRunner(protocol);
      expect(() => r.onSide("nope", "done", () => {})).toThrow(
        SideSessionNotFound,
      );
    });

    test("happy path: side sendSideTurn lands events on side emitter only", async () => {
      const r = newRunner(protocol);
      await r.start();
      const mainEvents = collect(r);
      try {
        await r.startSideSession("s1");
        const sideEvents = collectSide(r, "s1");

        const res = r.sendSideTurn("s1", "turn-1", "hello-side", []);
        expect(res.accepted).toBe(true);
        await waitFor(() => sideEvents.find((e) => e.kind === "done"), 5000);

        // Main emitter saw the main ready event only — no side events bled in.
        expect(mainEvents.filter((e) => e.kind === "text_delta").length).toBe(
          0,
        );
        expect(mainEvents.filter((e) => e.kind === "done").length).toBe(0);

        const sideText = sideEvents.find((e) => e.kind === "text_delta") as
          | { text: string; turnId: string }
          | undefined;
        expect(sideText?.turnId).toBe("turn-1");
        // Mock stamps TORANA_SESSION_ID into the text so we can see routing
        // worked end-to-end.
        expect(sideText?.text).toContain("[s1]");
        expect(sideText?.text).toContain("hello-side");
      } finally {
        await r.stopSideSession("s1", 500);
        await r.stop(500);
      }
    }, 15_000);

    test("two concurrent side sessions don't cross-contaminate events", async () => {
      const r = newRunner(protocol);
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

        const t1 = e1.find((e) => e.kind === "text_delta") as
          | { text: string }
          | undefined;
        const t2 = e2.find((e) => e.kind === "text_delta") as
          | { text: string }
          | undefined;
        expect(t1?.text).toContain("[s1]");
        expect(t1?.text).toContain("payload-one");
        expect(t2?.text).toContain("[s2]");
        expect(t2?.text).toContain("payload-two");

        // Stricter: neither side saw any text_delta tagged for the other.
        expect(
          e1.every(
            (e) =>
              e.kind !== "text_delta" ||
              !(e as { text: string }).text.includes("[s2]"),
          ),
        ).toBe(true);
        expect(
          e2.every(
            (e) =>
              e.kind !== "text_delta" ||
              !(e as { text: string }).text.includes("[s1]"),
          ),
        ).toBe(true);
      } finally {
        await r.stopSideSession("s1", 500);
        await r.stopSideSession("s2", 500);
        await r.stop(500);
      }
    }, 20_000);

    test("sendSideTurn while session is busy → {accepted:false, reason:'busy'}", async () => {
      // slow-echo gives us ~500ms mid-turn to fire the second send.
      const r = newRunner(protocol, "slow-echo");
      await r.start();
      try {
        await r.startSideSession("s1");
        const first = r.sendSideTurn("s1", "t1", "first", []);
        expect(first.accepted).toBe(true);
        const second = r.sendSideTurn("s1", "t2", "second", []);
        expect(second).toEqual({ accepted: false, reason: "busy" });
        // Drain the in-flight turn so teardown doesn't hang.
        const e = collectSide(r, "s1");
        await waitFor(() => e.find((x) => x.kind === "done"), 5000);
      } finally {
        await r.stopSideSession("s1", 2000);
        await r.stop(2000);
      }
    }, 15_000);

    test("sendSideTurn for an unknown session → not_ready (no throw)", async () => {
      const r = newRunner(protocol);
      try {
        const res = r.sendSideTurn("nope", "t1", "hi", []);
        expect(res).toEqual({ accepted: false, reason: "not_ready" });
      } finally {
        /* nothing to stop */
      }
    });

    test("stopSideSession idles the entry; same id can be restarted", async () => {
      const r = newRunner(protocol);
      await r.start();
      try {
        await r.startSideSession("s1");
        await r.stopSideSession("s1", 1000);
        // Restart with the same id must succeed — stop scrubbed the entry.
        await r.startSideSession("s1");
        const e = collectSide(r, "s1");
        r.sendSideTurn("s1", "t1", "again", []);
        await waitFor(() => e.find((x) => x.kind === "done"), 5000);
      } finally {
        await r.stopSideSession("s1", 500);
        await r.stop(500);
      }
    }, 15_000);

    test("unexpected exit mid-turn → fatal on side emitter only", async () => {
      const r = newRunner(protocol, "crash-on-turn");
      await r.start();
      const mainEvents = collect(r);
      try {
        await r.startSideSession("s1");
        const sideEvents = collectSide(r, "s1");
        const res = r.sendSideTurn("s1", "t1", "boom", []);
        expect(res.accepted).toBe(true);
        await waitFor(() => sideEvents.find((e) => e.kind === "fatal"), 5000);
        // Main runner emitter is untouched by side subprocess death.
        expect(mainEvents.find((e) => e.kind === "fatal")).toBeUndefined();
      } finally {
        await r.stop(500);
      }
    }, 15_000);

    test("side log file lands at <data_dir>/<bot_id>.side.<sessionId>.log", async () => {
      const r = newRunner(protocol);
      await r.start();
      try {
        await r.startSideSession("logged-1");
        const e = collectSide(r, "logged-1");
        const send = r.sendSideTurn("logged-1", "log-turn", "log-me", []);
        expect(send.accepted).toBe(true);
        await waitFor(() => e.find((x) => x.kind === "done"), 5000);

        const logPath = resolve(tmpDir, "alpha.side.logged-1.log");
        const file = Bun.file(logPath);
        expect(await file.exists()).toBe(true);
        const text = await file.text();
        expect(text.length).toBeGreaterThan(0);
        expect(text).toContain("log-me");
        // Per-side mock stamps TORANA_SESSION_ID into the text, so the log
        // reflects the session-scoped env var rather than leaking main.
        expect(text).toContain("[logged-1]");
      } finally {
        await r.stopSideSession("logged-1", 500);
        await r.stop(500);
      }
    }, 15_000);

    test("spawn failure leaves no phantom entry in the sideSessions map", async () => {
      const badProtocol = protocol;
      const r = new CommandRunner({
        botId: "alpha",
        config: {
          type: "command",
          cmd: ["/nonexistent/binary-xyzzy"],
          protocol: badProtocol,
          env: {},
          on_reset: "signal",
        },
        logDir: tmpDir,
        sideStartupMs: 200,
      });
      try {
        await r.startSideSession("s1").then(
          () => {
            throw new Error("expected startSideSession to reject");
          },
          () => {
            /* expected */
          },
        );
        // Entry was scrubbed — onSide must not see a phantom entry.
        expect(() => r.onSide("s1", "done", () => {})).toThrow(
          SideSessionNotFound,
        );
      } finally {
        /* nothing to stop — spawn failed */
      }
    });

    test("stopSideSession on unknown id is silent (no throw)", async () => {
      // Crash-safe contract: handler `finally` blocks call stopSideSession
      // after the pool has already scrubbed the entry during shutdown or
      // hard-TTL sweep; a throw here would mask the original error.
      const r = newRunner(protocol);
      await expect(
        r.stopSideSession("nonexistent", 500),
      ).resolves.toBeUndefined();
    });

    test("stopSideSession is idempotent — concurrent second call coalesces", async () => {
      // Phase 3 pool's shutdown races two `stopSideSession` calls against
      // an ephemeral release; the runner must coalesce so the subprocess
      // is SIGTERM'd/SIGKILL'd exactly once. Async functions wrap return
      // values in new Promise instances so we can't assert reference
      // equality on the outer promises; instead we assert behavioral
      // coalescence: both calls resolve, neither throws, the entry is
      // fully scrubbed, and a THIRD call on the now-unknown id is also
      // silent (no throw).
      const r = newRunner(protocol);
      await r.start();
      await r.startSideSession("s1");
      const [ok1, ok2] = await Promise.all([
        r
          .stopSideSession("s1", 1000)
          .then(() => true)
          .catch(() => false),
        r
          .stopSideSession("s1", 1000)
          .then(() => true)
          .catch(() => false),
      ]);
      expect(ok1).toBe(true);
      expect(ok2).toBe(true);
      // Entry is gone.
      expect(() => r.onSide("s1", "done", () => {})).toThrow(
        SideSessionNotFound,
      );
      // Third call on a now-unknown id must be silent.
      await expect(r.stopSideSession("s1", 500)).resolves.toBeUndefined();
      await r.stop(500);
    }, 15_000);
  });
}

// ---------------------------------------------------------------------------
// Additional startSideSession failure-mode coverage (claude-ndjson only —
// the ready-gate + scrub-on-failure code path is protocol-independent).
// ---------------------------------------------------------------------------

describe("CommandRunner side-sessions — startSideSession failure modes", () => {
  test("subprocess exits before emitting ready → startSideSession rejects + entry scrubbed", async () => {
    // `crash-on-start` exits immediately with no stdout. `watchSideExit`
    // must reject `readyPromise`, emit fatal on the side emitter, and
    // startSideSession catches the rejection and scrubs the entry.
    const r = new CommandRunner({
      botId: "alpha",
      config: makeConfig("claude-ndjson", NDJSON_MOCK, "crash-on-start"),
      logDir: tmpDir,
      sideStartupMs: 2000, // long enough that the exit rejects first
    });
    await expect(r.startSideSession("s1")).rejects.toThrow(
      /exited before ready/,
    );
    // Entry scrubbed: restart with same id succeeds and `onSide` no longer
    // sees a phantom entry.
    expect(() => r.onSide("s1", "done", () => {})).toThrow(SideSessionNotFound);
  }, 15_000);

  test("subprocess never emits ready → sideStartupMs fallback forces ready", async () => {
    // `no-ready` stays alive but never emits the init event. After
    // `sideStartupMs`, the runner promotes the entry to ready anyway so a
    // wrapper that forgets the protocol's startup signal still works —
    // callers would otherwise hang indefinitely.
    const r = new CommandRunner({
      botId: "alpha",
      config: makeConfig("claude-ndjson", NDJSON_MOCK, "no-ready"),
      logDir: tmpDir,
      sideStartupMs: 150, // short so the test doesn't slow the suite
    });
    const beforeMs = Date.now();
    await r.startSideSession("s1");
    const elapsedMs = Date.now() - beforeMs;
    // Readiness came from the fallback timer, not the parser — so the wait
    // must have been at least ~sideStartupMs.
    expect(elapsedMs).toBeGreaterThanOrEqual(100);

    // The session is usable: send a turn, get an event back. no-ready mode
    // still handles turn envelopes — it just skips the init.
    const e = collectSide(r, "s1");
    const res = r.sendSideTurn("s1", "t1", "after-fallback", []);
    expect(res.accepted).toBe(true);
    await waitFor(() => e.find((x) => x.kind === "done"), 5000);
    await r.stopSideSession("s1", 500);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Side-turn attachments — both protocols use the same per-protocol encoder
// as the main runner. Claude-ndjson appends "[Attached file: <path>]" to
// the content; jsonl-text (used as codex-jsonl's outbound envelope) puts
// attachments in a top-level `attachments` array.
// ---------------------------------------------------------------------------

describe("CommandRunner side-sessions — attachment forwarding", () => {
  test("claude-ndjson: side-turn attachments surface in user envelope content", async () => {
    const r = newRunner("claude-ndjson");
    await r.start();
    try {
      await r.startSideSession("s1");
      const e = collectSide(r, "s1");
      const res = r.sendSideTurn("s1", "t1", "look", [
        { kind: "document", path: "/tmp/attach-A.txt", bytes: 0 },
        { kind: "photo", path: "/tmp/attach-B.png", bytes: 0 },
      ]);
      expect(res.accepted).toBe(true);
      await waitFor(() => e.find((x) => x.kind === "done"), 5000);

      // Side-subprocess log reflects the stdin payload (mock writes incoming
      // traffic to its log via the runner's log pipe). Grep for the
      // attachment paths to confirm encoding landed downstream.
      const log = await Bun.file(resolve(tmpDir, "alpha.side.s1.log")).text();
      const text = e.find((x) => x.kind === "text_delta") as
        | { text: string }
        | undefined;
      // The mock's reply echoes the inbound `content` field, which for
      // claude-ndjson includes "[Attached file: …]" lines appended by
      // `encodeClaudeNdjsonTurn`.
      expect(text?.text).toContain("[Attached file: /tmp/attach-A.txt]");
      expect(text?.text).toContain("[Attached file: /tmp/attach-B.png]");
      // Log should also contain one of the paths (any direction — either
      // stdin replay or the stdout echo).
      expect(log).toContain("/tmp/attach-A.txt");
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  }, 15_000);

  test("codex-jsonl: side-turn attachments surface in jsonl-text envelope", async () => {
    // codex-jsonl CommandRunner encodes outbound turns with the jsonl-text
    // envelope (current main-runner behavior); attachments are carried in
    // a top-level `attachments: []` field, NOT inlined into text. The mock
    // surfaces attachment paths into the reply so we can assert the wire
    // carried them.
    const r = newRunner("codex-jsonl");
    await r.start();
    try {
      await r.startSideSession("s1");
      const e = collectSide(r, "s1");
      const res = r.sendSideTurn("s1", "t1", "doc", [
        { kind: "document", path: "/tmp/codex-attach.txt", bytes: 0 },
        { kind: "photo", path: "/tmp/codex-pic.png", bytes: 0 },
      ]);
      expect(res.accepted).toBe(true);
      await waitFor(() => e.find((x) => x.kind === "done"), 5000);

      const text = e.find((x) => x.kind === "text_delta") as
        | { text: string }
        | undefined;
      expect(text?.text).toContain("doc");
      // Both attachment paths must have reached the subprocess.
      expect(text?.text).toContain("[Attached file: /tmp/codex-attach.txt]");
      expect(text?.text).toContain("[Attached file: /tmp/codex-pic.png]");
    } finally {
      await r.stopSideSession("s1", 500);
      await r.stop(500);
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// TORANA_SESSION_ID env var contract — explicit rather than implicit. Uses
// the `reply-env` mock mode to surface the raw env var (or "unset").
// ---------------------------------------------------------------------------

describe("CommandRunner side-sessions — TORANA_SESSION_ID env var contract", () => {
  test("side subprocess receives TORANA_SESSION_ID=<sessionId>", async () => {
    const r = newRunner("claude-ndjson", "reply-env");
    await r.start();
    try {
      await r.startSideSession("envtest");
      const e = collectSide(r, "envtest");
      r.sendSideTurn("envtest", "t1", "ping", []);
      await waitFor(() => e.find((x) => x.kind === "done"), 5000);
      const text = e.find((x) => x.kind === "text_delta") as
        | { text: string }
        | undefined;
      expect(text?.text).toContain("env=envtest");
    } finally {
      await r.stopSideSession("envtest", 500);
      await r.stop(500);
    }
  }, 15_000);

  test("main subprocess does NOT receive TORANA_SESSION_ID", async () => {
    // Main runner must not leak TORANA_SESSION_ID — a wrapper with dual
    // behavior (separate state for main vs side) needs the env to be
    // reliably absent on main.
    const r = new CommandRunner({
      botId: "alpha",
      config: makeConfig("claude-ndjson", NDJSON_MOCK, "reply-env"),
      logDir: tmpDir,
      sideStartupMs: 500,
    });
    await r.start();
    const main = collect(r);
    try {
      await waitFor(() => main.find((e) => e.kind === "ready"), 5000);
      r.sendTurn("M1", "hello", []);
      await waitFor(() => main.find((e) => e.kind === "done"), 5000);
      const text = main.find((e) => e.kind === "text_delta") as
        | { text: string }
        | undefined;
      // reply-env stamps "env=unset" when TORANA_SESSION_ID is absent.
      expect(text?.text).toContain("env=unset");
    } finally {
      await r.stop(500);
    }
  }, 15_000);
});
