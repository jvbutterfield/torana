// Function-level tests for src/cli/bots.ts.

import { describe, expect, test } from "bun:test";

import {
  AgentApiClient,
  AgentApiError,
} from "../../src/agent-api/client.js";
import { runBots } from "../../src/cli/bots.js";
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

describe("runBots list", () => {
  test("renders a table sorted by bot_id (server-sorted)", async () => {
    const client = clientStub({
      listBots: async () => ({
        bots: [
          { bot_id: "alpha", runner_type: "claude-code", supports_side_sessions: true },
          { bot_id: "beta", runner_type: "command", supports_side_sessions: false },
        ],
      }),
    });
    const r = await runBots({ argv: [], action: "list" }, { client });
    expect(r.exitCode).toBe(ExitCode.success);
    // Header + separator + 2 rows
    expect(r.stdout.length).toBe(4);
    expect(r.stdout[0]).toMatch(/^BOT_ID/);
    expect(r.stdout[2]).toMatch(/alpha.*claude-code.*yes/);
    expect(r.stdout[3]).toMatch(/beta.*command.*no/);
  });

  test("omits RUNNER column when no row carries runner_type", async () => {
    // Default gateway config (`expose_runner_type: false`) → the field
    // is missing from every list item, so the table drops the column
    // rather than showing a useless empty string.
    const client = clientStub({
      listBots: async () => ({
        bots: [
          { bot_id: "alpha", supports_side_sessions: true },
          { bot_id: "beta", supports_side_sessions: false },
        ],
      }),
    });
    const r = await runBots({ argv: [], action: "list" }, { client });
    expect(r.exitCode).toBe(ExitCode.success);
    expect(r.stdout[0]).toMatch(/^BOT_ID/);
    expect(r.stdout[0]).not.toMatch(/RUNNER/);
    expect(r.stdout[0]).toMatch(/ASK\?/);
    expect(r.stdout[2]).toMatch(/^alpha\s+yes\s*$/);
    expect(r.stdout[3]).toMatch(/^beta\s+no\s*$/);
  });

  test("empty bot list prints helpful hint", async () => {
    const client = clientStub({
      listBots: async () => ({ bots: [] }),
    });
    const r = await runBots({ argv: [], action: "list" }, { client });
    expect(r.exitCode).toBe(ExitCode.success);
    expect(r.stdout[0]).toContain("no bots");
  });

  test("--json mode emits raw response", async () => {
    const client = clientStub({
      listBots: async () => ({
        bots: [
          { bot_id: "alpha", runner_type: "claude-code", supports_side_sessions: true },
        ],
      }),
    });
    const r = await runBots(
      { argv: ["--json"], action: "list" },
      { client },
    );
    const body = JSON.parse(r.stdout[0]!);
    expect(body.bots).toHaveLength(1);
  });

  test("invalid_token from server → exit 3", async () => {
    const client = clientStub({
      listBots: async () => {
        throw new AgentApiError({
          code: "invalid_token",
          status: 401,
          message: "bad bearer",
        });
      },
    });
    const r = await runBots({ argv: [], action: "list" }, { client });
    expect(r.exitCode).toBe(ExitCode.authFailed);
    expect(r.stderr.some((l) => l.includes("invalid_token"))).toBe(true);
  });

  test("positional arg rejected", async () => {
    const client = clientStub({});
    await expect(
      runBots({ argv: ["extra"], action: "list" }, { client }),
    ).rejects.toThrow(/no positional/);
  });

  test("unknown action rejected", async () => {
    const client = clientStub({});
    await expect(
      runBots({ argv: [], action: "delete" }, { client }),
    ).rejects.toThrow(CliUsageError);
  });

  test("--help short-circuits", async () => {
    const client = clientStub({});
    const r = await runBots(
      { argv: ["--help"], action: "list" },
      { client },
    );
    expect(r.exitCode).toBe(ExitCode.success);
    expect(r.stdout[0]).toContain("Usage: torana bots list");
  });
});
