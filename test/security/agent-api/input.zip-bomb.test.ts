// §12.5.3: a .zip file uploaded with application/pdf content-type or
// vice versa → rejected because zip/archive MIMEs are not in the
// allowlist. The attachments parser trusts the declared MIME against
// a fixed allowlist (image/jpeg, image/png, image/webp, image/gif,
// application/pdf); anything else → 415 attachment_mime_not_allowed.
//
// This protects the downstream runner from having to deal with
// archive formats or their decompression hazards.

import { afterEach, describe, expect, test } from "bun:test";

import { mkToken, startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.3 input.zip-bomb", () => {
  const secret = "zip-bomb-secret-value-abcd1234";
  const token = mkToken("cos", secret, { scopes: ["ask"] });

  const disallowedMimes = [
    "application/zip",
    "application/x-zip-compressed",
    "application/x-7z-compressed",
    "application/x-tar",
    "application/x-gzip",
    "application/x-bzip2",
    "application/x-rar-compressed",
    "application/octet-stream",
    "application/x-msdownload",
    "text/html",
    "text/javascript",
    "image/svg+xml",
  ];

  test.each(disallowedMimes)(
    "declared mime %p → 415 attachment_mime_not_allowed",
    async (mime) => {
      h = startHarness({ tokens: [token] });
      const form = new FormData();
      form.append("text", "see attached");
      form.append(
        "file_0",
        new File([new Uint8Array(1024)], "payload.bin", { type: mime }),
      );
      const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        body: form,
      });
      expect(r.status).toBe(415);
      expect((await r.json()).error).toBe("attachment_mime_not_allowed");
    },
  );

  test("filename extension is not consulted; declared MIME is the gate", async () => {
    // Upload bytes with PDF-looking content but a filename claiming
    // .zip. If the gateway were using the filename extension to route,
    // this would sneak past. Because the gate is the declared MIME
    // (application/zip here), the request is rejected.
    h = startHarness({ tokens: [token] });
    const form = new FormData();
    form.append("text", "see attached");
    form.append(
      "file_0",
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "trojan.zip", {
        type: "application/zip",
      }),
    );
    const r = await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: form,
    });
    expect(r.status).toBe(415);
    expect((await r.json()).error).toBe("attachment_mime_not_allowed");
  });
});
