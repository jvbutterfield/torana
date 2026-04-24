// Tests for resolveCredentials precedence rules (Phase 6b):
//   flag > env > named profile > default profile > error
//
// Each rule is exercised with all other sources present AND with only that
// source present, so passing the whole suite implies the precedence chain
// is correct end-to-end rather than just in the happy-path.

import { describe, expect, test } from "bun:test";

import {
  CliUsageError,
  resolveCredentials,
  traceLines,
} from "../../src/cli/shared/args.js";
import type { ProfileState } from "../../src/cli/shared/profile.js";

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

const STORE: ProfileState = {
  defaultProfile: "alpha",
  profiles: {
    alpha: { server: "http://alpha-default", token: "tok-alpha" },
    beta: { server: "http://beta-named", token: "tok-beta" },
  },
};

describe("resolveCredentials precedence", () => {
  test("flag beats env + profile for both server and token", () => {
    const r = resolveCredentials({
      flagServer: "http://from-flag",
      flagToken: "tok-from-flag",
      env: { TORANA_SERVER: "http://from-env", TORANA_TOKEN: "tok-from-env" },
      profileName: "beta",
      profiles: STORE,
    });
    expect(r.server).toBe("http://from-flag");
    expect(r.token).toBe("tok-from-flag");
    expect(r.trace).toEqual(["server:flag", "token:flag"]);
    expect(r.profile).toBe("beta");
  });

  test("env beats profile when flag is absent", () => {
    const r = resolveCredentials({
      env: { TORANA_SERVER: "http://from-env", TORANA_TOKEN: "tok-from-env" },
      profileName: "beta",
      profiles: STORE,
    });
    expect(r.server).toBe("http://from-env");
    expect(r.token).toBe("tok-from-env");
    expect(r.trace).toEqual(["server:env", "token:env"]);
  });

  test("named profile beats default profile when flag+env are absent", () => {
    const r = resolveCredentials({
      profileName: "beta",
      profiles: STORE,
      env: EMPTY_ENV,
    });
    expect(r.server).toBe("http://beta-named");
    expect(r.token).toBe("tok-beta");
    expect(r.trace).toEqual(["server:profile:beta", "token:profile:beta"]);
    expect(r.profile).toBe("beta");
  });

  test("default profile is used when --profile is omitted", () => {
    const r = resolveCredentials({ profiles: STORE, env: EMPTY_ENV });
    expect(r.server).toBe("http://alpha-default");
    expect(r.token).toBe("tok-alpha");
    expect(r.profile).toBe("alpha");
  });

  test("server and token can come from different layers", () => {
    const r = resolveCredentials({
      flagServer: "http://from-flag",
      env: { TORANA_TOKEN: "tok-from-env" },
      profileName: "beta",
      profiles: STORE,
    });
    expect(r.server).toBe("http://from-flag");
    expect(r.token).toBe("tok-from-env");
    expect(r.trace).toEqual(["server:flag", "token:env"]);
  });

  test("profile picked despite presence of partial overrides", () => {
    const r = resolveCredentials({
      flagToken: "tok-from-flag",
      profileName: "beta",
      profiles: STORE,
      env: EMPTY_ENV,
    });
    expect(r.server).toBe("http://beta-named");
    expect(r.token).toBe("tok-from-flag");
    expect(r.trace).toEqual(["server:profile:beta", "token:flag"]);
  });

  test("error when no layer supplies server", () => {
    let caught: unknown;
    try {
      resolveCredentials({ flagToken: "tok", env: EMPTY_ENV });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliUsageError);
    expect((caught as Error).message).toContain("--server");
  });

  test("error when no layer supplies token", () => {
    let caught: unknown;
    try {
      resolveCredentials({ flagServer: "http://x", env: EMPTY_ENV });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliUsageError);
    expect((caught as Error).message).toContain("--token");
  });

  test("error when --profile references an unknown name", () => {
    let caught: unknown;
    try {
      resolveCredentials({
        profileName: "ghost",
        profiles: STORE,
        env: EMPTY_ENV,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliUsageError);
    expect((caught as Error).message).toMatch(/profile 'ghost' not found/);
    expect((caught as Error).message).toContain("alpha");
  });

  test("error when --profile passed without a profile store", () => {
    let caught: unknown;
    try {
      resolveCredentials({ profileName: "alpha", env: EMPTY_ENV });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliUsageError);
    expect((caught as Error).message).toMatch(/no profile store is available/);
  });

  test("empty store + no flag/env → error (not a silent default to blank)", () => {
    let caught: unknown;
    try {
      resolveCredentials({ profiles: { profiles: {} }, env: EMPTY_ENV });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliUsageError);
  });
});

describe("traceLines", () => {
  test("empty unless verbose or TORANA_DEBUG=1", () => {
    expect(
      traceLines(["server:flag", "token:env"], { env: EMPTY_ENV }),
    ).toEqual([]);
  });

  test("emits trace line when verbose=true", () => {
    const lines = traceLines(["server:flag", "token:env"], {
      verbose: true,
      env: EMPTY_ENV,
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("server:flag");
    expect(lines[0]).toContain("token:env");
  });

  test("emits trace line when TORANA_DEBUG=1", () => {
    const lines = traceLines(["server:flag"], {
      env: { TORANA_DEBUG: "1" } as NodeJS.ProcessEnv,
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("server:flag");
  });
});
