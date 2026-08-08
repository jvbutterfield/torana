// US-031 — projection of a provisioned agent record into a real agent.
//
// The load-bearing test in this file is the round-trip: a projected agent block
// must pass the **unchanged** `ConfigV2Schema`. That is R1.2's evidence — the
// claim that Desktop-managed agents cost YAML authors nothing, because no
// validation was relaxed to let them exist. Everything else here guards the
// places where Desktop input meets an operator-authored template.

import { describe, expect, test } from "bun:test";

import { ConfigV2Schema, ProvisioningSchema } from "../../src/config/v2.js";
import {
  fillPlaceholders,
  instructionVersionOf,
  parseRequestedTimeouts,
  projectAgentBlock,
  projectInstructions,
  projectRunner,
  ProjectionError,
} from "../../src/platform/buzz/provisioned-agents.js";

function provisioning(overrides: Record<string, unknown> = {}) {
  return ProvisioningSchema.parse({
    harnesses: {
      claude: {
        runner: {
          type: "claude-code",
          cli_path: "/usr/local/bin/claude",
          args: [
            "--model",
            "{model}",
            "--append-system-prompt",
            "{system_prompt}",
          ],
          env: { CLAUDE_CONFIG_DIR: "/data/provisioned/{agent_id}/claude" },
          acknowledge_dangerous: true,
        },
        defaults: { model: "claude-sonnet-5" },
        ceilings: {
          turn_timeout_secs: 3600,
          idle_timeout_secs: 86_400,
          max_turn_duration_secs: 3600,
        },
        max_system_prompt_bytes: 64,
      },
    },
    ...overrides,
  });
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    harness: "claude",
    systemPrompt: "be terse",
    model: null as string | null,
    timeoutsJson: "{}",
    ...overrides,
  };
}

describe("timeout clamping (R11.3 / R14.6)", () => {
  test("an omitted timeout runs at the harness ceiling and is not a clamp", () => {
    const projected = projectInstructions(row(), provisioning());
    expect(projected.applied.turnTimeoutSecs).toBe(3600);
    // "No opinion" is not the same as "asked for something I refused".
    expect(projected.clamped).toEqual([]);
  });

  test("a value inside the range is applied verbatim", () => {
    const projected = projectInstructions(
      row({ timeoutsJson: JSON.stringify({ turn_timeout_seconds: 900 }) }),
      provisioning(),
    );
    expect(projected.applied.turnTimeoutSecs).toBe(900);
    expect(projected.clamped).toEqual([]);
  });

  test("a value above the ceiling clamps down and is reported", () => {
    const projected = projectInstructions(
      row({ timeoutsJson: JSON.stringify({ turn_timeout_seconds: 99_999 }) }),
      provisioning(),
    );
    expect(projected.applied.turnTimeoutSecs).toBe(3600);
    expect(projected.clamped).toEqual([
      {
        field: "turn_timeout_seconds",
        requested: 99_999,
        applied: 3600,
        reason: "above_ceiling",
      },
    ]);
  });

  test("a value below the 30s floor clamps up and is reported", () => {
    const projected = projectInstructions(
      row({ timeoutsJson: JSON.stringify({ turn_timeout_seconds: 1 }) }),
      provisioning(),
    );
    expect(projected.applied.turnTimeoutSecs).toBe(30);
    expect(projected.clamped[0]?.reason).toBe("below_floor");
  });

  test("exactly at the floor and exactly at the ceiling are both untouched", () => {
    const atFloor = projectInstructions(
      row({ timeoutsJson: JSON.stringify({ turn_timeout_seconds: 30 }) }),
      provisioning(),
    );
    const atCeiling = projectInstructions(
      row({ timeoutsJson: JSON.stringify({ turn_timeout_seconds: 3600 }) }),
      provisioning(),
    );
    expect(atFloor.clamped).toEqual([]);
    expect(atCeiling.clamped).toEqual([]);
  });

  test("all three timeouts clamp independently", () => {
    const projected = projectInstructions(
      row({
        timeoutsJson: JSON.stringify({
          turn_timeout_seconds: 99_999,
          idle_timeout_seconds: 5,
          max_turn_duration_seconds: 1200,
        }),
      }),
      provisioning(),
    );
    expect(projected.applied).toEqual({
      turnTimeoutSecs: 3600,
      idleTimeoutSecs: 30,
      maxTurnDurationSecs: 1200,
    });
    expect(projected.clamped.map((c) => c.field).sort()).toEqual([
      "idle_timeout_seconds",
      "turn_timeout_seconds",
    ]);
  });

  test("rejects a non-numeric timeout rather than coercing it", () => {
    expect(() =>
      projectInstructions(
        row({ timeoutsJson: JSON.stringify({ turn_timeout_seconds: "900" }) }),
        provisioning(),
      ),
    ).toThrow(ProjectionError);
  });

  test("rejects malformed stored JSON", () => {
    expect(() => parseRequestedTimeouts("not json")).toThrow(ProjectionError);
    expect(() => parseRequestedTimeouts("[1,2]")).toThrow(ProjectionError);
  });
});

