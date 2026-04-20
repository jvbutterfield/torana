// Tests for `torana config` subcommands (init, add-profile, list-profiles,
// remove-profile, show). Each test operates against a tmpdir-scoped
// config file so we don't touch the real ~/.config/torana/.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runConfig } from "../../src/cli/config.js";

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "torana-cfg-"));
  return join(dir, "config.toml");
}

describe("torana config init", () => {
  test("creates mode 0600 file when absent", () => {
    const p = tmpPath();
    const r = runConfig(["init", "--config-path", p]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(r.stdout[0]).toContain("created");
  });

  test("idempotent on existing file (no modification)", () => {
    const p = tmpPath();
    runConfig(["init", "--config-path", p]);
    const r2 = runConfig(["init", "--config-path", p]);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout[0]).toContain("already exists");
  });
});

describe("torana config add-profile", () => {
  test("stores a profile and makes it default when first", () => {
    const p = tmpPath();
    const r = runConfig([
      "add-profile",
      "first",
      "--server",
      "http://localhost:8080",
      "--token",
      "tok-abcdef",
      "--config-path",
      p,
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout[0]).toMatch(/stored profile 'first'/);
    expect(r.stdout[0]).toContain("(default)");
    const list = runConfig(["list-profiles", "--json", "--config-path", p]);
    const body = JSON.parse(list.stdout.join("\n")) as {
      default: string;
      profiles: Record<string, { server: string; token: string }>;
    };
    expect(body.default).toBe("first");
    expect(body.profiles.first!.server).toBe("http://localhost:8080");
    // Token is redacted in list output.
    expect(body.profiles.first!.token).toBe("tok-******");
  });

  test("second profile keeps existing default unless --default", () => {
    const p = tmpPath();
    runConfig(["add-profile", "a", "--server", "s1", "--token", "t1", "--config-path", p]);
    runConfig(["add-profile", "b", "--server", "s2", "--token", "t2", "--config-path", p]);
    const list = runConfig(["list-profiles", "--json", "--config-path", p]);
    const body = JSON.parse(list.stdout.join("\n")) as { default: string };
    expect(body.default).toBe("a");

    runConfig(["add-profile", "b", "--server", "s2", "--token", "t2", "--default", "--config-path", p]);
    const list2 = runConfig(["list-profiles", "--json", "--config-path", p]);
    const body2 = JSON.parse(list2.stdout.join("\n")) as { default: string };
    expect(body2.default).toBe("b");
  });

  test("rejects missing --server / --token", () => {
    const p = tmpPath();
    const r1 = runConfig(["add-profile", "x", "--token", "t", "--config-path", p]);
    expect(r1.exitCode).toBe(2);
    const r2 = runConfig(["add-profile", "x", "--server", "s", "--config-path", p]);
    expect(r2.exitCode).toBe(2);
  });

  test("rejects a literal env-interpolation token placeholder", () => {
    const p = tmpPath();
    const r = runConfig([
      "add-profile",
      "x",
      "--server",
      "s",
      "--token",
      "${TORANA_TOKEN}",
      "--config-path",
      p,
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.join("\n")).toContain("env interpolation");
  });

  test("rejects bad profile names", () => {
    const p = tmpPath();
    const r = runConfig([
      "add-profile",
      "has space",
      "--server",
      "s",
      "--token",
      "t",
      "--config-path",
      p,
    ]);
    expect(r.exitCode).toBe(2);
  });

  test("update of existing profile preserves other profiles", () => {
    const p = tmpPath();
    runConfig(["add-profile", "a", "--server", "s1", "--token", "t1", "--config-path", p]);
    runConfig(["add-profile", "b", "--server", "s2", "--token", "t2", "--config-path", p]);
    runConfig(["add-profile", "a", "--server", "s1-v2", "--token", "t1-v2", "--config-path", p]);
    const show = runConfig(["show", "--json", "--reveal-token", "--config-path", p]);
    const body = JSON.parse(show.stdout.join("\n")) as {
      profiles: Record<string, { server: string; token: string }>;
    };
    expect(body.profiles.a).toEqual({ server: "s1-v2", token: "t1-v2", default: true } as never);
    expect(body.profiles.b).toEqual({ server: "s2", token: "t2", default: false } as never);
  });
});

describe("torana config list-profiles", () => {
  test("empty store prints a friendly message", () => {
    const p = tmpPath();
    runConfig(["init", "--config-path", p]);
    const r = runConfig(["list-profiles", "--config-path", p]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout[0]).toContain("no profiles configured");
  });

  test("human output uses a * to mark default", () => {
    const p = tmpPath();
    runConfig(["add-profile", "a", "--server", "s1", "--token", "t1", "--config-path", p]);
    runConfig(["add-profile", "b", "--server", "s2", "--token", "t2", "--config-path", p]);
    const r = runConfig(["list-profiles", "--config-path", p]);
    const text = r.stdout.join("\n");
    expect(text).toMatch(/a \*/);
    expect(text).toContain("s1");
    expect(text).toContain("s2");
  });
});

describe("torana config remove-profile", () => {
  test("idempotent removal of missing profile (exit 0)", () => {
    const p = tmpPath();
    runConfig(["init", "--config-path", p]);
    const r = runConfig(["remove-profile", "ghost", "--config-path", p]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout[0]).toContain("nothing to remove");
  });

  test("removing the default promotes the next profile", () => {
    const p = tmpPath();
    runConfig(["add-profile", "beta", "--server", "s", "--token", "t", "--config-path", p]);
    runConfig(["add-profile", "alpha", "--server", "s", "--token", "t", "--config-path", p]);
    const r = runConfig(["remove-profile", "beta", "--config-path", p]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout[0]).toContain("new default: alpha");
  });

  test("removing the sole profile clears default", () => {
    const p = tmpPath();
    runConfig(["add-profile", "only", "--server", "s", "--token", "t", "--config-path", p]);
    const r = runConfig(["remove-profile", "only", "--config-path", p]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout[0]).toContain("no default remaining");
  });
});

describe("torana config show", () => {
  test("redacts tokens by default", () => {
    const p = tmpPath();
    runConfig(["add-profile", "a", "--server", "s1", "--token", "tok-abcdef", "--config-path", p]);
    const r = runConfig(["show", "a", "--config-path", p]);
    expect(r.exitCode).toBe(0);
    const text = r.stdout.join("\n");
    expect(text).not.toContain("tok-abcdef");
    expect(text).toContain("tok-******");
  });

  test("--reveal-token prints the raw secret", () => {
    const p = tmpPath();
    runConfig(["add-profile", "a", "--server", "s1", "--token", "tok-abcdef", "--config-path", p]);
    const r = runConfig(["show", "a", "--reveal-token", "--config-path", p]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.join("\n")).toContain("tok-abcdef");
  });

  test("show <name> errors cleanly when profile is absent", () => {
    const p = tmpPath();
    runConfig(["init", "--config-path", p]);
    const r = runConfig(["show", "ghost", "--config-path", p]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.join("\n")).toContain("ghost");
  });
});

describe("torana config dispatcher", () => {
  test("unknown subcommand prints help and exits 2", () => {
    const r = runConfig(["bogus"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.join("\n")).toContain("unknown subcommand");
  });

  test("no subcommand prints help and exits 0", () => {
    const r = runConfig([]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.join("\n")).toContain("Manage the torana CLI profile store");
  });
});
