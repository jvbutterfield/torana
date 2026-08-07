import { afterEach, describe, expect, test } from "bun:test";
import {
  addSecrets,
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

  test("addSecrets redacts late arrivals without dropping the startup set", () => {
    installCapture();
    setLogFormat("json");
    setLogLevel("info");
    setSecrets(["STARTUP_SECRET_VALUE"]);
    addSecrets(["PROVISIONED_KEY_VALUE"]);
    logger("test").info("both", {
      a: "sees STARTUP_SECRET_VALUE here",
      b: "and PROVISIONED_KEY_VALUE here",
    });
    const parsed = JSON.parse(captured[0]);
    expect(parsed.a).toBe("sees <redacted> here");
    expect(parsed.b).toBe("and <redacted> here");
  });

  test("addSecrets keeps longest-first ordering across both sets", () => {
    installCapture();
    setLogFormat("json");
    setLogLevel("info");
    // The shorter value is a prefix of the longer one. Replacing shortest-first
    // would leave the remainder of the longer secret in the output.
    setSecrets(["PREFIX"]);
    addSecrets(["PREFIX_AND_MORE"]);
    logger("test").info("m", { v: "PREFIX_AND_MORE" });
    expect(JSON.parse(captured[0]).v).toBe("<redacted>");
  });

  test("addSecrets is idempotent and ignores empty values", () => {
    installCapture();
    setLogFormat("json");
    setLogLevel("info");
    setSecrets(["KNOWN_SECRET"]);
    addSecrets(["KNOWN_SECRET", "", "KNOWN_SECRET"]);
    logger("test").info("m", { v: "KNOWN_SECRET and a b" });
    // A duplicated registration must not double-replace or corrupt the output.
    expect(JSON.parse(captured[0]).v).toBe("<redacted> and a b");
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
