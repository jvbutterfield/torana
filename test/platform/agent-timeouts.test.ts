// US-032 — per-agent timeout overrides (R11.3 / R14.6).
//
// The interesting property is the fallback: a lookup miss must mean "use the
// gateway default", not "no timeout" and not "zero". Every YAML agent is a
// lookup miss, so getting that wrong would either strip the timeout from every
// existing agent or cancel their turns instantly.

import { describe, expect, test } from "bun:test";

import { AgentTimeoutRegistry } from "../../src/platform/buzz/agent-timeouts.js";
import { ProvisioningSchema } from "../../src/config/v2.js";
import { projectInstructions } from "../../src/platform/buzz/provisioned-agents.js";

const GATEWAY_DEFAULT_MS = 60_000;

function applied(turnTimeoutSecs: number) {
  return {
    turnTimeoutSecs,
    idleTimeoutSecs: 3600,
    maxTurnDurationSecs: turnTimeoutSecs,
  };
}

describe("AgentTimeoutRegistry", () => {
  test("an unknown agent falls back to the gateway default", () => {
    // Every YAML agent takes this path.
    const registry = new AgentTimeoutRegistry();
    expect(registry.turnTimeoutMsFor("yamlbot", GATEWAY_DEFAULT_MS)).toBe(
      GATEWAY_DEFAULT_MS,
    );
    expect(registry.get("yamlbot")).toBeNull();
  });

  test("a provisioned agent uses its own clamped timeout", () => {
    const registry = new AgentTimeoutRegistry();
    registry.set("canary", applied(900));
    expect(registry.turnTimeoutMsFor("canary", GATEWAY_DEFAULT_MS)).toBe(
      900_000,
    );
  });

  test("overrides are per agent and do not leak between them", () => {
    const registry = new AgentTimeoutRegistry();
    registry.set("one", applied(120));
    registry.set("two", applied(240));
    expect(registry.turnTimeoutMsFor("one", GATEWAY_DEFAULT_MS)).toBe(120_000);
    expect(registry.turnTimeoutMsFor("two", GATEWAY_DEFAULT_MS)).toBe(240_000);
    expect(registry.turnTimeoutMsFor("three", GATEWAY_DEFAULT_MS)).toBe(
      GATEWAY_DEFAULT_MS,
    );
  });

  test("re-setting replaces rather than accumulating", () => {
    // An instruction change re-projects the agent; the new value must win.
    const registry = new AgentTimeoutRegistry();
    registry.set("canary", applied(120));
    registry.set("canary", applied(600));
    expect(registry.turnTimeoutMsFor("canary", GATEWAY_DEFAULT_MS)).toBe(
      600_000,
    );
    expect(registry.size).toBe(1);
  });

  test("a removed agent falls back again rather than keeping a stale value", () => {
    // Purge, or a create that unwound. A stale entry would apply one agent's
    // timeout to whatever later took its id.
    const registry = new AgentTimeoutRegistry();
    registry.set("canary", applied(120));
    expect(registry.delete("canary")).toBe(true);
    expect(registry.turnTimeoutMsFor("canary", GATEWAY_DEFAULT_MS)).toBe(
      GATEWAY_DEFAULT_MS,
    );
    expect(registry.delete("canary")).toBe(false);
  });
});

describe("the value the registry receives is the clamped one", () => {
  test("a request above the ceiling is stored clamped, not as requested", () => {
    // The registry must never carry the raw Desktop value: that is the whole
    // point of a Torana-side ceiling.
    const provisioning = ProvisioningSchema.parse({
      harnesses: {
        claude: {
          runner: {
            type: "claude-code",
            cli_path: "claude",
            args: [],
            acknowledge_dangerous: true,
          },
          ceilings: {
            turn_timeout_secs: 300,
            idle_timeout_secs: 300,
            max_turn_duration_secs: 300,
          },
        },
      },
    });
    const projected = projectInstructions(
      {
        harness: "claude",
        systemPrompt: "",
        model: null,
        timeoutsJson: JSON.stringify({ turn_timeout_seconds: 99_999 }),
      },
      provisioning,
    );
    const registry = new AgentTimeoutRegistry();
    registry.set("canary", projected.applied);
    expect(registry.turnTimeoutMsFor("canary", GATEWAY_DEFAULT_MS)).toBe(
      300_000,
    );
  });
});
