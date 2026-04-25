import { afterEach, describe, expect, test } from "bun:test";
import {
  logger,
  resetLoggerState,
  setSecrets,
  setLogFormat,
  setLogLevel,
} from "../src/log.js";

let captured: string[] = [];
let originalLog: typeof console.log;
let originalErr: typeof console.error;

function installCapture(): void {
  captured = [];
  originalLog = console.log;
  originalErr = console.error;
  console.log = (msg: unknown) => captured.push(String(msg));
  console.error = (msg: unknown) => captured.push(String(msg));
}

function restoreCapture(): void {
  console.log = originalLog;
  console.error = originalErr;
}

afterEach(() => {
  restoreCapture();
  resetLoggerState();
});

describe("log", () => {
  test("emits JSON with standard fields", () => {
    installCapture();
    setLogFormat("json");
    setLogLevel("info");
    logger("test").info("hello", { k: 1 });
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]);
    expect(parsed.msg).toBe("hello");
    expect(parsed.level).toBe("info");
    expect(parsed.module).toBe("test");
    expect(parsed.k).toBe(1);
  });

  test("redacts known secret values", () => {
    installCapture();
    setLogFormat("json");
    setLogLevel("info");
    setSecrets(["SECRETTOKEN123"]);
    logger("test").info("inbound", { auth: "Bearer SECRETTOKEN123 trailing" });
    const parsed = JSON.parse(captured[0]);
    expect(parsed.auth).toBe("Bearer <redacted> trailing");
  });

  test("redacts /bot<TOKEN>/ URL segments regardless of known secrets", () => {
    installCapture();
    setLogFormat("json");
    setLogLevel("info");
    logger("test").info("telegram call", {
      url: "https://api.telegram.org/bot12345:ABCDEF-TOKEN/getMe",
    });
    const parsed = JSON.parse(captured[0]);
    expect(parsed.url).toBe("https://api.telegram.org/bot<redacted>/getMe");
  });

  test("level filter respects setLogLevel", () => {
    installCapture();
    setLogFormat("json");
    setLogLevel("warn");
    logger("t").debug("d");
    logger("t").info("i");
    logger("t").warn("w");
    logger("t").error("e");
    expect(captured).toHaveLength(2);
  });

  test("child logger merges bindings", () => {
    installCapture();
    setLogFormat("json");
    setLogLevel("info");
    const base = logger("t", { bot_id: "alpha" });
    base.info("hello");
    const parsed = JSON.parse(captured[0]);
    expect(parsed.bot_id).toBe("alpha");
  });
});
