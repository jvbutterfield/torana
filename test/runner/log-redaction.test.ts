// Runner log-file redaction — verifies that secrets configured via
// setSecrets() are scrubbed from stdout AND stderr chunks the runner
// writes to its per-bot log file.
//
// Prior to this commit the runners piped subprocess output straight into
// `entry.logStream?.write(chunk)` / `write(\`[stderr] \${text}\`)` — the
// structured-log path (logger().error/warn) redacts, but the file stream
// bypassed it. A runner that leaked an API key on stderr (or printed one
// on stdout) landed in plaintext on disk.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeCodeRunner } from "../../src/runner/claude-code.js";
import { resetLoggerState, setSecrets } from "../../src/log.js";
import type { ClaudeCodeRunnerConfig } from "../../src/config/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(__dirname, "fixtures/claude-mock.ts");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-log-redact-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  resetLoggerState();
});

function makeConfig(mode: string): ClaudeCodeRunnerConfig {
  return {
    type: "claude-code",
    cli_path: "bun",
    args: ["run", MOCK, mode],
    env: {},
    pass_continue_flag: true,
    acknowledge_dangerous: true,
  };
}

describe("runner log-file redaction", () => {
  test("stdout chunks containing a configured secret are masked on disk", async () => {
    const SECRET = "super-secret-api-key-abcdefghijklmnop";
    setSecrets([SECRET]);
    const runner = new ClaudeCodeRunner({
      botId: "alpha",
      config: makeConfig("normal"),
      logDir: tmpDir,
      protocolFlags: [],
      startupMs: 100,
    });
    await runner.start();

    // Wait for ready, send a turn whose text contains the secret. The mock
    // echoes the text back on stdout, so the log file receives it.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("timed out waiting for ready")),
        5000,
      );
      runner.on("ready", () => {
        clearTimeout(t);
        resolve();
      });
    });

    const ready = runner.sendTurn("T1", `please echo ${SECRET}`, []);
    expect(ready.accepted).toBe(true);

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("timed out waiting for done")),
        10_000,
      );
      runner.on("done", () => {
        clearTimeout(t);
        resolve();
      });
    });

    await runner.stop(1000);

    // Read the per-bot log file (runners create `<botId>.log` under logDir).
    const logFile = join(tmpDir, "alpha.log");
    const contents = readFileSync(logFile, "utf8");
    expect(contents.length).toBeGreaterThan(0);
    // The raw secret must not appear on disk.
    expect(contents).not.toContain(SECRET);
    // The redaction placeholder should be there.
    expect(contents).toContain("<redacted>");
  }, 20_000);
});
