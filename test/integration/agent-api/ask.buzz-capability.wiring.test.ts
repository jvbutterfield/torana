// Does the *real* gateway hand the Buzz broker to the Agent API?
//
// test/agent-api/ask.buzz-capability.test.ts covers the capability lifecycle,
// but it constructs the pool, broker, and routes by hand — so it would stay
// green if main.ts stopped passing `buzzBroker` into registerAgentApiRoutes
// entirely. This test starts the gateway the way production does and asserts
// an ask turn can still resolve a capability, which is the one thing that
// wiring line buys.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import { loadConfigFromString } from "../../../src/config/load.js";
import { upgradeV1Object } from "../../../src/config/v2.js";
import { startGateway, type RunningGateway } from "../../../src/main.js";
import { findFreePort } from "../fake-telegram.js";
import { makeTestBotConfig, makeTestConfig } from "../../fixtures/bots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// A `command` runner speaking claude-ndjson: side-session capable, and it
// takes no injected protocol flags, so the mock's argv survives intact.
const MOCK = resolve(__dirname, "../../runner/fixtures/command-ndjson-mock.ts");
const SECRET = "wiring-buzz-token-0123456789abcdef";

let gateway: RunningGateway | null = null;
let dir: string | null = null;

afterEach(async () => {
  await gateway?.shutdown("test");
  gateway = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

test("a granted ask turn resolves a Buzz capability through the real gateway", async () => {
  dir = mkdtempSync(join(tmpdir(), "torana-buzz-wiring-"));
  const bot = makeTestBotConfig("alpha", {
    runner: {
      type: "command" as const,
      cmd: ["bun", "run", MOCK, "buzz-probe"],
      protocol: "claude-ndjson" as const,
      env: {},
      on_reset: "restart" as const,
    },
  });
  const upgraded = upgradeV1Object(makeTestConfig([bot])) as any;
  const port = await findFreePort();
  upgraded.gateway.port = port;
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
  // No Telegram transport, and the Buzz platform stays off so no relay
  // connection is attempted — the credential broker is independent of
  // transport liveness, which is precisely why an ask turn can publish
  // through it.
  upgraded.platforms.telegram.enabled = false;
  upgraded.platforms.buzz.enabled = true;
  upgraded.agents[0].endpoints.push({
    id: "alpha-buzz",
    platform: "buzz",
    enabled: true,
    community_id: "primary",
    relay_url: "wss://relay.invalid",
    private_key: "81".padStart(64, "0"),
    respond_to: "anyone",
    subscribe: "all_channels",
    reactions: {},
    triggers: {},
    channel_overrides: {},
  });
  upgraded.agents[0].tools = {
    buzz: {
      policy: "collaborate",
      allowed_commands: [],
      default_endpoint_id: "alpha-buzz",
      allowed_endpoint_ids: ["alpha-buzz"],
      expose_private_key_to_runner: false,
      acknowledge_dangerous: false,
    },
  };
  upgraded.agent_api = {
    enabled: true,
    tokens: [
      {
        name: "granted",
        secret_ref: SECRET,
        bot_ids: ["alpha"],
        scopes: ["ask"],
        buzz_tools: true,
      },
    ],
  };

  const loaded = loadConfigFromString(yaml.dump(upgraded), {
    skipInterpolation: true,
  });
  gateway = await startGateway({
    config: loaded.config,
    normalized: loaded.normalized,
    secrets: loaded.secrets,
    autoMigrate: true,
    agentApiTokens: loaded.agentApiTokens,
  });

  const r = await fetch(`http://127.0.0.1:${port}/v1/bots/alpha/ask`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "digest", timeout_ms: 10_000 }),
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { text: string; session_id: string };

  // The subprocess resolved the capability the same way the CLI shim does.
  expect(body.text).toContain("capability=yes");
  expect(body.text).toContain(`session=${body.session_id}`);

  // ...and it did not outlive the turn.
  const capabilityDir = resolve(dir, "buzz-broker", "capabilities");
  expect(existsSync(join(capabilityDir, `${body.session_id}.json`))).toBe(
    false,
  );
  expect(readdirSync(capabilityDir).filter((f) => f.endsWith(".json"))).toEqual(
    [],
  );
}, 30_000);
