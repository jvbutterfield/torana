// `torana ask --file @-` / `torana send --file @-` integration at the
// subcommand layer. We inject a stub `readFile` so stdin I/O doesn't
// escape the test process, then assert:
//   - stdin bytes reach the request as an attachment
//   - a second `@-` in the same call is rejected as bad usage
//   - mixed `@-` + real-path works

import { describe, expect, test } from "bun:test";

import { runAsk } from "../../src/cli/ask.js";
import { runSend } from "../../src/cli/send.js";
import type { AgentApiClient, FileUpload } from "../../src/agent-api/client.js";

function clientStub(overrides: Partial<AgentApiClient> = {}): AgentApiClient {
  const base: Partial<AgentApiClient> = {
    ask: (async () => ({
      status: "done",
      turn_id: 1,
      bot_id: "alpha",
      session_id: "eph-x",
      text: "ok",
    })) as AgentApiClient["ask"],
    send: (async () => ({
      turn_id: 1,
      status: "queued",
    })) as AgentApiClient["send"],
  };
  return { ...base, ...overrides } as AgentApiClient;
}

const readerByPath = (map: Record<string, { data: Uint8Array; mime: string; filename: string }>) =>
  async (p: string) => {
    const r = map[p];
    if (!r) throw new Error(`reader: no stub for ${p}`);
    return r;
  };

describe("ask --file @-", () => {
  test("stdin bytes reach the client as a single attachment", async () => {
    let captured: FileUpload[] | undefined;
    const client = clientStub({
      ask: async (_botId, _body, files) => {
        captured = files;
        return {
          status: "done",
          turn_id: 1,
          bot_id: "alpha",
          session_id: "eph-x",
          text: "ok",
        };
      },
    });
    const read = readerByPath({
      "@-": { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: "image/png", filename: "stdin.png" },
    });
    const r = await runAsk(
      { argv: ["alpha", "hi", "--file", "@-"] },
      { client, readFile: read },
    );
    expect(r.exitCode).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured![0]!.filename).toBe("stdin.png");
    expect(captured![0]!.contentType).toBe("image/png");
  });

  test("mixed --file @- + real path yields two attachments", async () => {
    let captured: FileUpload[] | undefined;
    const client = clientStub({
      ask: async (_b, _body, files) => {
        captured = files;
        return {
          status: "done",
          turn_id: 1,
          bot_id: "alpha",
          session_id: "eph-x",
          text: "ok",
        };
      },
    });
    const read = readerByPath({
      "@-": { data: new Uint8Array([0xff, 0xd8, 0xff]), mime: "image/jpeg", filename: "stdin.jpg" },
      "/tmp/a.pdf": { data: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mime: "application/pdf", filename: "a.pdf" },
    });
    const r = await runAsk(
      { argv: ["alpha", "hi", "--file", "@-", "--file", "/tmp/a.pdf"] },
      { client, readFile: read },
    );
    expect(r.exitCode).toBe(0);
    expect(captured).toHaveLength(2);
    expect(captured![0]!.filename).toBe("stdin.jpg");
    expect(captured![1]!.filename).toBe("a.pdf");
  });

  test("two --file @- on the same call → bad usage (exit 2)", async () => {
    const client = clientStub();
    const read = readerByPath({
      "@-": { data: new Uint8Array([0, 1]), mime: "application/octet-stream", filename: "stdin.bin" },
    });
    let caught: unknown;
    try {
      await runAsk(
        { argv: ["alpha", "hi", "--file", "@-", "--file", "@-"] },
        { client, readFile: read },
      );
    } catch (e) {
      caught = e;
    }
    // runAsk throws CliUsageError; the dispatcher converts it to exit 2.
    // Here we accept either a thrown error or a rendered bad-usage exit.
    expect((caught as Error | undefined)?.message ?? "").toMatch(/@- may be given at most once/);
  });
});

describe("send --file @-", () => {
  test("stdin bytes reach the client as a single attachment", async () => {
    let captured: FileUpload[] | undefined;
    const client = clientStub({
      send: async (_b, _body, opts) => {
        captured = opts.files;
        return { turn_id: 7, status: "queued" };
      },
    });
    const read = readerByPath({
      "@-": { data: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mime: "application/pdf", filename: "stdin.pdf" },
    });
    const r = await runSend(
      {
        argv: [
          "alpha",
          "hi",
          "--source",
          "cal",
          "--user-id",
          "1",
          "--file",
          "@-",
        ],
      },
      { client, readFile: read, generateKey: () => "k".repeat(20) },
    );
    expect(r.exitCode).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured![0]!.filename).toBe("stdin.pdf");
    expect(captured![0]!.contentType).toBe("application/pdf");
  });

  test("auto-generated idempotency-key is surfaced on stderr", async () => {
    const client = clientStub({
      send: async () => ({ turn_id: 1, status: "queued" }),
    });
    const r = await runSend(
      {
        argv: [
          "alpha",
          "hi",
          "--source",
          "cal",
          "--user-id",
          "1",
        ],
      },
      { client, generateKey: () => "auto-key-abcdef0123456789" },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr.some((line) => line.startsWith("# auto-generated idempotency-key:"))).toBe(true);
    expect(r.stderr.some((line) => line.includes("auto-key-abcdef0123456789"))).toBe(true);
  });

  test("caller-supplied idempotency-key suppresses the auto notice", async () => {
    const client = clientStub({
      send: async () => ({ turn_id: 1, status: "queued" }),
    });
    const r = await runSend(
      {
        argv: [
          "alpha",
          "hi",
          "--source",
          "cal",
          "--user-id",
          "1",
          "--idempotency-key",
          "caller-supplied-key-0001",
        ],
      },
      { client },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr.some((l) => l.startsWith("# auto-generated"))).toBe(false);
  });

  test("two --file @- rejected with usage error", async () => {
    const client = clientStub();
    const read = readerByPath({
      "@-": { data: new Uint8Array([0, 1]), mime: "application/octet-stream", filename: "stdin.bin" },
    });
    let caught: unknown;
    try {
      await runSend(
        {
          argv: [
            "alpha",
            "hi",
            "--source",
            "x",
            "--user-id",
            "1",
            "--file",
            "@-",
            "--file",
            "@-",
          ],
        },
        { client, readFile: read },
      );
    } catch (e) {
      caught = e;
    }
    expect((caught as Error | undefined)?.message ?? "").toMatch(/@- may be given at most once/);
  });
});