describe("instruction version (R3.6)", () => {
  test("two deploys differing only in a clamped excess agree", () => {
    // Both clamp to 3600, so the agent is running identical instructions and
    // the version must say so rather than churning on request noise.
    const a = projectInstructions(
      row({ timeoutsJson: JSON.stringify({ turn_timeout_seconds: 99_999 }) }),
      provisioning(),
    );
    const b = projectInstructions(
      row({ timeoutsJson: JSON.stringify({ turn_timeout_seconds: 50_000 }) }),
      provisioning(),
    );
    expect(a.instructionVersion).toBe(b.instructionVersion);
  });

  test("a changed prompt changes the version", () => {
    const a = projectInstructions(row(), provisioning());
    const b = projectInstructions(
      row({ systemPrompt: "be verbose" }),
      provisioning(),
    );
    expect(a.instructionVersion).not.toBe(b.instructionVersion);
  });

  test("a changed model changes the version", () => {
    const a = projectInstructions(row(), provisioning());
    const b = projectInstructions(
      row({ model: "claude-opus-5" }),
      provisioning(),
    );
    expect(a.instructionVersion).not.toBe(b.instructionVersion);
  });

  test("a harness ceiling edit changes the version of an unchanged row", () => {
    // The row did not move, but what the agent actually runs did. A digest
    // that stayed put here would misreport a live agent.
    const before = projectInstructions(row(), provisioning());
    const after = projectInstructions(
      row(),
      provisioning({
        harnesses: {
          claude: {
            runner: {
              type: "claude-code",
              cli_path: "/usr/local/bin/claude",
              args: [],
              acknowledge_dangerous: true,
            },
            ceilings: {
              turn_timeout_secs: 1800,
              idle_timeout_secs: 86_400,
              max_turn_duration_secs: 1800,
            },
          },
        },
      }),
    );
    expect(after.instructionVersion).not.toBe(before.instructionVersion);
  });

  test("is stable across calls and 12 hex chars", () => {
    const version = instructionVersionOf({
      harness: "claude",
      systemPrompt: "x",
      modelApplied: "m",
      applied: {
        turnTimeoutSecs: 1,
        idleTimeoutSecs: 2,
        maxTurnDurationSecs: 3,
      },
    });
    expect(version).toMatch(/^[0-9a-f]{12}$/);
    expect(
      instructionVersionOf({
        harness: "claude",
        systemPrompt: "x",
        modelApplied: "m",
        applied: {
          turnTimeoutSecs: 1,
          idleTimeoutSecs: 2,
          maxTurnDurationSecs: 3,
        },
      }),
    ).toBe(version);
  });

  test("field values cannot be shuffled between slots without changing it", () => {
    // Guards against a canonicalization that concatenates without separators.
    const a = instructionVersionOf({
      harness: "claude",
      systemPrompt: "ab",
      modelApplied: "c",
      applied: {
        turnTimeoutSecs: 1,
        idleTimeoutSecs: 2,
        maxTurnDurationSecs: 3,
      },
    });
    const b = instructionVersionOf({
      harness: "claude",
      systemPrompt: "a",
      modelApplied: "bc",
      applied: {
        turnTimeoutSecs: 1,
        idleTimeoutSecs: 2,
        maxTurnDurationSecs: 3,
      },
    });
    expect(a).not.toBe(b);
  });
});

