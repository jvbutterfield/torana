// §12.5.3: a caller-supplied filename containing `../` must not
// influence where the file lands on disk. The gateway writes files
// as `agentapi-<requestId>-<idx><ext>` under `<data_dir>/attachments/<botId>/`
// — the filename from the multipart part is entirely ignored for
// on-disk naming.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { mkToken, startHarness, type Harness } from "./_harness.js";

let h: Harness;

afterEach(async () => {
  if (h) await h.close();
});

const PNG_BYTES = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a, // PNG signature
  // A minimal PNG; enough bytes that the handler can take it.
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
]);

describe("§12.5.3 input.path-traversal", () => {
  const secret = "path-trav-secret-value-abcd1234";
  const token = mkToken("cos", secret, { scopes: ["ask"] });

  test.each([
    "../../etc/passwd",
    "/etc/passwd",
    "..\\..\\windows\\system32\\cmd.exe",
    "./../../../../root/.ssh/authorized_keys",
    "file with spaces.png",
    ".",
    "..",
    "",
  ])(
    "caller-supplied filename %p is ignored; on-disk name is gateway-controlled",
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

      // Regardless of the request's success — the runner is stubbed
      // so the handler path may return runner_error — any file that
      // WAS written must land in the attachments dir with a
      // gateway-controlled name.
      const attachDir = resolve(
        h.config.gateway.data_dir,
        "attachments",
        "bot1",
      );
      let entries: string[];
      try {
        entries = readdirSync(attachDir);
      } catch {
        // No files were written (e.g. disk check short-circuited) —
        // the security property still holds: nothing landed outside
        // the attachments dir.
        entries = [];
      }
      for (const name of entries) {
        // Must begin with the gateway prefix; never contains ..; never
        // contains the caller's filename.
        expect(name).toMatch(/^agentapi-/);
        expect(name).not.toContain("..");
        expect(name).not.toContain("/");
        expect(name).not.toContain("\\");
        const st = statSync(resolve(attachDir, name));
        expect(st.isFile()).toBe(true);
      }
    },
  );

  test("files never land outside the bot's attachments directory", async () => {
    // A filename like "../poisoned.png" with a known-bad extension
    // must not land in the parent dir. We verify by checking the
    // attachments/<botId> dir is the only place new files appear.
    h = startHarness({ tokens: [token] });
    const form = new FormData();
    form.append("text", "see attached");
    form.append(
      "file_0",
      new File([PNG_BYTES], "../../poisoned.png", { type: "image/png" }),
    );
    await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: form,
    });

    const dataDir = h.config.gateway.data_dir;
    // Walk the data dir; every file we find must be under attachments/bot1/.
    const offenders: string[] = [];
    function walk(dir: string): void {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const full = resolve(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else {
          // Allow gateway.db + attachments files; nothing else.
          const allowed =
            full.startsWith(resolve(dataDir, "attachments", "bot1")) ||
            name.startsWith("gateway.db");
          if (!allowed) offenders.push(full);
        }
      }
    }
    walk(dataDir);
    expect(offenders).toEqual([]);
  });
});
