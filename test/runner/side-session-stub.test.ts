// Cross-runner side-session support + id validation contract.
//
// Phases 2a (claude-code), 2b (codex), and 2c (command) each implemented
// side-sessions for their runner. This file guards two invariants:
//   1. Each runner's runtime `supportsSideSessions()` matches the static
//      `runnerSupportsSideSessions(config)` answer exported from
//      `src/runner/types.ts` — the "drift guard". Doctor C011 and docs
//      both read the static helper; if they diverge the test fails.
//   2. Per-protocol capability bits for the `command` runner are
//      correctly plumbed (`claude-ndjson`/`codex-jsonl` → true,
//      `jsonl-text` → false).

import { describe, expect, test } from "bun:test";
import { ClaudeCodeRunner } from "../../src/runner/claude-code.js";
import { CodexRunner } from "../../src/runner/codex.js";
import { CommandRunner } from "../../src/runner/command.js";
import {
  InvalidSideSessionId,
  RunnerDoesNotSupportSideSessions,
  SIDE_SESSION_ID_REGEX,
  runnerSupportsSideSessions,
  validateSideSessionId,
} from "../../src/runner/types.js";

describe("side-session id validation", () => {
  test("accepts valid ids", () => {
    expect(SIDE_SESSION_ID_REGEX.test("abc")).toBe(true);
    expect(SIDE_SESSION_ID_REGEX.test("eph-abc_123")).toBe(true);
    expect(SIDE_SESSION_ID_REGEX.test("A".repeat(64))).toBe(true);
  });
  test("rejects invalid ids", () => {
    expect(SIDE_SESSION_ID_REGEX.test("")).toBe(false);
    expect(SIDE_SESSION_ID_REGEX.test("has space")).toBe(false);
    expect(SIDE_SESSION_ID_REGEX.test("has/slash")).toBe(false);
    expect(SIDE_SESSION_ID_REGEX.test("a".repeat(65))).toBe(false);
  });
  test("validateSideSessionId throws InvalidSideSessionId on bad input", () => {
    expect(() => validateSideSessionId("")).toThrow(InvalidSideSessionId);
  });
});

describe("runner side-session defaults (Phase 1 stubs)", () => {
  test("ClaudeCodeRunner reports supported (Phase 2a real impl)", () => {
    const r = new ClaudeCodeRunner({
      botId: "bot1",
      config: {
        type: "claude-code",
        cli_path: "claude",
        args: [],
        env: {},
        pass_continue_flag: true,
        acknowledge_dangerous: true,
      },
      logDir: "/tmp",
    });
    expect(r.supportsSideSessions()).toBe(true);
  });

  test("CodexRunner reports supported (Phase 2b real impl)", () => {
    const r = new CodexRunner({
      botId: "bot1",
      config: {
        type: "codex",
        cli_path: "codex",
        args: [],
        env: {},
        pass_resume_flag: true,
        approval_mode: "full-auto",
        sandbox: "workspace-write",
        acknowledge_dangerous: false,
      },
      logDir: "/tmp",
    });
    expect(r.supportsSideSessions()).toBe(true);
    // sendSideTurn for an unknown session must NOT throw — that's a hot
    // path on the pool's busy/not_ready signaling axis.
    expect(r.sendSideTurn("sid", "tid", "hi", [])).toEqual({
      accepted: false,
      reason: "not_ready",
    });
  });

  test("CommandRunner (jsonl-text) reports unsupported and throws", () => {
    const r = new CommandRunner({
      botId: "bot1",
      config: {
        type: "command",
        cmd: ["echo"],
        protocol: "jsonl-text",
        env: {},
        on_reset: "signal",
      },
      logDir: "/tmp",
    });
    expect(r.supportsSideSessions()).toBe(false);
    expect(() => r.sendSideTurn("sid", "tid", "hi", [])).toThrow(
      RunnerDoesNotSupportSideSessions,
    );
  });

  test("CommandRunner (claude-ndjson) reports supported (Phase 2c)", () => {
    const r = new CommandRunner({
      botId: "bot1",
      config: {
        type: "command",
        cmd: ["echo"],
        protocol: "claude-ndjson",
        env: {},
        on_reset: "signal",
      },
      logDir: "/tmp",
    });
    expect(r.supportsSideSessions()).toBe(true);
    // Unknown session returns not_ready, not throws — hot path on the
    // pool's busy/not_ready signaling axis (same contract as Codex).
    expect(r.sendSideTurn("sid", "tid", "hi", [])).toEqual({
      accepted: false,
      reason: "not_ready",
    });
  });

  test("CommandRunner (codex-jsonl) reports supported (Phase 2c)", () => {
    const r = new CommandRunner({
      botId: "bot1",
      config: {
        type: "command",
        cmd: ["echo"],
        protocol: "codex-jsonl",
        env: {},
        on_reset: "signal",
      },
      logDir: "/tmp",
    });
    expect(r.supportsSideSessions()).toBe(true);
    expect(r.sendSideTurn("sid", "tid", "hi", [])).toEqual({
      accepted: false,
      reason: "not_ready",
    });
  });
});

