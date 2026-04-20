// §12.5.1: agent-API token secrets must never appear in captured log
// output. The logger's redactor (src/log.ts) is configured once at
// startup via setSecrets() with every known secret; every emit goes
// through the central redactor and replaces secret substrings with
// "<redacted>". This test pins that invariant.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  logger,
  resetLoggerState,
  setLogFormat,
  setLogLevel,
  setSecrets,
} from "../../../src/log.js";

type Captured = { lines: string[]; restore: () => void };

function captureStdoutStderr(): Captured {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalErr = console.error;
  console.log = (arg: unknown) => {
    lines.push(typeof arg === "string" ? arg : String(arg));
  };
  console.error = (arg: unknown) => {
    lines.push(typeof arg === "string" ? arg : String(arg));
  };
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.error = originalErr;
    },
  };
}

const SECRET = "LEAKABLE-TOKEN-SHHH-xyz789-long-enough";

let cap: Captured;

beforeEach(() => {
  // Reset shared logger state that some earlier test may have mutated
  // (e.g. test/log.test.ts flips the level to "warn" in one case and
  // relies on afterEach to reset — this test bears belt + braces).
  resetLoggerState();
  setLogFormat("json");
  setLogLevel("info");
  cap = captureStdoutStderr();
  setSecrets([SECRET]);
});

afterEach(() => {
  cap.restore();
  resetLoggerState();
});

describe("§12.5.1 auth.log-redaction", () => {
  test("plain message containing the secret is redacted", () => {
    const log = logger("security-test");
    log.info(`user provided token: ${SECRET}`);

    const joined = cap.lines.join("\n");
    expect(joined).not.toContain(SECRET);
    expect(joined).toContain("<redacted>");
  });

  test("field value containing the secret is redacted", () => {
    const log = logger("security-test");
    log.warn("auth failed", { presented_token: SECRET });

    const joined = cap.lines.join("\n");
    expect(joined).not.toContain(SECRET);
  });

  test("nested object with secret is redacted deeply", () => {
    const log = logger("security-test");
    log.error("handler threw", {
      request: { headers: { authorization: `Bearer ${SECRET}` } },
    });

    const joined = cap.lines.join("\n");
    expect(joined).not.toContain(SECRET);
  });

  test("a completely different string is NOT redacted (no over-masking)", () => {
    const log = logger("security-test");
    log.info("benign message", { field: "hello-world" });

    const joined = cap.lines.join("\n");
    expect(joined).toContain("hello-world");
    expect(joined).toContain("benign message");
  });
});
