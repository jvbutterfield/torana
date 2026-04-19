// Phase 1 runner stub: every runner reports supportsSideSessions()=false
// and throws RunnerDoesNotSupportSideSessions from the other methods.
// Phase 2 will flip supportsSideSessions() to true for each and replace
// the throws with real implementations.

import { describe, expect, test } from "bun:test";
import { ClaudeCodeRunner } from "../../src/runner/claude-code.js";
import { CodexRunner } from "../../src/runner/codex.js";
import { CommandRunner } from "../../src/runner/command.js";
import {
  InvalidSideSessionId,
  RunnerDoesNotSupportSideSessions,
  SIDE_SESSION_ID_REGEX,
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
  test("ClaudeCodeRunner reports unsupported", () => {
    const r = new ClaudeCodeRunner({
      botId: "bot1",
      config: {
        type: "claude-code",
        cli_path: "claude",
        args: [],
        env: {},
        pass_continue_flag: true,
      },
      logDir: "/tmp",
    });
    expect(r.supportsSideSessions()).toBe(false);
    expect(() => r.sendSideTurn("sid", "tid", "hi", [])).toThrow(
      RunnerDoesNotSupportSideSessions,
    );
    expect(r.startSideSession("sid")).rejects.toBeInstanceOf(
      RunnerDoesNotSupportSideSessions,
    );
  });

  test("CodexRunner reports unsupported", () => {
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
    expect(r.supportsSideSessions()).toBe(false);
    expect(() => r.sendSideTurn("sid", "tid", "hi", [])).toThrow(
      RunnerDoesNotSupportSideSessions,
    );
  });

  test("CommandRunner reports unsupported", () => {
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
});
