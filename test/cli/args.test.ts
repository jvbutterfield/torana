// Tests for src/cli/shared/args.ts — argv parsing + credential resolution.

import { describe, expect, test } from "bun:test";

import {
  CliUsageError,
  COMMON_FLAGS,
  extractChain,
  parseCommand,
  parseFlags,
  resolveCredentials,
  type FlagSpec,
} from "../../src/cli/shared/args.js";

describe("extractChain", () => {
  test("zero chain tokens when first arg is a flag", () => {
    const r = extractChain(["--server", "http://x", "ask"]);
    expect(r.chain).toEqual([]);
    expect(r.rest).toEqual(["--server", "http://x", "ask"]);
  });

  test("single chain token (ask)", () => {
    const r = extractChain(["ask", "bot1", "hello", "--json"]);
    expect(r.chain).toEqual(["ask", "bot1"]);
    // `bot1` is in the chain because it's the second non-flag token; this
    // is fine — subcommand bodies that need positionals do their own
    // parseFlags on the rest. extractChain just lifts up to two tokens.
    expect(r.rest).toEqual(["hello", "--json"]);
  });

  test("two chain tokens (turns get)", () => {
    const r = extractChain(["turns", "get", "42"]);
    expect(r.chain).toEqual(["turns", "get"]);
    expect(r.rest).toEqual(["42"]);
  });

  test("stops at first flag", () => {
    const r = extractChain(["bots", "list", "--json"]);
    expect(r.chain).toEqual(["bots", "list"]);
    expect(r.rest).toEqual(["--json"]);
  });

  test("never grows past two tokens", () => {
    const r = extractChain(["a", "b", "c", "d"]);
    expect(r.chain).toEqual(["a", "b"]);
    expect(r.rest).toEqual(["c", "d"]);
  });
});

describe("parseFlags", () => {
  const spec: Record<string, FlagSpec> = {
    server: { kind: "value", short: "s", describe: "" },
    json: { kind: "bool", short: "j", describe: "" },
    file: { kind: "values", describe: "" },
  };

  test("bool flag toggled", () => {
    const r = parseFlags(["--json"], spec);
    expect(r.flags.json).toBe(true);
    expect(r.positional).toEqual([]);
  });

  test("value flag space-separated", () => {
    const r = parseFlags(["--server", "http://x"], spec);
    expect(r.flags.server).toBe("http://x");
  });

  test("value flag equals-separated", () => {
    const r = parseFlags(["--server=http://x"], spec);
    expect(r.flags.server).toBe("http://x");
  });

  test("short flag", () => {
    const r = parseFlags(["-s", "http://x", "-j"], spec);
    expect(r.flags.server).toBe("http://x");
    expect(r.flags.json).toBe(true);
  });

  test("repeated values flag accumulates", () => {
    const r = parseFlags(["--file", "a.png", "--file", "b.png"], spec);
    expect(r.flags.file).toEqual(["a.png", "b.png"]);
  });

  test("positional args preserved in order", () => {
    const r = parseFlags(["foo", "bar", "--json", "baz"], spec);
    expect(r.positional).toEqual(["foo", "bar", "baz"]);
    expect(r.flags.json).toBe(true);
  });

  test("`--` terminator forces remaining tokens to positional", () => {
    const r = parseFlags(["--json", "--", "--server", "http://x"], spec);
    expect(r.flags.json).toBe(true);
    expect(r.positional).toEqual(["--server", "http://x"]);
  });

  test("unknown flag throws CliUsageError", () => {
    expect(() => parseFlags(["--nope"], spec)).toThrow(CliUsageError);
  });

  test("unknown short flag throws CliUsageError", () => {
    expect(() => parseFlags(["-z"], spec)).toThrow(/unknown flag/);
  });

  test("value flag missing value throws", () => {
    expect(() => parseFlags(["--server"], spec)).toThrow(/requires a value/);
  });

  test("bool flag with =value rejected", () => {
    expect(() => parseFlags(["--json=yes"], spec)).toThrow(/does not take a value/);
  });

  test("repeated single-value flag rejected", () => {
    expect(() => parseFlags(["--server", "a", "--server", "b"], spec)).toThrow(
      /more than once/,
    );
  });

  test("standalone `-` is positional, not a flag", () => {
    const r = parseFlags(["-"], spec);
    expect(r.positional).toEqual(["-"]);
  });
});

describe("parseCommand integration", () => {
  test("turns get 42 --json", () => {
    const r = parseCommand(["turns", "get", "42", "--json"], COMMON_FLAGS);
    expect(r.chain).toEqual(["turns", "get"]);
    expect(r.positional).toEqual(["42"]);
    expect(r.flags.json).toBe(true);
  });
});

describe("resolveCredentials", () => {
  test("flags win over env", () => {
    const r = resolveCredentials({
      flagServer: "http://flag",
      flagToken: "tok-flag",
      env: { TORANA_SERVER: "http://env", TORANA_TOKEN: "tok-env" },
    });
    expect(r.server).toBe("http://flag");
    expect(r.token).toBe("tok-flag");
    expect(r.trace).toEqual(["server:flag", "token:flag"]);
  });

  test("falls back to env when flags omitted", () => {
    const r = resolveCredentials({
      env: { TORANA_SERVER: "http://env", TORANA_TOKEN: "tok-env" },
    });
    expect(r.server).toBe("http://env");
    expect(r.token).toBe("tok-env");
    expect(r.trace).toEqual(["server:env", "token:env"]);
  });

  test("missing server throws", () => {
    expect(() =>
      resolveCredentials({ flagToken: "t", env: {} }),
    ).toThrow(/--server/);
  });

  test("missing token throws", () => {
    expect(() =>
      resolveCredentials({ flagServer: "http://x", env: {} }),
    ).toThrow(/--token/);
  });

  test("trace mixes sources when one is flag and other is env", () => {
    const r = resolveCredentials({
      flagServer: "http://flag",
      env: { TORANA_TOKEN: "tok-env" },
    });
    expect(r.trace).toEqual(["server:flag", "token:env"]);
  });
});