describe("runnerSupportsSideSessions — static mapping", () => {
  test("claude-code + codex → true; command depends on protocol", () => {
    expect(runnerSupportsSideSessions({ type: "claude-code" })).toBe(true);
    expect(runnerSupportsSideSessions({ type: "codex" })).toBe(true);
    expect(
      runnerSupportsSideSessions({
        type: "command",
        protocol: "claude-ndjson",
      }),
    ).toBe(true);
    expect(
      runnerSupportsSideSessions({ type: "command", protocol: "codex-jsonl" }),
    ).toBe(true);
    expect(
      runnerSupportsSideSessions({ type: "command", protocol: "jsonl-text" }),
    ).toBe(false);
    // Missing protocol on command → conservative false (shouldn't happen via
    // zod but defence in depth).
    expect(runnerSupportsSideSessions({ type: "command" })).toBe(false);
  });
  test("unknown runner types default to false (safe-by-default)", () => {
    expect(runnerSupportsSideSessions({ type: "made-up" })).toBe(false);
    expect(runnerSupportsSideSessions({ type: "" })).toBe(false);
  });
  test("static mapping agrees with each runner's supportsSideSessions() runtime value", () => {
    // Guard against drift between doctor C011's check and the runtime
    // impl. If any runner ever changes its answer, the runtime and static
    // answers will diverge here.
    const claude = new ClaudeCodeRunner({
      botId: "bot1",
      config: {
        type: "claude-code",
        cli_path: "claude",
        args: [],
        env: {},
        pass_continue_flag: true,
        acknowledge_dangerous: true,
      },
      logDir: "/tmp",
    });
    expect(runnerSupportsSideSessions({ type: "claude-code" })).toBe(
      claude.supportsSideSessions(),
    );

    const codex = new CodexRunner({
      botId: "bot1",
      config: {
        type: "codex",
        cli_path: "codex",
        args: [],
        env: {},
        pass_resume_flag: true,
        approval_mode: "full-auto",
        sandbox: "workspace-write",
        acknowledge_dangerous: false,
      },
      logDir: "/tmp",
    });
    expect(runnerSupportsSideSessions({ type: "codex" })).toBe(
      codex.supportsSideSessions(),
    );

    for (const protocol of [
      "claude-ndjson",
      "codex-jsonl",
      "jsonl-text",
    ] as const) {
      const cmd = new CommandRunner({
        botId: "bot1",
        config: {
          type: "command",
          cmd: ["echo"],
          protocol,
          env: {},
          on_reset: "signal",
        },
        logDir: "/tmp",
      });
      expect(runnerSupportsSideSessions({ type: "command", protocol })).toBe(
        cmd.supportsSideSessions(),
      );
    }
  });
});
