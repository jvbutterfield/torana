// Profile store for the torana CLI — a small TOML file that holds one or
// more `(server, token)` pairs keyed by profile name. The config subcommand
// (`torana config add-profile`, `list-profiles`, `remove-profile`, `show`,
// `init`) edits this file; `ask`, `inject`, `turns`, `bots`, and
// `doctor --profile NAME` read it via `resolveCredentials`.
//
// Path resolution:
//   - `$XDG_CONFIG_HOME/torana/config.toml` when set (non-empty)
//   - `~/.config/torana/config.toml` otherwise
//   - On Windows without `XDG_CONFIG_HOME`, we throw — `cli_platform_unsupported`.
//     Windows is not a v1 target (see impl plan §8.1).
//
// File format (single flat `[profile.NAME]` table per entry, plus an
// optional top-level `default` string):
//
//   default = "prod"
//
//   [profile.prod]
//   server = "https://torana.example.com"
//   token  = "tok-real"
//
//   [profile.local]
//   server = "http://localhost:8080"
//   token  = "dev-token"
//
// File mode is 0600; `saveProfiles` chmods on every write, `loadProfiles`
// emits a warning in its `warnings` array when the on-disk perms are wider.

import { existsSync, statSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export interface Profile {
  server: string;
  token: string;
}

export interface ProfileState {
  /** Name of the profile used when `--profile` is omitted. */
  defaultProfile?: string;
  /** Every stored profile keyed by name. */
  profiles: Record<string, Profile>;
}

export class ProfileStoreError extends Error {
  constructor(
    message: string,
    public code:
      | "platform_unsupported"
      | "not_found"
      | "parse_error"
      | "invalid_profile"
      | "unknown_profile",
  ) {
    super(message);
    this.name = "ProfileStoreError";
  }
}

/** Resolve the config file path honoring `XDG_CONFIG_HOME` and `HOME`. */
export function defaultProfilesPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return resolve(xdg, "torana", "config.toml");
  if (process.platform === "win32") {
    throw new ProfileStoreError(
      "Windows is not a supported platform for the torana CLI profile store (v1). Set XDG_CONFIG_HOME or pass --server/--token/--profile explicitly.",
      "platform_unsupported",
    );
  }
  const home = env.HOME ?? homedir();
  return resolve(home, ".config", "torana", "config.toml");
}

export interface LoadResult {
  /** `{}` with empty `profiles` when the file doesn't exist. */
  state: ProfileState;
  /** Non-fatal warnings (e.g. "mode 0644 wider than 0600; chmod 600"). */
  warnings: string[];
  /** true when the file was present on disk. */
  exists: boolean;
}

export function loadProfiles(path: string): LoadResult {
  const warnings: string[] = [];
  if (!existsSync(path)) {
    return { state: { profiles: {} }, warnings, exists: false };
  }
  const st = statSync(path);
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    warnings.push(
      `profile file ${path} has mode 0${mode.toString(8)}; consider 'chmod 600 ${path}' (the CLI will re-apply 0600 on next write)`,
    );
  }
  const text = readFileSafe(path);
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (err) {
    throw new ProfileStoreError(
      `failed to parse ${path}: ${(err as Error).message}`,
      "parse_error",
    );
  }
  const state = validate(parsed, path);
  return { state, warnings, exists: true };
}

/**
 * Atomically serialize `state` to `path` with mode 0600. Creates parent
 * directories as needed. Writes to a sibling tmp file then renames so a
 * crash mid-write can't leave a half-written TOML.
 */
export function saveProfiles(path: string, state: ProfileState): void {
  validateForSave(state);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = serialize(state);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  // Ensure even if umask stripped bits on creation.
  chmodSync(tmp, 0o600);
  // rename is atomic on POSIX; on collision it replaces the target.
  // Using fs.renameSync for sync behavior.
  const { renameSync } = require("node:fs") as typeof import("node:fs");
  renameSync(tmp, path);
  // Re-chmod after rename — on some filesystems rename preserves source
  // perms, but paranoia costs nothing here.
  chmodSync(path, 0o600);
}

function readFileSafe(path: string): string {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return readFileSync(path, "utf-8");
}

// ---- validation + serialization -------------------------------------------

