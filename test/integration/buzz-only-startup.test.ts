import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { startGateway, type RunningGateway } from "../../src/main.js";
import { findFreePort } from "./fake-telegram.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

let gateway: RunningGateway | null = null;
let dir: string | null = null;

afterEach(async () => {
  await gateway?.shutdown("test");
  gateway = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

test("a disabled Buzz-only v2 agent starts without Telegram transport", async () => {
  dir = mkdtempSync(join(tmpdir(), "torana-buzz-only-"));
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  upgraded.gateway.port = await findFreePort();
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
  upgraded.platforms.telegram.enabled = false;
  upgraded.platforms.buzz.enabled = false;
  upgraded.sessions.scope = "conversation";
  upgraded.agents[0].endpoints = [
    {
      id: "alpha-buzz",
      platform: "buzz",
      enabled: false,
      community_id: "primary",
      relay_url: "wss://relay.example.com",
      private_key: "1".padStart(64, "0"),
      respond_to: "anyone",
    },
  ];
  const loaded = loadConfigFromString(yaml.dump(upgraded), {
    skipInterpolation: true,
  });
  gateway = await startGateway({
    config: loaded.config,
    normalized: loaded.normalized,
    secrets: loaded.secrets,
    autoMigrate: true,
  });

  expect(gateway.transports).toHaveLength(0);
  expect(gateway.registry.botIds).toEqual(["alpha"]);
  const response = await fetch(
    `http://127.0.0.1:${loaded.config.gateway.port}/health`,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    endpoints: Array<{ endpoint_id: string; lifecycle_state: string }>;
  };
  expect(body.endpoints).toContainEqual(
    expect.objectContaining({
      endpoint_id: "alpha-buzz",
      lifecycle_state: "disabled",
    }),
  );
});
