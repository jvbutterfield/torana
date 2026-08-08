// US-030 — `provisioning` configuration and the wildcard admin-token scope.
//
// Weighted toward rejection cases on purpose. Every field here is a gate that
// only ever fires on malformed operator input, so a suite that proves the
// happy path proves almost nothing: the interesting question is whether a
// typo'd placeholder, a zero grace period, or a wildcard on the wrong token is
// caught at load time rather than at 3am on a delete.

import { describe, expect, test } from "bun:test";

import { ConfigV2Schema, ProvisioningSchema } from "../../src/config/v2.js";
import { loadConfigFromString } from "../../src/config/load.js";

function harness(overrides: Record<string, unknown> = {}) {
  return {
    runner: {
      type: "claude-code",
      cli_path: "/usr/local/bin/claude",
      args: ["--model", "{model}", "--append-system-prompt", "{system_prompt}"],
      env: { CLAUDE_CONFIG_DIR: "/data/provisioned/{agent_id}/claude" },
      acknowledge_dangerous: true,
    },
    defaults: { model: "claude-sonnet-5" },
    ceilings: {
      turn_timeout_secs: 3600,
      idle_timeout_secs: 86_400,
      max_turn_duration_secs: 3600,
    },
    max_system_prompt_bytes: 65_536,
    ...overrides,
  };
}

function provisioning(overrides: Record<string, unknown> = {}) {
  return { harnesses: { claude: harness() }, ...overrides };
}

