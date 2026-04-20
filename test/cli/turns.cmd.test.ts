// Function-level tests for src/cli/turns.ts.

import { describe, expect, test } from "bun:test";

import {
  AgentApiClient,
  AgentApiError,
} from "../../src/agent-api/client.js";
import { runTurns } from "../../src/cli/turns.js";
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

describe("runTurns get", () => {
  test("done — text + duration printed, exit 0", async () => {
    const client = clientStub({
      getTurn: async () => ({
        turn_id: 5,
        status: "done",
        text: "hello",
        duration_ms: 12,
      }),
    });
    const r = await runTurns({ argv: ["5"], action: "get" }, { client });
    expect(r.exitCode).toBe(ExitCode.success);
    expect(r.stdout).toContain("hello");
    expect(r.stdout.some((l) => l.includes("duration_ms: 12"))).toBe(true);
  });

  test("in_progress — exit 6 timeout", async () => {
    const client = clientStub({
      getTurn: async () => ({ turn_id: 5, status: "in_progress" }),
    });
    const r = await runTurns({ argv: ["5"], action: "get" }, { client });
    expect(r.exitCode).toBe(ExitCode.timeout);
    expect(r.stdout[0]).toContain("in_progress");
  });

  test("failed — exit 5 + error printed", async () => {
    const client = clientStub({
      getTurn: async () => ({
        turn_id: 5,
        status: "failed",
        error: "interrupted_by_gateway_restart",
      }),
    });
    const r = await runTurns({ argv: ["5"], action: "get" }, { client });
    expect(r.exitCode).toBe(ExitCode.serverError);
    expect(r.stdout.some((l) => l.includes("interrupted_by_gateway_restart"))).toBe(true);
  });

  test("--json mode", async () => {
    const client = clientStub({
      getTurn: async () => ({ turn_id: 5, status: "done", text: "x" }),
    });
    const r = await runTurns(
      { argv: ["5", "--json"], action: "get" },
      { client },
    );
    const parsed = JSON.parse(r.stdout[0]!);
    expect(parsed.status).toBe("done");
  });

  test("non-numeric id rejected", async () => {
    const client = clientStub({});
    await expect(
      runTurns({ argv: ["abc"], action: "get" }, { client }),
    ).rejects.toThrow(CliUsageError);
  });

  test("zero id rejected", async () => {
    const client = clientStub({});
    await expect(
      runTurns({ argv: ["0"], action: "get" }, { client }),
    ).rejects.toThrow(/positive integer/);
  });

  test("negative id (numeric prefix) rejected — argv leading hyphen looks like a flag", async () => {
    const client = clientStub({});
    // The flag parser treats `-5` as a short flag; we surface that as
    // "unknown flag" rather than a turn-id validation error. Either is
    // a usage error from the user's perspective.
    await expect(
      runTurns({ argv: ["-5"], action: "get" }, { client }),
    ).rejects.toThrow(/unknown flag/);
  });

  test("unknown action rejected", async () => {
    const client = clientStub({});
    await expect(
      runTurns({ argv: ["5"], action: "delete" }, { client }),
    ).rejects.toThrow(/unknown turns subcommand/);
  });

  test("turn_not_found from server → exit 4 not found", async () => {
    const client = clientStub({
      getTurn: async () => {
        throw new AgentApiError({
          code: "turn_not_found",
          status: 404,
          message: "no such turn",
        });
      },
    });
    const r = await runTurns({ argv: ["999"], action: "get" }, { client });
    expect(r.exitCode).toBe(ExitCode.notFound);
  });

  test("--help short-circuits", async () => {
    const client = clientStub({});
    const r = await runTurns({ argv: ["--help"], action: "get" }, { client });
    expect(r.exitCode).toBe(ExitCode.success);
    expect(r.stdout[0]).toContain("Usage: torana turns get");
  });
});
