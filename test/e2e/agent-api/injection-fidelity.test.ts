// US-031 — injection fidelity: do a provisioned agent's instructions actually
// reach the process that runs it?
//
// This is the phase's real risk, and the plan names it: "prompt injection that
// silently no-ops is this plan's equivalent of the kebab-case trap — test
// against reality, not against our own vocabulary." A unit test that asserts
// `projectRunner()` returned `["--append-system-prompt", "be terse"]` proves
// only that our own function agrees with itself. Two things it cannot prove:
//
//   1. that those strings survive a real spawn as *separate* argv elements,
//      rather than being re-split on whitespace somewhere along the way; and
//   2. that the pinned `claude` CLI *honors* `--append-system-prompt` rather
//      than merely accepting it — a flag can be parsed and ignored, and the
//      agent would run with no instructions while every test stayed green.
//
// The first is checked here for free against a fixture that echoes its argv.
// The second needs a real model call and sits behind `AGENT_API_E2E=1`.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ProvisioningSchema } from "../../../src/config/v2.js";
import {
  projectInstructions,
  projectRunner,
} from "../../../src/platform/buzz/provisioned-agents.js";
import { e2eEnabled, inheritedEnv } from "./_harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ECHO_ARGV = resolve(__dirname, "../../integration/fixtures/echo-argv.ts");

interface EchoResult {
  argv: string[];
  cwd: string;
  env: Record<string, string | null>;
}

/** Spawn a projected `command` runner and read back what it received. */
async function spawnEcho(input: {
  systemPrompt: string;
  model: string | null;
  workspace: string;
}): Promise<EchoResult> {
  const provisioning = ProvisioningSchema.parse({
    harnesses: {
      echo: {
        runner: {
          type: "command",
          cli_path: "bun",
          args: [
            ECHO_ARGV,
            "--model",
            "{model}",
            "--append-system-prompt",
            "{system_prompt}",
            "--workspace",
            "{workspace}",
          ],
          env: { TORANA_TEST_MARKER: "agent-{agent_id}" },
          protocol: "jsonl-text",
          resume_model: "stable_session_id",
        },
        ceilings: {
          turn_timeout_secs: 600,
          idle_timeout_secs: 600,
          max_turn_duration_secs: 600,
        },
      },
    },
  });

  const runner = projectRunner({
    agentId: "canary",
    workspace: input.workspace,
    instructions: projectInstructions(
      {
        harness: "echo",
        systemPrompt: input.systemPrompt,
        model: input.model,
        timeoutsJson: "{}",
      },
      provisioning,
    ),
    provisioning,
  });

  const proc = Bun.spawn([runner.cliPath, ...runner.args], {
    cwd: runner.cwd,
    env: { ...inheritedEnv(), ...runner.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const line = stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as EchoResult;
}

describe("projected instructions survive a real spawn", () => {
  test("prompt and model arrive as distinct argv elements", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "torana-inject-"));
    try {
      const echoed = await spawnEcho({
        systemPrompt: "be terse",
        model: "claude-sonnet-5",
        workspace,
      });
      expect(echoed.argv).toEqual([
        "--model",
        "claude-sonnet-5",
        "--append-system-prompt",
        "be terse",
        "--workspace",
        workspace,
      ]);
      expect(echoed.env.TORANA_TEST_MARKER).toBe("agent-canary");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("a prompt containing spaces and quotes stays exactly one argument", async () => {
    // The failure this exists for: a value re-split on whitespace turns one
    // instruction into several arguments, and the CLI reads the tail of the
    // prompt as flags.
    const workspace = mkdtempSync(join(tmpdir(), "torana-inject-"));
    const prompt = `you are "terse"; do not --explain  yourself`;
    try {
      const echoed = await spawnEcho({
        systemPrompt: prompt,
        model: null,
        workspace,
      });
      expect(echoed.argv).toContain(prompt);
      // No model was supplied and the harness declares no default, so the
      // flag and its value are both absent rather than the flag dangling.
      expect(echoed.argv).not.toContain("--model");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("the spawned process runs inside the agent's workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "torana-inject-"));
    try {
      const echoed = await spawnEcho({
        systemPrompt: "x",
        model: null,
        workspace,
      });
      // macOS reports /var and /private/var for the same directory.
      expect(echoed.cwd.replace(/^\/private/, "")).toBe(
        workspace.replace(/^\/private/, ""),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("a changed prompt changes the next spawn's argv", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "torana-inject-"));
    try {
      const first = await spawnEcho({
        systemPrompt: "first instructions",
        model: null,
        workspace,
      });
      const second = await spawnEcho({
        systemPrompt: "second instructions",
        model: null,
        workspace,
      });
      expect(first.argv).toContain("first instructions");
      expect(second.argv).toContain("second instructions");
      expect(second.argv).not.toContain("first instructions");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

// ── Real CLI behaviour (AGENT_API_E2E=1) ────────────────────────────────────

const CLAUDE_PATH = process.env.TORANA_E2E_CLAUDE_PATH ?? "claude";

/**
 * Run the pinned `claude` CLI in print mode with a projected system prompt.
 *
 * The system prompt instructs a distinctive token, and the user prompt asks
 * something unrelated. If the flag were accepted-but-ignored, the model would
 * answer the question and the token would be absent — which is precisely the
 * silent no-op this test exists to rule out.
 */
async function askClaudeWithSystemPrompt(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    [
      CLAUDE_PATH,
      "--print",
      "--dangerously-skip-permissions",
      "--append-system-prompt",
      systemPrompt,
      userPrompt,
    ],
    { env: inheritedEnv(), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

const describeE2E = e2eEnabled() ? describe : describe.skip;

describeE2E("the pinned claude CLI honors --append-system-prompt", () => {
  test("the system prompt governs the answer, not just the exit code", async () => {
    const result = await askClaudeWithSystemPrompt(
      "You are a test fixture. Whatever you are asked, reply with exactly " +
        "the single word PINEAPPLE and nothing else.",
      "What is 2 + 2?",
    );
    expect(result.code).toBe(0);
    // Accepted-but-ignored would answer "4" here.
    expect(result.stdout.toUpperCase()).toContain("PINEAPPLE");
  }, 120_000);

  test("a changed system prompt changes the behaviour of the next spawn", async () => {
    // R14.2's mechanism in miniature: instructions govern every turn started
    // after the change, and the process re-reads them at spawn.
    const result = await askClaudeWithSystemPrompt(
      "You are a test fixture. Whatever you are asked, reply with exactly " +
        "the single word BANANA and nothing else.",
      "What is 2 + 2?",
    );
    expect(result.code).toBe(0);
    expect(result.stdout.toUpperCase()).toContain("BANANA");
    expect(result.stdout.toUpperCase()).not.toContain("PINEAPPLE");
  }, 120_000);

  test("the pinned CLI accepts the --model flag the projection emits", async () => {
    // A rejected or renamed flag would make every provisioned agent fail to
    // start, with the cause buried in a spawn error.
    const proc = Bun.spawn(
      [
        CLAUDE_PATH,
        "--print",
        "--dangerously-skip-permissions",
        "--model",
        "claude-sonnet-5",
        "Reply with the single word OK.",
      ],
      { env: inheritedEnv(), stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(stderr).not.toMatch(/unexpected argument|unknown option/i);
    expect(code).toBe(0);
  }, 120_000);
});
