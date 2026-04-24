// §12.5.3: the config loader has a hard cap on file size
// (DEFAULT_MAX_BYTES, default 1 MiB) that fires BEFORE YAML parse.
// This guards against both the classic "billion laughs" alias-bomb
// and any attempt to hand the process a multi-hundred-megabyte file
// to exhaust memory.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigLoadError,
  loadConfigFromString,
  loadConfigFromFile,
} from "../../../src/config/load.js";

describe("§12.5.3 input.yaml-bomb", () => {
  test("yaml with a huge alias graph (billion laughs variant) fails to parse (not memory-exhausting)", () => {
    // Classic YAML alias bomb pattern. With js-yaml's default parser
    // this either expands hugely or is rejected — either way the
    // config loader receives the failure as ConfigLoadError.
    const bomb = `
a: &a ["x","x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]
e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d,*d]
`;
    let threw = false;
    try {
      loadConfigFromString(bomb);
    } catch (err) {
      threw = true;
      // Schema error is fine — root isn't a valid Config. What we're
      // guarding is: the process didn't OOM, and the error is caught.
      expect(err instanceof ConfigLoadError || err instanceof Error).toBe(true);
    }
    expect(threw).toBe(true);
  });

  test("config file above maxBytes cap fails to load with ConfigLoadError", () => {
    const dir = mkdtempSync(join(tmpdir(), "torana-yaml-bomb-"));
    const path = join(dir, "config.yaml");
    // 1 KiB cap; write 4 KiB.
    writeFileSync(path, "version: 1\n# " + "x".repeat(4000));
    try {
      expect(() => loadConfigFromFile(path, { maxBytes: 1024 })).toThrow(
        ConfigLoadError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("default max bytes (1 MiB) is effectively enforced; can't sneak a 2 MiB file past", () => {
    const dir = mkdtempSync(join(tmpdir(), "torana-yaml-bomb-"));
    const path = join(dir, "config.yaml");
    // 2 MiB of valid-enough YAML.
    writeFileSync(path, "version: 1\n# " + "x".repeat(2 * 1024 * 1024));
    try {
      expect(() => loadConfigFromFile(path)).toThrow(ConfigLoadError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
