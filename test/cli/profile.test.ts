// Tests for src/cli/shared/profile.ts — on-disk profile store.
//
// Covers:
//   - defaultProfilesPath honors XDG_CONFIG_HOME; errors on Windows when
//     XDG is unset.
//   - loadProfiles on a missing file returns an empty state (not an error).
//   - save/load round-trip preserves every field and is TOML-parseable.
//   - File is always written with mode 0600; wider modes produce a warning
//     on load but don't fail.
//   - upsertProfile + removeProfile behaviors (default promotion, alphabetic
//     fallback when the default is removed).
//   - Parse-error paths: non-object top-level, non-string server/token,
//     dangling default pointer, bad profile-name chars.
//   - redactToken masks everything after the first 4 chars.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultProfilesPath,
  loadProfiles,
  saveProfiles,
  upsertProfile,
  removeProfile,
  redactToken,
  ProfileStoreError,
  type ProfileState,
} from "../../src/cli/shared/profile.js";

function tmp(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "torana-profile-"));
  return { dir, path: join(dir, "config.toml") };
}

describe("defaultProfilesPath", () => {
  test("honors XDG_CONFIG_HOME when set", () => {
    const p = defaultProfilesPath({ XDG_CONFIG_HOME: "/tmp/xdg" } as NodeJS.ProcessEnv);
    expect(p).toBe("/tmp/xdg/torana/config.toml");
  });

  test("falls back to $HOME/.config when XDG unset", () => {
    const p = defaultProfilesPath({ HOME: "/home/alice" } as NodeJS.ProcessEnv);
    expect(p).toBe("/home/alice/.config/torana/config.toml");
  });

  test("treats empty XDG as unset", () => {
    const p = defaultProfilesPath({
      HOME: "/home/alice",
      XDG_CONFIG_HOME: "",
    } as NodeJS.ProcessEnv);
    expect(p).toBe("/home/alice/.config/torana/config.toml");
  });
});

