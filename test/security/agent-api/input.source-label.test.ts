// §12.5.3: the `source` label on send bodies is constrained to
// `^[a-z0-9_-]{1,64}$`. This prevents a caller from baking arbitrary
// characters (slashes, dots, HTML, control chars) into a field that
// eventually shows up in turn-meta and — on some code paths — in log
// fields. The regex is strict; anything outside it must 400.

import { afterEach, describe, expect, test } from "bun:test";

import { mkToken, startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.3 input.source-label", () => {
  const secret = "source-label-secret-value-abcd12";
  const token = mkToken("cos", secret, { scopes: ["send"] });

  const bad = [
    "../bad",
    "UPPERCASE",
    "with space",
    "special!char",
    "path/trav",
    "null\x00byte",
    "<script>",
    "a".repeat(65), // too long
    "",
  ];

  test.each(bad)("source %p → 400 invalid_body", async (source) => {
    h = startHarness({ tokens: [token] });
    const r = await fetch(`${h.base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": "key-abcdefghijklmno",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi", source, user_id: "123" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_body");
  });

  const good = ["ok", "cos-brief-v1", "src_name_1", "a", "a".repeat(64)];

  test.each(good)("source %p → not 400 on source validation", async (source) => {
    h = startHarness({ tokens: [token] });
    const r = await fetch(`${h.base}/v1/bots/bot1/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": "key-abcdefghijklmno",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi", source, user_id: "123" }),
    });
    // Source label passes validation. Other send prerequisites (like
    // user_not_opened_bot) may still fail — assert only that we don't
    // get invalid_body. 409 (user_not_opened_bot) is the expected next
    // gate.
    if (r.status === 400) {
      const body = await r.json();
      expect(body.error).not.toBe("invalid_body");
    }
  });
});
