// Function-level tests for src/cli/inject.ts using a fake AgentApiClient.

import { describe, expect, test } from "bun:test";

import {
  AgentApiClient,
  AgentApiError,
} from "../../src/agent-api/client.js";
import { runInject } from "../../src/cli/inject.js";
import { ExitCode } from "../../src/cli/shared/exit.js";
import { CliUsageError } from "../../src/cli/shared/args.js";

function clientStub(impl: Partial<AgentApiClient>): AgentApiClient {
  return Object.assign(
    new AgentApiClient({ server: "http://x", token: "t", fetchImpl: (() => {
      throw new Error("not used");
    }) as unknown as typeof fetch }),
    impl,
  );
}

describe("runInject — happy path", () => {
  test("explicit idempotency-key forwarded; no auto-key stderr", async () => {
    let capturedKey: string | undefined;
    const client = clientStub({
      inject: async (_botId, _body, opts) => {
        capturedKey = opts.idempotencyKey;
        return { turn_id: 5, status: "queued" };
      },
    });
    const r = await runInject(
      {
        argv: [
          "alpha",
          "hi",
          "--source",
          "calendar",
          "--user-id",
          "12345",
          "--idempotency-key",
          "qqqqqqqqqqqqqqqq",
        ],
      },
      { client },
    );
    expect(capturedKey).toBe("qqqqqqqqqqqqqqqq");
    expect(r.exitCode).toBe(ExitCode.success);
    expect(r.stdout[0]).toContain("turn_id: 5");
    expect(r.stderr).toEqual([]);
  });

  test("auto-generates idempotency-key when omitted; emits notice on stderr", async () => {
    let capturedKey: string | undefined;
    const client = clientStub({
      inject: async (_botId, _body, opts) => {
        capturedKey = opts.idempotencyKey;
        return { turn_id: 7, status: "queued" };
      },
    });
    const r = await runInject(
      {
        argv: [
          "alpha",
          "hi",
          "--source",
          "calendar",
          "--user-id",
          "12345",
        ],
      },
      { client, generateKey: () => "auto-key-1234567" },
    );
    expect(capturedKey).toBe("auto-key-1234567");
    expect(r.stderr.some((l) => l.includes("auto-generated idempotency-key: auto-key-1234567"))).toBe(true);
  });

  test("--chat-id is parsed as integer", async () => {
    let captured: number | undefined;
    const client = clientStub({
      inject: async (_botId, body) => {
        captured = body.chat_id;
        return { turn_id: 1, status: "queued" };
      },
    });
    await runInject(
      {
        argv: ["alpha", "hi", "--source", "src", "--chat-id", "98765"],
      },
      { client, generateKey: () => "k".repeat(20) },
    );
    expect(captured).toBe(98765);
  });

  test("--json emits full response body", async () => {
    const client = clientStub({
      inject: async () => ({ turn_id: 11, status: "in_progress" }),
    });
    const r = await runInject(
      {
        argv: [
          "alpha",
          "hi",
          "--source",
          "src",
          "--user-id",
          "1",
          "--json",
        ],
      },
      { client, generateKey: () => "k".repeat(20) },
    );
    const parsed = JSON.parse(r.stdout[0]!);
    expect(parsed.turn_id).toBe(11);
    expect(parsed.status).toBe("in_progress");
  });

  test("--file forwards through reader as multipart", async () => {
    let receivedFiles: unknown;
    const client = clientStub({
      inject: async (_botId, _body, opts) => {
        receivedFiles = opts.files;
        return { turn_id: 1, status: "queued" };
      },
    });
    const reader = async () => ({
      data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      mime: "application/pdf",
      filename: "alert.pdf",
    });
    await runInject(
      {
        argv: [
          "alpha",
          "hi",
          "--source",
          "monitor",
          "--user-id",
          "1",
          "--file",
          "/tmp/alert.pdf",
        ],
      },
      { client, generateKey: () => "k".repeat(20), readFile: reader },
    );
    const files = receivedFiles as Array<{ filename: string; contentType: string }>;
    expect(files).toHaveLength(1);
    expect(files[0]!.filename).toBe("alert.pdf");
    expect(files[0]!.contentType).toBe("application/pdf");
  });
});

describe("runInject — usage errors", () => {
  test("missing --source", async () => {
    const client = clientStub({});
    await expect(
      runInject(
        { argv: ["alpha", "hi", "--user-id", "1"] },
        { client },
      ),
    ).rejects.toThrow(/--source is required/);
  });

  test("neither --user-id nor --chat-id", async () => {
    const client = clientStub({});
    await expect(
      runInject(
        { argv: ["alpha", "hi", "--source", "src"] },
        { client },
      ),
    ).rejects.toThrow(/either --user-id or --chat-id/);
  });

  test("both --user-id and --chat-id", async () => {
    const client = clientStub({});
    await expect(
      runInject(
        {
          argv: [
            "alpha",
            "hi",
            "--source",
            "src",
            "--user-id",
            "1",
            "--chat-id",
            "2",
          ],
        },
        { client },
      ),
    ).rejects.toThrow(/only one of/);
  });

  test("non-integer --chat-id", async () => {
    const client = clientStub({});
    await expect(
      runInject(
        {
          argv: [
            "alpha",
            "hi",
            "--source",
            "src",
            "--chat-id",
            "abc",
          ],
        },
        { client },
      ),
    ).rejects.toThrow(/integer/);
  });

  test("missing positional <text>", async () => {
    const client = clientStub({});
    await expect(
      runInject(
        { argv: ["alpha", "--source", "src", "--user-id", "1"] },
        { client },
      ),
    ).rejects.toThrow(CliUsageError);
  });
});

describe("runInject — server errors", () => {
  test("target_not_authorized → exit 3 + auto-key stderr preserved", async () => {
    const client = clientStub({
      inject: async () => {
        throw new AgentApiError({
          code: "target_not_authorized",
          status: 403,
          message: "user 1 not in ACL",
        });
      },
    });
    const r = await runInject(
      {
        argv: [
          "alpha",
          "hi",
          "--source",
          "src",
          "--user-id",
          "1",
        ],
      },
      { client, generateKey: () => "auto-1234567890ab" },
    );
    expect(r.exitCode).toBe(ExitCode.authFailed);
    // Auto-key notice still emitted (so the user can retry idempotently)
    expect(r.stderr.some((l) => l.includes("auto-generated idempotency-key"))).toBe(true);
    expect(r.stderr.some((l) => l.includes("target_not_authorized"))).toBe(true);
  });
});

describe("runInject — help", () => {
  test("--help short-circuits", async () => {
    const client = clientStub({});
    const r = await runInject({ argv: ["--help"] }, { client });
    expect(r.exitCode).toBe(ExitCode.success);
    expect(r.stdout[0]).toContain("Usage: torana inject");
  });
});