describe("harness allowlist and prompt size (R7.2)", () => {
  test("refuses a harness that is not allowlisted, listing what is", () => {
    try {
      projectInstructions(row({ harness: "goose" }), provisioning());
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectionError);
      expect((error as ProjectionError).code).toBe("unknown_harness");
      expect((error as Error).message).toContain("claude");
    }
  });

  test("refuses an oversized system prompt", () => {
    const long = "x".repeat(65);
    expect(() =>
      projectInstructions(row({ systemPrompt: long }), provisioning()),
    ).toThrow(/65 bytes/);
  });

  test("prompt size is measured in bytes, not code points", () => {
    // 20 emoji: 40 UTF-16 units but 80 bytes, so it is under the cap by
    // string length and over it by the measure that actually matters.
    const emoji = "🙂".repeat(20);
    expect(emoji.length).toBeLessThan(64);
    expect(() =>
      projectInstructions(row({ systemPrompt: emoji }), provisioning()),
    ).toThrow(/prompt/);
  });

  test("falls back to the harness default model when the row has none", () => {
    expect(projectInstructions(row(), provisioning()).modelApplied).toBe(
      "claude-sonnet-5",
    );
  });

  test("treats an empty model string as unset", () => {
    expect(
      projectInstructions(row({ model: "   " }), provisioning()).modelApplied,
    ).toBe("claude-sonnet-5");
  });
});

describe("placeholder substitution (D4 / R7.3)", () => {
  test("fills every documented placeholder", () => {
    expect(
      fillPlaceholders("{agent_id}:{model}:{workspace}", {
        model: "m",
        system_prompt: "p",
        agent_id: "a",
        workspace: "/w",
      }),
    ).toBe("a:m:/w");
  });

  test("does not re-expand a placeholder that appears inside a value", () => {
    // The prompt is attacker-adjacent text; a second pass would let it reach
    // another placeholder's value.
    expect(
      fillPlaceholders("{system_prompt}", {
        model: "SECRET-MODEL",
        system_prompt: "{model}",
        agent_id: "a",
        workspace: "/w",
      }),
    ).toBe("{model}");
  });

  test("leaves an unknown placeholder alone rather than emptying it", () => {
    expect(
      fillPlaceholders("{nope}", {
        model: "m",
        system_prompt: "p",
        agent_id: "a",
        workspace: "/w",
      }),
    ).toBe("{nope}");
  });

  test("a Desktop value cannot add an argv element", () => {
    // The classic injection attempt: a prompt containing what looks like a
    // flag stays exactly one argv element.
    const runner = projectRunner({
      agentId: "canary",
      workspace: "/w",
      instructions: projectInstructions(
        row({ systemPrompt: "--dangerous x" }),
        provisioning(),
      ),
      provisioning: provisioning(),
    });
    expect(runner.args).toEqual([
      "--model",
      "claude-sonnet-5",
      "--append-system-prompt",
      "--dangerous x",
    ]);
  });

  test("drops the flag as well when its value resolves to nothing", () => {
    // A bare `--append-system-prompt` with no value would consume whatever
    // followed it on the command line.
    const withoutPrompt = provisioning();
    const runner = projectRunner({
      agentId: "canary",
      workspace: "/w",
      instructions: projectInstructions(
        row({ systemPrompt: "" }),
        withoutPrompt,
      ),
      provisioning: withoutPrompt,
    });
    expect(runner.args).toEqual(["--model", "claude-sonnet-5"]);
  });

  test("fills placeholders in env values and derives cwd from the workspace", () => {
    const runner = projectRunner({
      agentId: "canary",
      workspace: "/data/workspaces/canary",
      instructions: projectInstructions(row(), provisioning()),
      provisioning: provisioning(),
    });
    expect(runner.env.CLAUDE_CONFIG_DIR).toBe(
      "/data/provisioned/canary/claude",
    );
    expect(runner.cwd).toBe("/data/workspaces/canary");
  });
});

// ── R1.2 evidence ───────────────────────────────────────────────────────────

const BASE_CONFIG = {
  version: 2 as const,
  gateway: { port: 3000, bind_host: "127.0.0.1", data_dir: "./data" },
  platforms: {
    telegram: { enabled: false, delivery: { default_mode: "polling" } },
    buzz: { enabled: true },
  },
  access_control: { default_policy: "deny", allowed_user_ids: [] },
  sessions: { scope: "conversation" },
  limits: {},
  retention: {},
  worker_tuning: {},
  streaming: {},
  outbox: {},
  shutdown: {},
  dashboard: {},
  metrics: { enabled: true },
  attachments: {},
  agent_api: { enabled: false, tokens: [] },
  publisher_api: {},
  agents: [
    {
      id: "yamlbot",
      runner: { type: "codex", cli_path: "codex" },
      endpoints: [
        {
          id: "yamlbot-buzz",
          platform: "buzz",
          enabled: false,
          community_id: "primary",
          relay_url: "wss://relay.example",
          private_key:
            "0000000000000000000000000000000000000000000000000000000000000001",
          owner_pubkey:
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
          respond_to: "owner_only",
          subscribe: "mentions_and_dms",
        },
      ],
    },
  ],
};

