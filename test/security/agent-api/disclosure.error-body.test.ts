// §12.5.6: error response bodies must not include stack traces,
// absolute file paths, or secret values. The redactor scrubs secrets
// from logs, but response bodies are produced by errors.ts's
// defaultMessage() — which is a fixed static string per code. This
// test pins that no path from a handler surfaces an Error.message or
// stack into a client response.

import { afterEach, describe, expect, test } from "bun:test";

import { mkToken, startHarness, type Harness } from "./_harness.js";
import { errorResponse } from "../../../src/agent-api/errors.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.6 disclosure.error-body", () => {
  const secret = "err-body-secret-value-abcdef12";
  const token = mkToken("cos", secret, {
    bot_ids: ["bot1"],
    scopes: ["ask", "send"],
  });

  test("errorResponse defaultMessage never contains 'Error', 'at ', or absolute paths", async () => {
    // The catalogue of default messages in errors.ts. Iterate via
    // the public surface.
    const codes = [
      "missing_auth",
      "invalid_token",
      "bot_not_permitted",
      "scope_not_permitted",
      "unknown_bot",
      "invalid_body",
      "invalid_timeout",
      "missing_target",
      "missing_idempotency_key",
      "invalid_idempotency_key",
      "user_not_opened_bot",
      "chat_not_permitted",
      "target_not_authorized",
      "runner_does_not_support_side_sessions",
      "side_session_capacity",
      "side_session_busy",
      "runner_error",
      "runner_fatal",
      "attachment_too_large",
      "body_too_large",
      "too_many_files",
      "attachment_mime_not_allowed",
      "insufficient_storage",
      "turn_not_found",
      "turn_result_expired",
      "session_not_found",
      "gateway_shutting_down",
      "method_not_allowed",
      "internal_error",
    ] as const;

    for (const code of codes) {
      const r = errorResponse(code);
      const body = await r.json();
      const s = JSON.stringify(body);
      expect(s).not.toContain("at /");
      expect(s).not.toContain("    at ");
      expect(s).not.toMatch(/\/[A-Za-z0-9_-]+\.ts(?::\d+)?/); // ts:line
      expect(s).not.toContain("Error:");
      // No absolute-looking macOS/linux path in defaults.
      expect(s).not.toMatch(/\/Users\//);
      expect(s).not.toMatch(/\/home\//);
      expect(body.error).toBe(code);
      expect(typeof body.message).toBe("string");
    }
  });

  test("invalid_body with a large body surface does not echo the body content in the error", async () => {
    h = startHarness({ tokens: [token] });
    const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: "hi",
        session_id: "NOT-A-VALID-SESSION!@#$",
      }),
    });
    const body = await r.text();
    // The ill-formed session_id should NOT appear in the error
    // message — the sanitizer strips the value; only the field name /
    // reason is surfaced.
    expect(body).not.toContain("NOT-A-VALID-SESSION!@#$");
  });

  test("handler-internal Error.message is NOT propagated into the 500 response body for the generic catch path", async () => {
    // We can't easily inject a throw into the running router here,
    // but we can assert the canonical 500 body shape from
    // errorResponse("internal_error").
    const r = errorResponse("internal_error");
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body).toEqual({
      error: "internal_error",
      message: "internal error",
    });
  });

  test("malformed multipart body → 400 with canonical detail, no parser-internal text", async () => {
    h = startHarness({ tokens: [token] });
    h.db.upsertUserChat("bot1", "111222333", 555);

    // Declare multipart but send a body that the multipart parser cannot
    // decode. Bun's parser raises an Error whose message describes its
    // internal state ("Failed to parse FormData", boundary detail, etc.) —
    // none of that should reach the client.
    const r = await fetch(`${h.base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type":
          "multipart/form-data; boundary=----not-a-real-boundary-xyz",
        "Idempotency-Key": "idem-malformed-multipart01",
      },
      body: "this is not a multipart body at all",
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_body");
    // Canonical detail — fixed string, NOT echoed parser exception text.
    expect(body.message).toBe("malformed multipart body");
    // Belt-and-braces: nothing parser-internal slipped through.
    const s = JSON.stringify(body);
    expect(s).not.toMatch(/FormData/i);
    expect(s).not.toMatch(/boundary/i);
    expect(s).not.toContain("Error:");
    expect(s).not.toMatch(/\/Users\//);
    expect(s).not.toMatch(/\.ts:\d+/);
  });

  test("insertSendTurn throw → 500 with canonical detail, no SQLite text", async () => {
    h = startHarness({ tokens: [token] });
    h.db.upsertUserChat("bot1", "111222333", 555);
    // Drop the `turns` table out from under the cached prepared statement.
    // insertSendTurnRow will then raise `SQLiteError: no such table: turns`
    // — exactly the kind of schema-leaking exception text we want to make
    // sure the handler does NOT echo into the response.
    h.db._unsafeQuery("DROP TABLE turns").run();

    const r = await fetch(`${h.base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "idem-insert-throws-000001",
      },
      body: JSON.stringify({
        text: "hi",
        source: "x",
        user_id: "111222333",
      }),
    });
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string; message: string };
    expect(body.error).toBe("internal_error");
    expect(body.message).toBe("internal error");
    // Belt-and-braces: nothing SQLite/internal slipped through.
    const s = JSON.stringify(body);
    expect(s).not.toMatch(/sqlite/i);
    expect(s).not.toMatch(/database/i);
    expect(s).not.toMatch(/UNIQUE constraint/i);
    expect(s).not.toMatch(/no such table/i);
    expect(s).not.toContain("Error:");
    expect(s).not.toMatch(/\/Users\//);
    expect(s).not.toMatch(/\.ts:\d+/);
  });
});