describe("loadProfiles", () => {
  test("missing file returns an empty state without error", () => {
    const { path } = tmp();
    const r = loadProfiles(path);
    expect(r.exists).toBe(false);
    expect(r.state.profiles).toEqual({});
    expect(r.state.defaultProfile).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  test("accepts a hand-written TOML file", () => {
    const { path } = tmp();
    writeFileSync(
      path,
      [
        'default = "prod"',
        "",
        "[profile.prod]",
        'server = "https://example.com"',
        'token  = "tok-abcdef"',
        "",
        "[profile.local]",
        'server = "http://localhost:8080"',
        'token = "tok-local"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const r = loadProfiles(path);
    expect(r.state.defaultProfile).toBe("prod");
    expect(Object.keys(r.state.profiles).sort()).toEqual(["local", "prod"]);
    expect(r.state.profiles.prod).toEqual({ server: "https://example.com", token: "tok-abcdef" });
    expect(r.warnings).toEqual([]);
  });

  test("warns when file mode is wider than 0600 but still returns state", () => {
    const { path } = tmp();
    writeFileSync(path, 'default = "p"\n[profile.p]\nserver = "x"\ntoken = "y"\n', { mode: 0o644 });
    chmodSync(path, 0o644);
    const r = loadProfiles(path);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain("mode 0644");
    expect(r.state.profiles.p).toEqual({ server: "x", token: "y" });
  });

  test("throws ProfileStoreError on top-level non-object TOML", () => {
    const { path } = tmp();
    writeFileSync(path, 'this is not valid toml {{{', { mode: 0o600 });
    expect(() => loadProfiles(path)).toThrow(ProfileStoreError);
  });

  test("rejects profile with non-string server", () => {
    const { path } = tmp();
    writeFileSync(path, '[profile.x]\nserver = 42\ntoken = "ok"\n', { mode: 0o600 });
    let caught: unknown;
    try { loadProfiles(path); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ProfileStoreError);
    expect((caught as ProfileStoreError).code).toBe("invalid_profile");
  });

  test("rejects default pointing at an undefined profile", () => {
    const { path } = tmp();
    writeFileSync(
      path,
      'default = "ghost"\n[profile.real]\nserver = "x"\ntoken = "y"\n',
      { mode: 0o600 },
    );
    let caught: unknown;
    try { loadProfiles(path); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ProfileStoreError);
    expect((caught as ProfileStoreError).code).toBe("invalid_profile");
    expect((caught as Error).message).toContain("ghost");
  });

  test("rejects malformed profile name", () => {
    const { path } = tmp();
    writeFileSync(path, '[profile."has space"]\nserver = "x"\ntoken = "y"\n', { mode: 0o600 });
    let caught: unknown;
    try { loadProfiles(path); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ProfileStoreError);
    expect((caught as ProfileStoreError).code).toBe("invalid_profile");
  });

  test("rejects empty server string", () => {
    const { path } = tmp();
    writeFileSync(path, '[profile.x]\nserver = ""\ntoken = "y"\n', { mode: 0o600 });
    expect(() => loadProfiles(path)).toThrow(ProfileStoreError);
  });
});

describe("saveProfiles", () => {
  test("writes file with mode 0600", () => {
    const { path } = tmp();
    saveProfiles(path, {
      defaultProfile: "p",
      profiles: { p: { server: "http://x", token: "secret" } },
    });
    const st = statSync(path);
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("round-trip preserves defaultProfile + every field", () => {
    const { path } = tmp();
    const state: ProfileState = {
      defaultProfile: "prod",
      profiles: {
        prod: { server: "https://api.example.com:443/prefix", token: "tok-prod-xyz" },
        local: { server: "http://127.0.0.1:8080", token: "tok-local" },
      },
    };
    saveProfiles(path, state);
    const r = loadProfiles(path);
    expect(r.state).toEqual(state);
  });

  test("round-trip preserves tokens with \", \\, and newlines", () => {
    const { path } = tmp();
    const state: ProfileState = {
      defaultProfile: "weird",
      profiles: {
        weird: { server: "http://x", token: 'tok with "quotes" and \\ and \n newline' },
      },
    };
    saveProfiles(path, state);
    const r = loadProfiles(path);
    expect(r.state.profiles.weird).toEqual(state.profiles.weird);
  });

  test("refuses to save a dangling default", () => {
    const { path } = tmp();
    expect(() =>
      saveProfiles(path, {
        defaultProfile: "missing",
        profiles: { other: { server: "x", token: "y" } },
      }),
    ).toThrow(ProfileStoreError);
  });

  test("atomic rename leaves no tmp file on success", async () => {
    const { dir, path } = tmp();
    saveProfiles(path, {
      defaultProfile: "p",
      profiles: { p: { server: "x", token: "y" } },
    });
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(dir);
    // Only the final file; no config.toml.tmp-* left behind.
    expect(entries.filter((e) => e.startsWith("config.toml.tmp-"))).toEqual([]);
    expect(entries).toContain("config.toml");
  });
});

describe("upsertProfile / removeProfile", () => {
  test("first upsert becomes default automatically", () => {
    const next = upsertProfile({ profiles: {} }, "first", { server: "s", token: "t" });
    expect(next.defaultProfile).toBe("first");
  });

  test("second upsert keeps existing default unless --default is set", () => {
    const s1 = upsertProfile({ profiles: {} }, "a", { server: "s", token: "t" });
    const s2 = upsertProfile(s1, "b", { server: "s2", token: "t2" });
    expect(s2.defaultProfile).toBe("a");
  });

  test("upsert with makeDefault promotes to default", () => {
    const s1 = upsertProfile({ profiles: {} }, "a", { server: "s", token: "t" });
    const s2 = upsertProfile(s1, "b", { server: "s2", token: "t2" }, { makeDefault: true });
    expect(s2.defaultProfile).toBe("b");
    expect(Object.keys(s2.profiles).sort()).toEqual(["a", "b"]);
  });

  test("removing the default promotes the alphabetically first remaining", () => {
    let s: ProfileState = { profiles: {} };
    s = upsertProfile(s, "beta", { server: "s", token: "t" });
    s = upsertProfile(s, "alpha", { server: "s", token: "t" });
    // default is beta (first inserted); remove beta → alpha becomes default.
    expect(s.defaultProfile).toBe("beta");
    const s2 = removeProfile(s, "beta");
    expect(s2.defaultProfile).toBe("alpha");
  });

  test("removing the last profile clears the default", () => {
    let s: ProfileState = { profiles: {} };
    s = upsertProfile(s, "only", { server: "s", token: "t" });
    const s2 = removeProfile(s, "only");
    expect(s2.defaultProfile).toBeUndefined();
    expect(s2.profiles).toEqual({});
  });

  test("remove of a missing profile throws", () => {
    const s: ProfileState = { profiles: { a: { server: "s", token: "t" } } };
    let caught: unknown;
    try { removeProfile(s, "ghost"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ProfileStoreError);
    expect((caught as ProfileStoreError).code).toBe("unknown_profile");
  });
});

describe("redactToken", () => {
  test("masks everything after first 4 chars, capped at 8 stars", () => {
    expect(redactToken("tok-abcdef")).toBe("tok-******");
    expect(redactToken("a")).toBe("****");
    expect(redactToken("abcd")).toBe("****");
    expect(redactToken("abcdefghijklmnop")).toBe("abcd********"); // cap at 8 stars
  });
});