function endpointBlock(agentId: string, privateKey: string) {
  return {
    id: `${agentId}-buzz`,
    platform: "buzz",
    enabled: true,
    community_id: "primary",
    relay_url: "wss://relay.example",
    private_key: privateKey,
    owner_pubkey:
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    respond_to: "owner_only",
    subscribe: "mentions_and_dms",
  };
}

describe("projected agents pass the unchanged ConfigV2Schema (R1.2)", () => {
  test("a claude-code projection parses alongside a YAML agent", () => {
    const block = projectAgentBlock({
      agentId: "canary",
      workspace: "/data/workspaces/canary",
      instructions: projectInstructions(row(), provisioning()),
      provisioning: provisioning(),
      endpointBlock: endpointBlock(
        "canary",
        "0000000000000000000000000000000000000000000000000000000000000002",
      ),
    });
    const draft = {
      ...BASE_CONFIG,
      agents: [...BASE_CONFIG.agents, block],
    };
    const parsed = ConfigV2Schema.safeParse(draft);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    }
    const projected = parsed.data.agents.find((a) => a.id === "canary");
    expect(projected?.runner.type).toBe("claude-code");
    expect(projected?.endpoints).toHaveLength(1);
    // The YAML agent is untouched by the projection (R1.3).
    expect(parsed.data.agents.find((a) => a.id === "yamlbot")).toBeDefined();
  });

  test("every allowlisted runner type round-trips", () => {
    const harnessMatrix = ProvisioningSchema.parse({
      harnesses: {
        claude: {
          runner: {
            type: "claude-code",
            cli_path: "claude",
            args: ["--model", "{model}"],
            acknowledge_dangerous: true,
          },
          ceilings: {
            turn_timeout_secs: 600,
            idle_timeout_secs: 600,
            max_turn_duration_secs: 600,
          },
        },
        codex: {
          runner: { type: "codex", cli_path: "codex", args: [] },
          ceilings: {
            turn_timeout_secs: 600,
            idle_timeout_secs: 600,
            max_turn_duration_secs: 600,
          },
        },
        custom: {
          runner: {
            type: "command",
            cli_path: "/bin/echo",
            args: ["{agent_id}"],
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

    const keys = [
      "0000000000000000000000000000000000000000000000000000000000000003",
      "0000000000000000000000000000000000000000000000000000000000000004",
      "0000000000000000000000000000000000000000000000000000000000000005",
    ];
    const blocks = ["claude", "codex", "custom"].map((harness, index) =>
      projectAgentBlock({
        agentId: `agent-${harness}`,
        workspace: `/data/workspaces/agent-${harness}`,
        instructions: projectInstructions(row({ harness }), harnessMatrix),
        provisioning: harnessMatrix,
        endpointBlock: endpointBlock(`agent-${harness}`, keys[index]),
      }),
    );

    const parsed = ConfigV2Schema.safeParse({
      ...BASE_CONFIG,
      agents: [...BASE_CONFIG.agents, ...blocks],
    });
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    }
    const types = parsed.data.agents
      .filter((a) => a.id.startsWith("agent-"))
      .map((a) => a.runner.type)
      .sort();
    expect(types).toEqual(["claude-code", "codex", "command"]);
  });

  test("the projection carries the gateway Buzz tool default, not a Desktop one", () => {
    const withPolicy = provisioning({
      buzz_tools_default: { policy: "read_only" },
    });
    const block = projectAgentBlock({
      agentId: "canary",
      workspace: "/w",
      instructions: projectInstructions(row(), withPolicy),
      provisioning: withPolicy,
      endpointBlock: endpointBlock(
        "canary",
        "0000000000000000000000000000000000000000000000000000000000000006",
      ),
    });
    const parsed = ConfigV2Schema.safeParse({
      ...BASE_CONFIG,
      agents: [...BASE_CONFIG.agents, block],
    });
    expect(parsed.success).toBe(true);
    const tools = parsed.success
      ? parsed.data.agents.find((a) => a.id === "canary")?.tools?.buzz
      : undefined;
    expect(tools?.policy).toBe("read_only");
    expect(tools?.default_endpoint_id).toBe("canary-buzz");
  });
});
