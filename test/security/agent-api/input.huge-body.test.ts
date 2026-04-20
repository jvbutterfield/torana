// §12.5.3: a POST body larger than `max_body_bytes` must be rejected
// BEFORE any processing (no buffering the whole 200 MiB into memory).
// parseMultipartRequest checks content-length up-front; we also guard
// against the case where content-length is missing by re-checking
// aggregate size after parsing.

import { afterEach, describe, expect, test } from "bun:test";

import { mkToken, startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.3 input.huge-body", () => {
  const secret = "huge-body-secret-value-abc12345";
  const token = mkToken("cos", secret, { scopes: ["ask"] });

  test("Content-Length above cap → 413 body_too_large before body is read", async () => {
    // Lower the cap to something we can exercise cheaply without actually
    // allocating 200 MiB. Same code path, different number.
    h = startHarness({
      tokens: [token],
      configOverride: (c) => {
        c.agent_api.ask.max_body_bytes = 4096;
      },
    });

    const form = new FormData();
    // 10 KiB of payload; exceeds the 4 KiB cap.
    form.append("text", "x".repeat(10 * 1024));
    const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: form,
    });
    expect(r.status).toBe(413);
    expect((await r.json()).error).toBe("body_too_large");
  });

  test("huge file attachment → 413 body_too_large (aggregate cap)", async () => {
    h = startHarness({
      tokens: [token],
      configOverride: (c) => {
        c.agent_api.ask.max_body_bytes = 2048;
        c.attachments.max_bytes = 2048;
      },
    });

    const form = new FormData();
    form.append("text", "see attached");
    form.append(
      "file_0",
      new File([new Uint8Array(8192)], "big.png", { type: "image/png" }),
    );
    const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: form,
    });
    expect(r.status).toBe(413);
    const body = await r.json();
    expect(["body_too_large", "attachment_too_large"]).toContain(body.error);
  });

  test("under-cap body → not rejected on size (sanity — cap actually gates size)", async () => {
    h = startHarness({
      tokens: [token],
      configOverride: (c) => {
        c.agent_api.ask.max_body_bytes = 100 * 1024;
      },
    });

    const form = new FormData();
    form.append("text", "x".repeat(100));
    const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: form,
    });
    // Under-cap body should not hit body_too_large. It may reach the
    // runner (which is stubbed and returns runner_error), or fall
    // through to other paths — what we assert is NOT 413.
    expect(r.status).not.toBe(413);
  });
});
