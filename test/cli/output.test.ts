// Tests for src/cli/shared/output.ts — formatter helpers.

import { describe, expect, test } from "bun:test";

import {
  formatTable,
  padRight,
  renderJson,
  renderText,
} from "../../src/cli/shared/output.js";

describe("padRight", () => {
  test("pads short strings to width", () => {
    expect(padRight("ab", 5)).toBe("ab   ");
  });
  test("returns string unchanged when already at width", () => {
    expect(padRight("abcde", 5)).toBe("abcde");
  });
  test("returns string unchanged when longer than width", () => {
    expect(padRight("abcdefg", 3)).toBe("abcdefg");
  });
});

describe("renderJson", () => {
  test("formats with 2-space indent", () => {
    const r = renderJson({ a: 1, b: [2, 3] }, 0);
    expect(r.stdout).toEqual([`{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}`]);
    expect(r.stderr).toEqual([]);
    expect(r.exitCode).toBe(0);
  });
});

describe("renderText", () => {
  test("passes through lines + exit code", () => {
    const r = renderText(["hello", "world"], 7, ["warn1"]);
    expect(r.stdout).toEqual(["hello", "world"]);
    expect(r.stderr).toEqual(["warn1"]);
    expect(r.exitCode).toBe(7);
  });
  test("default empty stderr", () => {
    const r = renderText(["x"], 0);
    expect(r.stderr).toEqual([]);
  });
});

describe("formatTable", () => {
  test("widths fit longest value per column", () => {
    const lines = formatTable(
      ["BOT", "RUNNER", "ASK?"],
      [
        ["alpha", "claude-code", "yes"],
        ["beta-very-long", "command", "no"],
      ],
    );
    expect(lines).toHaveLength(4); // header, separator, two rows
    expect(lines[0]).toMatch(/^BOT.*RUNNER.*ASK\?/);
    // separator line: dashes only + spaces
    expect(lines[1]).toMatch(/^-+/);
    // row containing the long bot id
    expect(lines[3]).toMatch(/^beta-very-long/);
  });

  test("empty rows still produce header + separator", () => {
    const lines = formatTable(["A", "B"], []);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^A\s+B$/);
  });
});
