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
