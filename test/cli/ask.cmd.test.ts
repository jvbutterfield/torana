// Function-level tests for src/cli/ask.ts using a fake AgentApiClient.

import { describe, expect, test } from "bun:test";

import {
  AgentApiClient,
  AgentApiError,
} from "../../src/agent-api/client.js";
import { runAsk } from "../../src/cli/ask.js";
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

describe("runAsk — happy path", () => {
  test("done → text on stdout, exit 0", async () => {
    const client = clientStub({
      ask: async () => ({
        status: "done",
        text: "echo: hello",
        turn_id: 1,
        session_id: "eph-1",
      }),
    });
    const r = await runAsk(
      { argv: ["alpha", "hello"] },
      { client },
    );
    expect(r.stdout).toEqual(["echo: hello"]);
    expect(r.exitCode).toBe(ExitCode.success);
    expect(r.stderr).toEqual([]);
  });

  test("done → --json prints full response", async () => {
    const client = clientStub({
      ask: async () => ({
        status: "done",
        text: "ok",
        turn_id: 2,
        session_id: "eph-2",
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    });
    const r = await runAsk(
      { argv: ["alpha", "hello", "--json"] },
      { client },
    );
    expect(r.exitCode).toBe(ExitCode.success);
    const body = JSON.parse(r.stdout[0]!);
    expect(body.text).toBe("ok");
    expect(body.usage.input_tokens).toBe(1);
  });

  test("in_progress → exit 6 + turn_id stdout + hint stderr", async () => {
    const client = clientStub({
      ask: async () => ({
        status: "in_progress",
        turn_id: 99,
        session_id: "eph-9",
      }),
    });
    const r = await runAsk(
      { argv: ["alpha", "slow query"] },
      { client },
    );
    expect(r.exitCode).toBe(ExitCode.timeout);
    expect(r.stdout).toEqual(["99"]);
    expect(r.stderr.some((l) => l.includes("torana turns get 99"))).toBe(true);
    expect(r.stderr.some((l) => l.includes("eph-9"))).toBe(true);
  });

  test("session-id flag is forwarded", async () => {
    let captured: { sessionId?: string } = {};
    const client = clientStub({
      ask: async (_botId, body) => {
        captured.sessionId = body.session_id;
        return {
          status: "done",
          text: "ok",
          turn_id: 1,
          session_id: body.session_id ?? "eph-x",
        };
      },
    });
    await runAsk(
      { argv: ["alpha", "hello", "--session-id", "review-7"] },
      { client },
    );
    expect(captured.sessionId).toBe("review-7");
  });

  test("--file uses the injected reader and switches to multipart path", async () => {
    let receivedFiles: unknown;
    const client = clientStub({
      ask: async (_botId, _body, files) => {
        receivedFiles = files;
        return {
          status: "done",
          text: "ok",
          turn_id: 1,
          session_id: "eph-1",
        };
      },
    });
    const reader = async (_path: string) => ({
      data: new Uint8Array([1, 2, 3]),
      mime: "image/png",
    });
    await runAsk(
      { argv: ["alpha", "look", "--file", "/tmp/x.png"] },
      { client, readFile: reader },
    );
    expect(Array.isArray(receivedFiles)).toBe(true);
    const arr = receivedFiles as Array<{ filename: string; contentType: string }>;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.filename).toBe("x.png");
    expect(arr[0]!.contentType).toBe("image/png");
  });

  test("--timeout-ms forwarded as number", async () => {
    let captured: number | undefined;
    const client = clientStub({
      ask: async (_botId, body) => {
        captured = body.timeout_ms;
        return {
          status: "done",
          text: "x",
          turn_id: 1,
          session_id: "eph-x",
        };
      },
    });
    await runAsk(
      { argv: ["alpha", "hi", "--timeout-ms", "12000"] },
      { client },
    );
    expect(captured).toBe(12000);
  });
});

describe("runAsk — error paths", () => {
  test("client throws AgentApiError side_session_busy → exit 7 capacity", async () => {
    const client = clientStub({
      ask: async () => {
        throw new AgentApiError({
          code: "side_session_busy",
          status: 429,
          message: "another turn in flight",
        });
      },
    });
    const r = await runAsk(
      { argv: ["alpha", "hello"] },
      { client },
    );
    expect(r.exitCode).toBe(ExitCode.capacity);
    expect(r.stdout).toEqual([]);
    expect(r.stderr.some((l) => l.includes("side_session_busy"))).toBe(true);
  });

  test("client throws invalid_body → exit 2 bad usage", async () => {
    const client = clientStub({
      ask: async () => {
        throw new AgentApiError({
          code: "invalid_body",
          status: 400,
          message: "text required",
        });
      },
    });
    const r = await runAsk(
      { argv: ["alpha", "x"] },
      { client },
    );
    expect(r.exitCode).toBe(ExitCode.badUsage);
  });

  test("--json emits error body to stdout", async () => {
    const client = clientStub({
      ask: async () => {
        throw new AgentApiError({
          code: "runner_fatal",
          status: 503,
          message: "spawn died",
        });
      },
    });
    const r = await runAsk(
      { argv: ["alpha", "x", "--json"] },
      { client },
    );
    expect(r.exitCode).toBe(ExitCode.serverError);
    expect(r.stderr).toEqual([]);
    const body = JSON.parse(r.stdout[0]!);
    expect(body.error).toBe("runner_fatal");
    expect(body.status).toBe(503);
  });

  test("missing positional <text> throws CliUsageError", async () => {
    const client = clientStub({});
    await expect(
      runAsk({ argv: ["alpha"] }, { client }),
    ).rejects.toThrow(CliUsageError);
  });

  test("too many positional args throws CliUsageError", async () => {
    const client = clientStub({});
    await expect(
      runAsk({ argv: ["alpha", "hi", "extra"] }, { client }),
    ).rejects.toThrow(/two positional/);
  });

  test("non-numeric --timeout-ms throws CliUsageError", async () => {
    const client = clientStub({});
    await expect(
      runAsk({ argv: ["alpha", "hi", "--timeout-ms", "soon"] }, { client }),
    ).rejects.toThrow(/numeric/);
  });
});

describe("runAsk — help", () => {
  test("--help short-circuits with help text + exit 0", async () => {
    const client = clientStub({});
    const r = await runAsk(
      { argv: ["--help"] },
      { client },
    );
    expect(r.exitCode).toBe(ExitCode.success);
    expect(r.stdout[0]).toContain("Usage: torana ask");
  });
});
