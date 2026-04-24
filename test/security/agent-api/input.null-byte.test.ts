// §12.5.3: a null byte inside a filename is a classic C-string
// truncation attack. Since we don't use the caller-supplied filename
// at all (see input.path-traversal.test.ts — on-disk name is
// gateway-controlled), the null byte is harmless — but we pin the
// property with an explicit test.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { mkToken, startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);

describe("§12.5.3 input.null-byte", () => {
  const secret = "null-byte-secret-value-abcd1234";
  const token = mkToken("cos", secret, { scopes: ["ask"] });

  test.each([
    "benign\x00.png",
    "\x00.png",
    "prefix\x00suffix.png",
    "../etc/passwd\x00.png",
    "a".repeat(100) + "\x00",
  ])(
    "filename containing null byte %p does not corrupt on-disk name",
    async (maliciousName) => {
      h = startHarness({ tokens: [token] });
      const form = new FormData();
      form.append("text", "see attached");
      form.append(
        "file_0",
        new File([PNG_BYTES], maliciousName, { type: "image/png" }),
      );

      await fetch(`${h.base}/v1/bots/bot1/ask`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        body: form,
      });

      const attachDir = resolve(
        h.config.gateway.data_dir,
        "attachments",
        "bot1",
      );
      let entries: string[];
      try {
        entries = readdirSync(attachDir);
      } catch {
        entries = [];
      }
      for (const name of entries) {
        // No null byte survives into the filename; prefix is gateway-controlled.
        expect(name).not.toContain("\x00");
        expect(name).toMatch(/^agentapi-/);
        const st = statSync(resolve(attachDir, name));
        expect(st.isFile()).toBe(true);
      }
    },
  );
});