function validate(parsed: unknown, path: string): ProfileState {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProfileStoreError(
      `${path}: top-level must be a TOML table`,
      "parse_error",
    );
  }
  const obj = parsed as Record<string, unknown>;
  const state: ProfileState = { profiles: {} };
  if ("default" in obj) {
    const d = obj.default;
    if (typeof d !== "string" || d.length === 0) {
      throw new ProfileStoreError(
        `${path}: 'default' must be a non-empty string`,
        "parse_error",
      );
    }
    state.defaultProfile = d;
  }
  const rawProfiles = obj.profile;
  if (rawProfiles !== undefined) {
    if (
      rawProfiles === null ||
      typeof rawProfiles !== "object" ||
      Array.isArray(rawProfiles)
    ) {
      throw new ProfileStoreError(
        `${path}: 'profile' must be a table`,
        "parse_error",
      );
    }
    for (const [name, entry] of Object.entries(
      rawProfiles as Record<string, unknown>,
    )) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
        throw new ProfileStoreError(
          `${path}: profile name '${name}' must match [A-Za-z0-9_.-]{1,64}`,
          "invalid_profile",
        );
      }
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new ProfileStoreError(
          `${path}: profile '${name}' must be a table`,
          "invalid_profile",
        );
      }
      const e = entry as Record<string, unknown>;
      const server = e.server;
      const token = e.token;
      if (typeof server !== "string" || server.length === 0) {
        throw new ProfileStoreError(
          `${path}: profile '${name}' missing string 'server'`,
          "invalid_profile",
        );
      }
      if (typeof token !== "string" || token.length === 0) {
        throw new ProfileStoreError(
          `${path}: profile '${name}' missing string 'token'`,
          "invalid_profile",
        );
      }
      state.profiles[name] = { server, token };
    }
  }
  if (
    state.defaultProfile &&
    !Object.prototype.hasOwnProperty.call(state.profiles, state.defaultProfile)
  ) {
    throw new ProfileStoreError(
      `${path}: default profile '${state.defaultProfile}' is not defined`,
      "invalid_profile",
    );
  }
  return state;
}

function validateForSave(state: ProfileState): void {
  for (const [name, p] of Object.entries(state.profiles)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
      throw new ProfileStoreError(
        `profile name '${name}' must match [A-Za-z0-9_.-]{1,64}`,
        "invalid_profile",
      );
    }
    if (!p.server || !p.token) {
      throw new ProfileStoreError(
        `profile '${name}' requires non-empty server + token`,
        "invalid_profile",
      );
    }
  }
  if (
    state.defaultProfile &&
    !Object.prototype.hasOwnProperty.call(state.profiles, state.defaultProfile)
  ) {
    throw new ProfileStoreError(
      `default profile '${state.defaultProfile}' is not defined`,
      "invalid_profile",
    );
  }
}

function serialize(state: ProfileState): string {
  const lines: string[] = [];
  lines.push("# torana CLI profile store. Managed by `torana config`.");
  lines.push("# Mode 0600 — do not share this file.");
  lines.push("");
  if (state.defaultProfile) {
    lines.push(`default = ${tomlString(state.defaultProfile)}`);
    lines.push("");
  }
  const names = Object.keys(state.profiles).sort();
  for (const name of names) {
    const p = state.profiles[name]!;
    lines.push(`[profile.${tomlKey(name)}]`);
    lines.push(`server = ${tomlString(p.server)}`);
    lines.push(`token  = ${tomlString(p.token)}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Bare-key form allowed by TOML when the name is [A-Za-z0-9_-]; else quote. */
function tomlKey(name: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(name)) return name;
  return tomlString(name);
}

function tomlString(s: string): string {
  // TOML basic string: escape \, ", control chars, newlines.
  const esc = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${esc}"`;
}

// ---- mutation helpers used by `torana config` -----------------------------

export function upsertProfile(
  state: ProfileState,
  name: string,
  profile: Profile,
  opts: { makeDefault?: boolean } = {},
): ProfileState {
  const next: ProfileState = {
    defaultProfile: state.defaultProfile,
    profiles: { ...state.profiles, [name]: { ...profile } },
  };
  if (opts.makeDefault || next.defaultProfile === undefined) {
    next.defaultProfile = name;
  }
  return next;
}

export function removeProfile(
  state: ProfileState,
  name: string,
): ProfileState {
  if (!Object.prototype.hasOwnProperty.call(state.profiles, name)) {
    throw new ProfileStoreError(
      `profile '${name}' is not defined`,
      "unknown_profile",
    );
  }
  const next: ProfileState = {
    defaultProfile: state.defaultProfile,
    profiles: { ...state.profiles },
  };
  delete next.profiles[name];
  if (next.defaultProfile === name) {
    const first = Object.keys(next.profiles).sort()[0];
    next.defaultProfile = first;
  }
  return next;
}

export function getProfile(
  state: ProfileState,
  name: string,
): Profile | undefined {
  return state.profiles[name];
}

/** Redact a token for display: keep the first 4 chars, replace the rest. */
export function redactToken(token: string): string {
  if (token.length <= 4) return "****";
  return `${token.slice(0, 4)}${"*".repeat(Math.min(token.length - 4, 8))}`;
}