describe("provisioning config", () => {
  test("accepts the documented block and applies the plan's defaults", () => {
    const parsed = ProvisioningSchema.parse(provisioning());
    expect(parsed.max_agents).toBe(8);
    expect(parsed.delete_grace_hours).toBe(72);
    expect(parsed.min_free_bytes).toBe(1_073_741_824);
    // D5: the fleet default must be the least-privileged profile, so an
    // operator who omits it does not hand every provisioned agent write access.
    expect(parsed.buzz_tools_default.policy).toBe("read_only");
    expect(parsed.buzz_tools_default.acknowledge_dangerous).toBe(false);
  });

  test("rejects a misspelled placeholder in args", () => {
    const bad = provisioning({
      harnesses: {
        claude: harness({
          runner: {
            type: "claude-code",
            cli_path: "claude",
            acknowledge_dangerous: true,
            // A typo here would otherwise reach the process verbatim and the
            // agent would run with the literal string as its prompt.
            args: ["--append-system-prompt", "{sytem_prompt}"],
            env: {},
          },
        }),
      },
    });
    const result = ProvisioningSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("{sytem_prompt}");
  });

  test("rejects an unknown placeholder in env values", () => {
    const bad = provisioning({
      harnesses: {
        claude: harness({
          runner: {
            type: "claude-code",
            cli_path: "claude",
            acknowledge_dangerous: true,
            args: [],
            env: { HOME: "/data/{workspaces}" },
          },
        }),
      },
    });
    const result = ProvisioningSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("{workspaces}");
  });

  test("accepts every documented placeholder", () => {
    const ok = provisioning({
      harnesses: {
        claude: harness({
          runner: {
            type: "claude-code",
            cli_path: "claude",
            acknowledge_dangerous: true,
            args: ["{model}", "{system_prompt}", "{agent_id}", "{workspace}"],
            env: { W: "{workspace}", A: "{agent_id}" },
          },
        }),
      },
    });
    expect(ProvisioningSchema.safeParse(ok).success).toBe(true);
  });

  test("rejects delete_grace_hours of 0 — instant purge is never an intent", () => {
    const result = ProvisioningSchema.safeParse(
      provisioning({ delete_grace_hours: 0 }),
    );
    expect(result.success).toBe(false);
  });

  test("accepts the minimum grace period of 1 hour", () => {
    expect(
      ProvisioningSchema.safeParse(provisioning({ delete_grace_hours: 1 }))
        .success,
    ).toBe(true);
  });

  test("rejects max_agents below 1", () => {
    expect(
      ProvisioningSchema.safeParse(provisioning({ max_agents: 0 })).success,
    ).toBe(false);
  });

  test("rejects a harness whose runner type is not a known runner", () => {
    const result = ProvisioningSchema.safeParse(
      provisioning({
        harnesses: {
          claude: harness({
            runner: { type: "goose", cli_path: "goose", args: [], env: {} },
          }),
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  test("rejects a ceiling below the 30s floor", () => {
    const result = ProvisioningSchema.safeParse(
      provisioning({
        harnesses: {
          claude: harness({
            ceilings: {
              turn_timeout_secs: 29,
              idle_timeout_secs: 86_400,
              max_turn_duration_secs: 3600,
            },
          }),
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  test("accepts a ceiling exactly at the 30s floor", () => {
    const result = ProvisioningSchema.safeParse(
      provisioning({
        harnesses: {
          claude: harness({
            ceilings: {
              turn_timeout_secs: 30,
              idle_timeout_secs: 30,
              max_turn_duration_secs: 30,
            },
          }),
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  test("rejects max_turn_duration below turn_timeout", () => {
    const result = ProvisioningSchema.safeParse(
      provisioning({
        harnesses: {
          claude: harness({
            ceilings: {
              turn_timeout_secs: 3600,
              idle_timeout_secs: 86_400,
              // A turn allowed 3600s cannot live inside a 600s duration cap.
              max_turn_duration_secs: 600,
            },
          }),
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "max_turn_duration_secs",
    );
  });

  test("rejects an oversized max_system_prompt_bytes", () => {
    expect(
      ProvisioningSchema.safeParse(
        provisioning({
          harnesses: {
            claude: harness({ max_system_prompt_bytes: 1_048_577 }),
          },
        }),
      ).success,
    ).toBe(false);
  });

  test("rejects an empty harness allowlist", () => {
    const result = ProvisioningSchema.safeParse({ harnesses: {} });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("at least one");
  });

  test("rejects an unknown key — the block is strict", () => {
    expect(
      ProvisioningSchema.safeParse(provisioning({ max_agent: 4 })).success,
    ).toBe(false);
  });

  test("rejects a claude-code harness that does not acknowledge the danger", () => {
    // The claude-code runner always passes --dangerously-skip-permissions, so
    // every turn is unsandboxed in the agent's workspace. A YAML author has to
    // acknowledge that explicitly; a provisioned agent must not get a quieter
    // deal, and Torana must not tick the box on the operator's behalf.
    const result = ProvisioningSchema.safeParse(
      provisioning({
        harnesses: {
          claude: harness({
            runner: {
              type: "claude-code",
              cli_path: "claude",
              args: [],
              env: {},
            },
          }),
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "acknowledge_dangerous",
    );
  });

  test("rejects a command harness with no protocol", () => {
    const result = ProvisioningSchema.safeParse(
      provisioning({
        harnesses: {
          custom: harness({
            runner: { type: "command", cli_path: "/bin/echo", args: [] },
          }),
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("protocol");
  });

  test("accepts a command harness that declares its protocol", () => {
    expect(
      ProvisioningSchema.safeParse(
        provisioning({
          harnesses: {
            custom: harness({
              runner: {
                type: "command",
                cli_path: "/bin/echo",
                args: [],
                protocol: "jsonl-text",
              },
            }),
          },
        }),
      ).success,
    ).toBe(true);
  });

  test("rejects command-only fields on a non-command harness", () => {
    for (const field of [
      "protocol",
      "process_model",
      "resume_model",
    ] as const) {
      const value =
        field === "protocol"
          ? "jsonl-text"
          : field === "process_model"
            ? "resident"
            : "stable_session_id";
      const result = ProvisioningSchema.safeParse(
        provisioning({
          harnesses: {
            claude: harness({
              runner: {
                type: "claude-code",
                cli_path: "claude",
                args: [],
                acknowledge_dangerous: true,
                [field]: value,
              },
            }),
          },
        }),
      );
      expect(result.success).toBe(false);
    }
  });

  test("rejects a harness name that is not a safe identifier", () => {
    expect(
      ProvisioningSchema.safeParse({
        harnesses: { "../escape": harness() },
      }).success,
    ).toBe(false);
  });
});

const V2_BASE = `
version: 2
gateway: { port: 3000, bind_host: 127.0.0.1, data_dir: ./data }
platforms:
  telegram: { enabled: false, delivery: { default_mode: polling } }
  buzz: { enabled: false }
access_control: { default_policy: deny, allowed_user_ids: [] }
sessions: { scope: conversation }
limits: {}
retention: {}
worker_tuning: {}
streaming: {}
outbox: {}
shutdown: {}
dashboard: {}
metrics: { enabled: true }
attachments: {}
agents:
  - id: buzzbot
    runner: { type: codex, cli_path: codex }
    endpoints:
      - id: buzzbot-buzz
        platform: buzz
        enabled: false
        community_id: primary
        relay_url: wss://relay.example
        private_key: '0000000000000000000000000000000000000000000000000000000000000001'
        owner_pubkey: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
        respond_to: owner_only
        subscribe: mentions_and_dms
`;

function withAgentApi(tokens: string): string {
  return `${V2_BASE}\nagent_api:\n  enabled: true\n  tokens:\n${tokens}\n`;
}

describe("wildcard endpoints:admin token", () => {
  test("accepts bot_ids ['*'] when endpoints:admin is the sole scope", () => {
    const raw = withAgentApi(
      `    - name: provisioner\n      secret_ref: '0123456789abcdef0123456789abcdef0123'\n      bot_ids: ['*']\n      scopes: [endpoints:admin]`,
    );
    expect(() => loadConfigFromString(raw)).not.toThrow();
  });

  test("rejects bot_ids ['*'] on a token that also has another scope", () => {
    // Guarded by the same exclusivity rule the schema already enforced; this
    // asserts the wildcard cannot be smuggled onto a messaging token.
    const raw = withAgentApi(
      `    - name: mixed\n      secret_ref: '0123456789abcdef0123456789abcdef0123'\n      bot_ids: ['*']\n      scopes: [endpoints:admin, ask]`,
    );
    expect(() => loadConfigFromString(raw)).toThrow();
  });

  test("rejects bot_ids ['*'] on an ask-only token", () => {
    const raw = withAgentApi(
      `    - name: asker\n      secret_ref: '0123456789abcdef0123456789abcdef0123'\n      bot_ids: ['*']\n      scopes: [ask]`,
    );
    expect(() => loadConfigFromString(raw)).toThrow(
      /only when the token's sole scope is endpoints:admin/,
    );
  });

  test("a real bot id alongside the wildcard is still validated", () => {
    const raw = withAgentApi(
      `    - name: provisioner\n      secret_ref: '0123456789abcdef0123456789abcdef0123'\n      bot_ids: ['*', nosuchbot]\n      scopes: [endpoints:admin]`,
    );
    expect(() => loadConfigFromString(raw)).toThrow(/unknown bot 'nosuchbot'/);
  });

  test("an asterisk inside an otherwise valid id is not a wildcard", () => {
    const raw = withAgentApi(
      `    - name: provisioner\n      secret_ref: '0123456789abcdef0123456789abcdef0123'\n      bot_ids: ['buzz*bot']\n      scopes: [endpoints:admin]`,
    );
    expect(() => loadConfigFromString(raw)).toThrow();
  });
});

describe("provisioning is optional", () => {
  test("a config with no provisioning block still validates (R1.3)", () => {
    const raw = `${V2_BASE}\nagent_api: { enabled: false, tokens: [] }\n`;
    expect(() => loadConfigFromString(raw)).not.toThrow();
  });

  test("ConfigV2Schema still rejects an unknown top-level key", () => {
    // Guards the `.strict()` that makes the optional field safe to add: a
    // typo'd `provisionning:` must fail loudly rather than be ignored.
    const result = ConfigV2Schema.safeParse({
      version: 2,
      provisionning: {},
    });
    expect(result.success).toBe(false);
  });
});
