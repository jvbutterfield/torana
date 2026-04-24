// Tests for src/cli/shared/files.ts:
//   - magic-byte MIME detection (each supported type + unknown fallback)
//   - `readFileForUpload` via real files and via `@-` stdin (stubbed).
//
// The stdin path uses a monkey-patched `Bun.stdin.bytes` so we don't have
// to shell out to a real subprocess for every case.

import { describe, expect, test, afterEach } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectMimeFromMagic,
  readFileForUpload,
  readStdinForUpload,
} from "../../src/cli/shared/files.js";
import { CliUsageError } from "../../src/cli/shared/args.js";

describe("detectMimeFromMagic", () => {
  test("identifies PNG", () => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
    ]);
    expect(detectMimeFromMagic(bytes)).toBe("image/png");
  });

  test("identifies JPEG", () => {
    expect(detectMimeFromMagic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg",
    );
  });

  test("identifies GIF89a and GIF87a", () => {
    expect(
      detectMimeFromMagic(
        new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0]),
      ),
    ).toBe("image/gif");
    expect(
      detectMimeFromMagic(
        new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0]),
      ),
    ).toBe("image/gif");
  });

  test("identifies WEBP", () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0,
    ]);
    expect(detectMimeFromMagic(bytes)).toBe("image/webp");
  });

  test("identifies PDF", () => {
    // %PDF-
    expect(
      detectMimeFromMagic(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])),
    ).toBe("application/pdf");
  });

  test("returns undefined for unknown bytes", () => {
    expect(
      detectMimeFromMagic(
        new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      ),
    ).toBeUndefined();
  });

  test("returns undefined for too-short buffers", () => {
    expect(detectMimeFromMagic(new Uint8Array([0xff]))).toBeUndefined();
  });
});

describe("readFileForUpload (on-disk)", () => {
  test("returns bytes + MIME + basename for a real file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "torana-files-"));
    const path = join(dir, "thing.png");
    writeFileSync(
      path,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const r = await readFileForUpload(path);
    expect(r.data.length).toBe(8);
    expect(r.mime).toBe("image/png");
    expect(r.filename).toBe("thing.png");
  });

  test("falls back to application/octet-stream on unknown extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "torana-files-"));
    // Use a filename with no extension so Bun.file has nothing to guess from.
    const path = join(dir, "blob");
    writeFileSync(path, new Uint8Array([1, 2, 3]));
    const r = await readFileForUpload(path);
    expect(r.mime).toBe("application/octet-stream");
  });

  test("missing file raises CliUsageError", async () => {
    let caught: unknown;
    try {
      await readFileForUpload("/tmp/definitely-not-a-real-file-torana-6b.bin");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliUsageError);
  });
});

describe("readStdinForUpload", () => {
  const origStdin = (globalThis as { Bun?: { stdin?: unknown } }).Bun?.stdin;
  afterEach(() => {
    if (origStdin !== undefined) {
      (globalThis as { Bun: { stdin: unknown } }).Bun.stdin = origStdin;
    }
  });

  test("returns PDF MIME when stdin starts with %PDF-", async () => {
    (globalThis as { Bun: { stdin: unknown } }).Bun.stdin = {
      async bytes() {
        return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
      },
    };
    const r = await readStdinForUpload();
    expect(r.mime).toBe("application/pdf");
    expect(r.filename).toBe("stdin.pdf");
  });

  test("unknown bytes → application/octet-stream + stdin.bin", async () => {
    (globalThis as { Bun: { stdin: unknown } }).Bun.stdin = {
      async bytes() {
        return new Uint8Array([1, 2, 3, 4, 5]);
      },
    };
    const r = await readStdinForUpload();
    expect(r.mime).toBe("application/octet-stream");
    expect(r.filename).toBe("stdin.bin");
  });

  test("raises CliUsageError on empty stdin", async () => {
    (globalThis as { Bun: { stdin: unknown } }).Bun.stdin = {
      async bytes() {
        return new Uint8Array(0);
      },
    };
    let caught: unknown;
    try {
      await readStdinForUpload();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliUsageError);
  });

  test("readFileForUpload('@-') delegates to readStdinForUpload", async () => {
    (globalThis as { Bun: { stdin: unknown } }).Bun.stdin = {
      async bytes() {
        return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      },
    };
    const r = await readFileForUpload("@-");
    expect(r.mime).toBe("image/png");
    expect(r.filename).toBe("stdin.png");
  });
});
