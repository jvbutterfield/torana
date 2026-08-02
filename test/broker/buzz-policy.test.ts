import { describe, expect, test } from "bun:test";

import {
  DANGEROUS_BUZZ_COMMANDS,
  isKnownBuzzCommand,
  knownBuzzCommands,
  resolveBuzzPolicy,
} from "../../src/broker/buzz-policy.js";

describe("Buzz broker policy profiles", () => {
  test("named profiles widen deliberately and never grant high-risk commands", () => {
    const readOnly = resolveBuzzPolicy({ profile: "read_only" });
    const collaborate = resolveBuzzPolicy({ profile: "collaborate" });
    const maintainer = resolveBuzzPolicy({ profile: "maintainer" });

    expect(readOnly.has("channels.list")).toBe(true);
    expect(readOnly.has("messages.send")).toBe(false);
    expect(collaborate.has("messages.send")).toBe(true);
    expect(collaborate.has("channels.create")).toBe(false);
    expect(maintainer.has("channels.create")).toBe(true);
    for (const command of DANGEROUS_BUZZ_COMMANDS) {
      expect(readOnly.has(command)).toBe(false);
      expect(collaborate.has(command)).toBe(false);
      expect(maintainer.has(command)).toBe(false);
    }
  });

  test("custom policy is exact, manifest-bound, and dangerous-acknowledged", () => {
    expect(
      resolveBuzzPolicy({
        profile: "custom",
        allowedCommands: ["channels.list", "messages.send"],
      }),
    ).toEqual(new Set(["channels.list", "messages.send"]));
    expect(() =>
      resolveBuzzPolicy({
        profile: "custom",
        allowedCommands: ["future.unknown"],
      }),
    ).toThrow(/unknown Buzz command/);
    expect(() =>
      resolveBuzzPolicy({
        profile: "custom",
        allowedCommands: ["channels.delete"],
      }),
    ).toThrow(/acknowledge_dangerous/);
    expect(
      resolveBuzzPolicy({
        profile: "custom",
        allowedCommands: ["channels.delete"],
        acknowledgeDangerous: true,
      }).has("channels.delete"),
    ).toBe(true);
  });

  test("production manifest exposes every pinned command path", () => {
    const commands = knownBuzzCommands();
    expect(commands.length).toBeGreaterThan(90);
    expect(commands.every(isKnownBuzzCommand)).toBe(true);
    expect(commands).toContain("repos.protect.list");
    expect(commands).toContain("repos.protect.set");
    expect(commands).toContain("repos.protect.remove");
  });
});
