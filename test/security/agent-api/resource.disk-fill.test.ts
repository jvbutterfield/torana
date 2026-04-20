// §12.5.4: when the attachments directory reaches
// `disk_usage_cap_bytes`, new uploads must return 507
// insufficient_storage WITHOUT deleting existing files. A malicious
// caller can't get free cleanup by over-uploading.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { mkToken, startHarness, type Harness } from "./_harness.js";
import { parseMultipartRequest } from "../../../src/agent-api/attachments.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

describe("§12.5.4 resource.disk-fill", () => {
  const secret = "disk-fill-secret-value-abcd1234";
  const token = mkToken("cos", secret, { scopes: ["ask"] });
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  test("when disk cap is already reached, new uploads → 507 insufficient_storage", async () => {
    h = startHarness({
      tokens: [token],
      configOverride: (c) => {
        // Tiny cap so the probe sees "over" on the first upload.
        c.attachments.disk_usage_cap_bytes = 1;
      },
    });

    const form = new FormData();
    form.append("text", "hi");
    form.append("file_0", new File([PNG_BYTES], "x.png", { type: "image/png" }));

    // Exercise the parser directly with a stub disk-usage probe that
    // reports already-full. Going through HTTP is noisier and the
    // security-relevant behaviour is at the attachments layer.
    const result = await parseMultipartRequest(
      new Request(`${h.base}/v1/bots/bot1/ask`, {
        method: "POST",
        body: form,
      }),
      h.config,
      "bot1",
      "req-123",
      { computeDiskUsage: async () => 999_999 },
    );
    expect(result.kind).toBe("err");
    if (result.kind === "err") expect(result.code).toBe("insufficient_storage");
  });

  test("existing attachments are NOT deleted when a new upload is rejected", async () => {
    h = startHarness({
      tokens: [token],
      configOverride: (c) => {
        c.attachments.disk_usage_cap_bytes = 100;
      },
    });

    // Seed a pre-existing file in the attachments dir.
    const seededPath = resolve(
      h.config.gateway.data_dir,
      "attachments",
      "bot1",
    );
    // Simulate by dropping one file via a first (allowed) upload.
    const form1 = new FormData();
    form1.append("text", "seed");
    form1.append("file_0", new File([PNG_BYTES], "seed.png", { type: "image/png" }));
    const r1 = await parseMultipartRequest(
      new Request(`${h.base}/v1/bots/bot1/ask`, {
        method: "POST",
        body: form1,
      }),
      h.config,
      "bot1",
      "seed-req",
    );
    expect(r1.kind).toBe("ok");

    const beforeFiles = readdirSync(seededPath).sort();
    expect(beforeFiles.length).toBeGreaterThan(0);

    // Second upload with disk probe over-reporting → rejected.
    const form2 = new FormData();
    form2.append("text", "second");
    form2.append("file_0", new File([PNG_BYTES], "b.png", { type: "image/png" }));
    const r2 = await parseMultipartRequest(
      new Request(`${h.base}/v1/bots/bot1/ask`, {
        method: "POST",
        body: form2,
      }),
      h.config,
      "bot1",
      "second-req",
      { computeDiskUsage: async () => 999_999 },
    );
    expect(r2.kind).toBe("err");
    if (r2.kind === "err") expect(r2.code).toBe("insufficient_storage");

    // Existing files are untouched.
    const afterFiles = readdirSync(seededPath).sort();
    expect(afterFiles).toEqual(beforeFiles);
  });

  test("507 is returned promptly — disk probe is the last-ish gate, before any file write", async () => {
    h = startHarness({ tokens: [token] });

    const form = new FormData();
    form.append("text", "prompt");
    form.append("file_0", new File([PNG_BYTES], "p.png", { type: "image/png" }));

    let probeCalled = 0;
    let writeObserved = false;
    const result = await parseMultipartRequest(
      new Request(`${h.base}/v1/bots/bot1/ask`, {
        method: "POST",
        body: form,
      }),
      h.config,
      "bot1",
      "prompt-req",
      {
        computeDiskUsage: async () => {
          probeCalled += 1;
          return h.config.attachments.disk_usage_cap_bytes * 2;
        },
      },
    );

    expect(result.kind).toBe("err");
    if (result.kind === "err") expect(result.code).toBe("insufficient_storage");
    expect(probeCalled).toBe(1);
    // Files directory should be empty — nothing was written.
    try {
      const files = readdirSync(
        resolve(h.config.gateway.data_dir, "attachments", "bot1"),
      );
      writeObserved = files.length > 0;
    } catch {
      writeObserved = false;
    }
    expect(writeObserved).toBe(false);
  });
});
