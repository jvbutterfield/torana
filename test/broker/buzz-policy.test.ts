import { describe, expect, test } from "bun:test";

import manifest from "../../spike/buzz-transport/cli-manifest.json" with { type: "json" };
import provenance from "../../spike/buzz-transport/artifact-provenance.json" with { type: "json" };
import {
  BUZZ_CLI_PIN,
  DANGEROUS_BUZZ_COMMANDS,
  isKnownBuzzCommand,
  isReadOnlyBuzzCommand,
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
    expect(readOnly.has("projects.get")).toBe(true);
    expect(readOnly.has("projects.list")).toBe(true);
    expect(collaborate.has("projects.create")).toBe(false);
    expect(maintainer.has("projects.create")).toBe(true);
    expect(maintainer.has("projects.add-repo")).toBe(true);
    expect(maintainer.has("projects.delete")).toBe(false);
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
    expect(commands).toContain("projects.get");
    expect(commands).toContain("projects.create");
    expect(commands).toContain("projects.delete");
  });

  test("the pin, the tracked manifest, and the recorded provenance name one artifact", () => {
    // A CLI upgrade touches four surfaces that can drift apart silently
    // (runbook §1-2). Bind them here so a half-finished upgrade fails a test
    // rather than shipping a broker manifest that describes a binary nobody
    // verified.
    const pin: {
      applicationVersion: string;
      tag: string;
      commit: string;
      sha256: string;
      manifestSchemaVersion: number;
    } = BUZZ_CLI_PIN;

    expect(pin.applicationVersion).toBe(provenance.application.version);
    expect(pin.tag).toBe(provenance.source.tag);
    expect(pin.commit).toBe(provenance.source.commit);
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.tag).toBe(`desktop-v${pin.applicationVersion}`);
    expect(pin.sha256).toBe(provenance.buzzExecutable.sha256);
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.buzzExecutable.byteForByteMatch).toBe(true);
    expect(provenance.releaseArtifact.downloadedSha256Matched).toBe(true);
    expect(provenance.releaseArtifact.downloadUrl).toContain(
      provenance.source.tag,
    );

    expect(manifest.sha256).toBe(pin.sha256);
    expect(manifest.schemaVersion).toBe(pin.manifestSchemaVersion);
  });

  test("no manifest command is silently unclassified", () => {
    // The runbook forbids accepting a mechanically generated manifest. A
    // command in no tier is unreachable from every named profile and can only
    // be granted through `custom`. That is a defensible default — it fails
    // closed — but it must be a recorded decision, not drift, so the exact
    // custom-only set is pinned here. A new upstream command lands in this
    // list and fails the test until someone classifies it.
    const maintainer = resolveBuzzPolicy({ profile: "maintainer" });
    const customOnly = knownBuzzCommands().filter(
      (path) => !maintainer.has(path) && !DANGEROUS_BUZZ_COMMANDS.has(path),
    );
    expect(customOnly).toEqual([
      "dms.add-member",
      "dms.hide",
      "messages.vote",
      "notes.rm",
      "patches.status",
      "pr.status",
      "users.set-presence",
      "users.set-profile",
      "users.set-status",
    ]);

    // Dangerous is disjoint from every named profile, and read-only never
    // overlaps the write tiers.
    for (const path of DANGEROUS_BUZZ_COMMANDS) {
      expect(isKnownBuzzCommand(path)).toBe(true);
      expect(isReadOnlyBuzzCommand(path)).toBe(false);
    }
    const readOnly = resolveBuzzPolicy({ profile: "read_only" });
    for (const path of readOnly) expect(isReadOnlyBuzzCommand(path)).toBe(true);
  });
});
