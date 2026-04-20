// Tests for src/cli/shared/exit.ts — error code → exit code mapping.

import { describe, expect, test } from "bun:test";

import { ExitCode, exitCodeFor } from "../../src/cli/shared/exit.js";

describe("exitCodeFor — auth axis", () => {
  test("missing_auth → authFailed", () => {
    expect(exitCodeFor("missing_auth")).toBe(ExitCode.authFailed);
  });
  test("invalid_token → authFailed", () => {
    expect(exitCodeFor("invalid_token")).toBe(ExitCode.authFailed);
  });
  test("bot_not_permitted → authFailed", () => {
    expect(exitCodeFor("bot_not_permitted")).toBe(ExitCode.authFailed);
  });
  test("scope_not_permitted → authFailed", () => {
    expect(exitCodeFor("scope_not_permitted")).toBe(ExitCode.authFailed);
  });
  test("target_not_authorized → authFailed", () => {
    expect(exitCodeFor("target_not_authorized")).toBe(ExitCode.authFailed);
  });
});

describe("exitCodeFor — not-found axis", () => {
  test("unknown_bot → notFound", () => {
    expect(exitCodeFor("unknown_bot")).toBe(ExitCode.notFound);
  });
  test("turn_not_found → notFound", () => {
    expect(exitCodeFor("turn_not_found")).toBe(ExitCode.notFound);
  });
  test("session_not_found → notFound", () => {
    expect(exitCodeFor("session_not_found")).toBe(ExitCode.notFound);
  });
  test("turn_result_expired → notFound (410)", () => {
    expect(exitCodeFor("turn_result_expired")).toBe(ExitCode.notFound);
  });
});

describe("exitCodeFor — capacity axis", () => {
  test("side_session_capacity → capacity", () => {
    expect(exitCodeFor("side_session_capacity")).toBe(ExitCode.capacity);
  });
  test("side_session_busy → capacity", () => {
    expect(exitCodeFor("side_session_busy")).toBe(ExitCode.capacity);
  });
});

describe("exitCodeFor — bad-usage axis", () => {
  test("invalid_body → badUsage", () => {
    expect(exitCodeFor("invalid_body")).toBe(ExitCode.badUsage);
  });
  test("missing_target → badUsage", () => {
    expect(exitCodeFor("missing_target")).toBe(ExitCode.badUsage);
  });
  test("invalid_idempotency_key → badUsage", () => {
    expect(exitCodeFor("invalid_idempotency_key")).toBe(ExitCode.badUsage);
  });
  test("invalid_timeout → badUsage", () => {
    expect(exitCodeFor("invalid_timeout")).toBe(ExitCode.badUsage);
  });
  test("attachment_mime_not_allowed → badUsage", () => {
    expect(exitCodeFor("attachment_mime_not_allowed")).toBe(ExitCode.badUsage);
  });
  test("attachment_too_large → badUsage", () => {
    expect(exitCodeFor("attachment_too_large")).toBe(ExitCode.badUsage);
  });
  test("user_not_opened_bot → badUsage", () => {
    expect(exitCodeFor("user_not_opened_bot")).toBe(ExitCode.badUsage);
  });
});

describe("exitCodeFor — server axis", () => {
  test("runner_error → serverError", () => {
    expect(exitCodeFor("runner_error")).toBe(ExitCode.serverError);
  });
  test("runner_fatal → serverError", () => {
    expect(exitCodeFor("runner_fatal")).toBe(ExitCode.serverError);
  });
  test("internal_error → serverError", () => {
    expect(exitCodeFor("internal_error")).toBe(ExitCode.serverError);
  });
  test("gateway_shutting_down → serverError", () => {
    expect(exitCodeFor("gateway_shutting_down")).toBe(ExitCode.serverError);
  });
  test("network → serverError", () => {
    expect(exitCodeFor("network")).toBe(ExitCode.serverError);
  });
  test("runner_does_not_support_side_sessions → serverError", () => {
    expect(exitCodeFor("runner_does_not_support_side_sessions")).toBe(
      ExitCode.serverError,
    );
  });
});

describe("exitCodeFor — internal axis", () => {
  test("malformed_response → internal", () => {
    expect(exitCodeFor("malformed_response")).toBe(ExitCode.internal);
  });
});

describe("exitCodeFor — status fallback for unknown code", () => {
  test("401 → authFailed", () => {
    expect(exitCodeFor("X_unknown_code" as never, 401)).toBe(ExitCode.authFailed);
  });
  test("403 → authFailed", () => {
    expect(exitCodeFor("X_unknown_code" as never, 403)).toBe(ExitCode.authFailed);
  });
  test("404 → notFound", () => {
    expect(exitCodeFor("X_unknown_code" as never, 404)).toBe(ExitCode.notFound);
  });
  test("429 → capacity", () => {
    expect(exitCodeFor("X_unknown_code" as never, 429)).toBe(ExitCode.capacity);
  });
  test("500 → serverError", () => {
    expect(exitCodeFor("X_unknown_code" as never, 500)).toBe(ExitCode.serverError);
  });
  test("400 → badUsage", () => {
    expect(exitCodeFor("X_unknown_code" as never, 400)).toBe(ExitCode.badUsage);
  });
  test("no status + unknown code → internal", () => {
    expect(exitCodeFor("X_unknown_code" as never)).toBe(ExitCode.internal);
  });
});
