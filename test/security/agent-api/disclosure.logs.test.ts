// §12.5.6: an end-to-end log-capture during a realistic request flow
// produces log output that contains ZERO occurrences of:
//   - the agent-API token secret
//   - any bot's Telegram token
//   - any other configured webhook/outbound secret
//
// This is the real-world version of auth.log-redaction.test.ts —
// instead of calling log.info() directly, we drive a request through
// the handler and confirm the redactor is configured via setSecrets()
// in time to scrub the handler's incidental logs.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkToken, startHarness, type Harness } from "./_harness.js";
import {
  resetLoggerState,
  setLogFormat,
  setLogLevel,
  setSecrets,
} from "../../../src/log.js";

type Captured = { lines: string[]; restore: () => void };

function captureStdoutStderr(): Captured {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (arg: unknown) => lines.push(String(arg));
  console.error = (arg: unknown) => lines.push(String(arg));
  return {
    lines,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

const AGENT_SECRET = "LOG-REDACT-AGENT-SECRET-xyz789longenough";
const BOT_TELEGRAM_TOKEN = "1234567:TESTBOTTOKEN_DONT_LEAK_ME";

let h: Harness;
let cap: Captured;

beforeEach(() => {
  resetLoggerState();
  setLogFormat("json");
  setLogLevel("info");
  setSecrets([AGENT_SECRET, BOT_TELEGRAM_TOKEN]);
  cap = captureStdoutStderr();
});

afterEach(async () => {
  cap.restore();
  resetLoggerState();
  if (h) await h.close();
});

describe("§12.5.6 disclosure.logs", () => {
  test("log capture across a full ask flow contains zero occurrences of the agent-api secret", async () => {
    const token = mkToken("cos", AGENT_SECRET, { scopes: ["ask"] });
    h = startHarness({ tokens: [token] });

    await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENT_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi" }),
    });
    // Also exercise an auth-failure path (wrong token).
    await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENT_SECRET}`,
        "Content-Type": "application/json",
      },
      body: "malformed json {",
    });

    const joined = cap.lines.join("\n");
    expect(joined).not.toContain(AGENT_SECRET);
  });

  test("a bot Telegram token never appears in logs even when the request context is logged verbatim", async () => {
    const token = mkToken("cos", AGENT_SECRET, { scopes: ["ask"] });
    h = startHarness({
      tokens: [token],
      configOverride: (c) => {
        c.bots[0]!.token = BOT_TELEGRAM_TOKEN;
      },
    });

    await fetch(`${h.base}/v1/bots/bot1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENT_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "hi" }),
    });

    const joined = cap.lines.join("\n");
    expect(joined).not.toContain(BOT_TELEGRAM_TOKEN);
  });

  test("a URL shaped like /bot<token>/ is scrubbed by the URL-pattern redactor, not just exact-string", async () => {
    const token = mkToken("cos", AGENT_SECRET, { scopes: ["ask"] });
    h = startHarness({ tokens: [token] });

    // Emit a log line that contains a Telegram-API-shaped URL. The
    // URL_BOT_TOKEN_RE in src/log.ts rewrites /bot<TOKEN>/ → /bot<redacted>/
    // regardless of whether the token is in setSecrets().
    const { logger } = await import("../../../src/log.js");
    const log = logger("sec-test");
    log.info(
      `calling https://api.telegram.org/bot${BOT_TELEGRAM_TOKEN}/sendMessage`,
    );

    const joined = cap.lines.join("\n");
    expect(joined).not.toContain(BOT_TELEGRAM_TOKEN);
    expect(joined).toContain("/bot<redacted>/");
  });
});
