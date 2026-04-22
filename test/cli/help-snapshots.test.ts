// Help-text snapshots for the Phase 6b-touched subcommands. Intentionally
// narrow — we snapshot specific *invariants* (exit-code table, flag names,
// --profile mention) rather than the full verbatim text, so authoring
// improvements don't cascade into red tests.

import { describe, expect, test } from "bun:test";

import { ASK_HELP } from "../../src/cli/ask.js";
import { SEND_HELP } from "../../src/cli/send.js";
import { CONFIG_HELP } from "../../src/cli/config.js";
import { SKILLS_HELP } from "../../src/cli/skills.js";

describe("ask --help", () => {
  test("declares exit-code table invariants (2, 3, 4, 5, 6, 7)", () => {
    for (const code of ["0", "2", "3", "4", "5", "6", "7"]) {
      expect(ASK_HELP).toMatch(new RegExp(`\\b${code}\\b`));
    }
  });
  test("mentions --session-id, --file (incl. @-), --json", () => {
    expect(ASK_HELP).toContain("--session-id");
    expect(ASK_HELP).toContain("--file");
    expect(ASK_HELP).toContain("@-");
    expect(ASK_HELP).toContain("--json");
  });
});

describe("send --help", () => {
  test("exit codes 0, 2, 3, 4, 5, 7 present", () => {
    for (const code of ["0", "2", "3", "4", "5", "7"]) {
      expect(SEND_HELP).toMatch(new RegExp(`\\b${code}\\b`));
    }
  });
  test("documents --source, --idempotency-key, --user-id/--chat-id", () => {
    expect(SEND_HELP).toContain("--source");
    expect(SEND_HELP).toContain("--idempotency-key");
    expect(SEND_HELP).toContain("--user-id");
    expect(SEND_HELP).toContain("--chat-id");
  });
});

describe("config --help", () => {
  test("lists every subcommand", () => {
    for (const sub of [
      "init",
      "add-profile",
      "list-profiles",
      "remove-profile",
      "show",
    ]) {
      expect(CONFIG_HELP).toContain(sub);
    }
  });
  test("mentions ~/.config/torana/config.toml and mode 0600", () => {
    expect(CONFIG_HELP).toContain(".config/torana");
    expect(CONFIG_HELP).toContain("0600");
  });
});

describe("skills --help", () => {
  test("lists install subcommand + both hosts", () => {
    expect(SKILLS_HELP).toContain("install");
    expect(SKILLS_HELP).toContain("claude");
    expect(SKILLS_HELP).toContain("codex");
  });
  test("documents --force and --dry-run", () => {
    expect(SKILLS_HELP).toContain("--force");
    expect(SKILLS_HELP).toContain("--dry-run");
  });
  test("shows both install paths (CLAUDE_CONFIG_DIR, XDG_DATA_HOME)", () => {
    expect(SKILLS_HELP).toContain("CLAUDE_CONFIG_DIR");
    expect(SKILLS_HELP).toContain("XDG_DATA_HOME");
  });
});
