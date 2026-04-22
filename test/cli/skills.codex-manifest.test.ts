// Snapshots the Codex plugin manifest + marketplace.json so upstream
// Codex manifest-schema drift shows up here as a failing test instead of
// a silent install failure on the user's machine.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("codex-plugin/.codex-plugin/plugin.json", () => {
  const text = readFileSync(
    join(REPO_ROOT, "codex-plugin", ".codex-plugin", "plugin.json"),
    "utf-8",
  );
  const parsed = JSON.parse(text);

  test("advertises name = torana", () => {
    expect(parsed.name).toBe("torana");
  });

  test("version string matches NN.NN.NN[-rc.N] shape", () => {
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+(-rc\.\d+)?$/);
  });

  test("declares both skills with correct paths", () => {
    expect(parsed.skills["torana-ask"].path).toBe("skills/torana-ask");
    expect(parsed.skills["torana-send"].path).toBe("skills/torana-send");
  });

  test("has description + homepage (Codex surfaces these in the UI)", () => {
    expect(typeof parsed.description).toBe("string");
    expect(parsed.description.length).toBeGreaterThan(20);
    expect(typeof parsed.homepage).toBe("string");
    expect(parsed.homepage).toMatch(/^https?:\/\//);
  });
});

describe("codex-plugin/marketplace.json", () => {
  const text = readFileSync(
    join(REPO_ROOT, "codex-plugin", "marketplace.json"),
    "utf-8",
  );
  const parsed = JSON.parse(text);

  test("has a single plugin entry", () => {
    expect(Array.isArray(parsed.plugins)).toBe(true);
    expect(parsed.plugins).toHaveLength(1);
  });

  test("entry matches plugin.json name and version", () => {
    const pj = JSON.parse(
      readFileSync(join(REPO_ROOT, "codex-plugin", ".codex-plugin", "plugin.json"), "utf-8"),
    );
    expect(parsed.plugins[0].name).toBe(pj.name);
    expect(parsed.plugins[0].version).toBe(pj.version);
  });

  test("source type=local, path=./codex-plugin", () => {
    expect(parsed.plugins[0].source).toEqual({ type: "local", path: "./codex-plugin" });
  });
});

describe("skills SKILL.md frontmatter", () => {
  for (const skill of ["torana-ask", "torana-send"]) {
    test(`${skill}: frontmatter declares allow_implicit_invocation: true`, () => {
      const text = readFileSync(join(REPO_ROOT, "skills", skill, "SKILL.md"), "utf-8");
      expect(text.startsWith("---\n")).toBe(true);
      const end = text.indexOf("\n---\n", 4);
      expect(end).toBeGreaterThan(0);
      const fm = text.slice(4, end);
      expect(fm).toContain(`name: ${skill}`);
      expect(fm).toContain("allow_implicit_invocation: true");
      expect(fm).toContain("description:");
    });
  }
});
