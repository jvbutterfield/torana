import { describe, expect, test } from "bun:test";
import yaml from "js-yaml";

import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const KEY = "61".padStart(64, "0");

function config(tools: Record<string, unknown>, runnerEnv = {}) {
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  upgraded.agents[0].runner.env = runnerEnv;
  upgraded.agents[0].endpoints.push({
    id: "alpha-buzz",
    platform: "buzz",
    enabled: true,
    community_id: "primary",
    relay_url: "wss://relay.example",
    private_key: KEY,
    respond_to: "anyone",
    subscribe: "all_channels",
    reactions: {},
    triggers: {},
    channel_overrides: {},
  });
  upgraded.agents[0].tools = { buzz: tools };
  return yaml.dump(upgraded);
}

describe("Buzz tools v2 configuration", () => {
  test("accepts an exact acknowledged custom policy", () => {
    const loaded = loadConfigFromString(
      config({
        policy: "custom",
        allowed_commands: ["channels.list", "channels.delete"],
        allowed_endpoint_ids: ["alpha-buzz"],
        default_endpoint_id: "alpha-buzz",
        acknowledge_dangerous: true,
      }),
      { skipInterpolation: true },
    );
    expect(loaded.normalized.buzzTools?.[0]).toMatchObject({
      policy: "custom",
      allowedCommands: ["channels.list", "channels.delete"],
    });
  });

  test("rejects unknown, misplaced, and unacknowledged command allowlists", () => {
    expect(() =>
      loadConfigFromString(
        config({
          policy: "custom",
          allowed_commands: ["channels.future"],
          allowed_endpoint_ids: ["alpha-buzz"],
        }),
        { skipInterpolation: true },
      ),
    ).toThrow(/unknown command/);
    expect(() =>
      loadConfigFromString(
        config({
          policy: "collaborate",
          allowed_commands: ["channels.list"],
          allowed_endpoint_ids: ["alpha-buzz"],
        }),
        { skipInterpolation: true },
      ),
    ).toThrow(/only valid with policy: custom/);
    expect(() =>
      loadConfigFromString(
        config({
          policy: "custom",
          allowed_commands: ["channels.delete"],
          allowed_endpoint_ids: ["alpha-buzz"],
        }),
        { skipInterpolation: true },
      ),
    ).toThrow(/acknowledge_dangerous/);
  });

  test("reserves Buzz credential and capability environment variables", () => {
    expect(() =>
      loadConfigFromString(
        config(
          {
            policy: "collaborate",
            allowed_endpoint_ids: ["alpha-buzz"],
          },
          { BUZZ_PRIVATE_KEY: "runner-bypass" },
        ),
        { skipInterpolation: true },
      ),
    ).toThrow(/reserved for Torana's Buzz broker/);
  });

  test("raw-key escape hatch requires acknowledgement and a default endpoint", () => {
    expect(() =>
      loadConfigFromString(
        config({
          policy: "collaborate",
          allowed_endpoint_ids: ["alpha-buzz"],
          expose_private_key_to_runner: true,
          acknowledge_dangerous: true,
        }),
        { skipInterpolation: true },
      ),
    ).toThrow(/requires one explicit default endpoint/);
    expect(() =>
      loadConfigFromString(
        config({
          policy: "collaborate",
          allowed_endpoint_ids: ["alpha-buzz"],
          default_endpoint_id: "alpha-buzz",
          expose_private_key_to_runner: true,
        }),
        { skipInterpolation: true },
      ),
    ).toThrow(/requires acknowledge_dangerous/);
  });
});

// `agent_api.tokens[].buzz_tools` grants ask turns a session-scoped Buzz
// capability. The broker resolves a no-conversation capability from
// `tools.buzz.default_endpoint_id`, so both a missing tools block and a
// tools block without a default endpoint would mint nothing — a silent
// no-op that only surfaces when the agent tries to publish mid-turn. Both
// must fail at config load.
const TOKEN_SECRET = "s".repeat(32);

function configWithToken(
  token: Record<string, unknown>,
  tools: Record<string, unknown> | null,
): string {
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  upgraded.agents[0].endpoints.push({
    id: "alpha-buzz",
    platform: "buzz",
    enabled: true,
    community_id: "primary",
    relay_url: "wss://relay.example",
    private_key: KEY,
    respond_to: "anyone",
    subscribe: "all_channels",
    reactions: {},
    triggers: {},
    channel_overrides: {},
  });
  if (tools) upgraded.agents[0].tools = { buzz: tools };
  upgraded.agent_api = {
    enabled: true,
    tokens: [
      {
        name: "cron",
        secret_ref: TOKEN_SECRET,
        bot_ids: ["alpha"],
        scopes: ["ask"],
        ...token,
      },
    ],
  };
  return yaml.dump(upgraded);
}

describe("agent_api.tokens[].buzz_tools", () => {
  test("defaults to false and resolves onto the loaded token", () => {
    const loaded = loadConfigFromString(configWithToken({}, null), {
      skipInterpolation: true,
    });
    expect(loaded.config.agent_api.tokens[0]?.buzz_tools).toBe(false);
    expect(loaded.agentApiTokens[0]?.buzzTools).toBe(false);
  });

  test("resolves onto the loaded token when granted", () => {
    const loaded = loadConfigFromString(
      configWithToken(
        { buzz_tools: true },
        {
          policy: "collaborate",
          allowed_endpoint_ids: ["alpha-buzz"],
          default_endpoint_id: "alpha-buzz",
        },
      ),
      { skipInterpolation: true },
    );
    expect(loaded.agentApiTokens[0]?.buzzTools).toBe(true);
  });

  test("rejects a grant against an agent with no tools.buzz block", () => {
    expect(() =>
      loadConfigFromString(configWithToken({ buzz_tools: true }, null), {
        skipInterpolation: true,
      }),
    ).toThrow(/buzz_tools requires agent 'alpha' to configure tools\.buzz/);
  });

  test("rejects a grant when tools.buzz names no default endpoint", () => {
    // Legal for managed conversation turns — the endpoint comes from the
    // conversation — but unusable for an Agent API turn, which has none.
    expect(() =>
      loadConfigFromString(
        configWithToken(
          { buzz_tools: true },
          {
            policy: "collaborate",
            allowed_endpoint_ids: ["alpha-buzz"],
          },
        ),
        { skipInterpolation: true },
      ),
    ).toThrow(/buzz_tools requires agent 'alpha' to set/);
  });

  test("reports the failure at the offending bot_ids path", () => {
    try {
      loadConfigFromString(configWithToken({ buzz_tools: true }, null), {
        skipInterpolation: true,
      });
      throw new Error("expected config load to fail");
    } catch (err) {
      expect(String(err)).toContain("agent_api.tokens[0].bot_ids[0]");
    }
  });

  test("an ungranted token against a tools-less agent still loads", () => {
    const loaded = loadConfigFromString(
      configWithToken({ buzz_tools: false }, null),
      { skipInterpolation: true },
    );
    expect(loaded.agentApiTokens[0]?.buzzTools).toBe(false);
  });
});
