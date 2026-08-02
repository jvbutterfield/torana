import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfigFromString } from "../../src/config/load.js";
import {
  createOwnerAuthTag,
  decodeSecret,
  publicKey,
} from "../../src/platform/buzz/protocol.js";

const OWNER = decodeSecret("71".padStart(64, "0"));
const OWNER_PUBKEY = publicKey(OWNER);

function credential(index: number): { key: string; tag: string } {
  const key = String(71 + index).padStart(64, "0");
  const tag = JSON.stringify(
    createOwnerAuthTag(OWNER, publicKey(decodeSecret(key)), "kind=9"),
  );
  return { key, tag };
}

function example(path: string): string {
  return readFileSync(resolve(import.meta.dir, "../../examples", path), "utf8");
}

test("Buzz-only example is valid, secret-free, and disabled by default", () => {
  const source = example("buzz-agent/torana.yaml");
  const c = credential(1);
  const loaded = loadConfigFromString(source, {
    env: {
      PORT: "3000",
      BIND_HOST: "127.0.0.1",
      AGENT_WORKSPACE: "/tmp/buzzbot",
      CODEX_HOME: "/tmp/codex/buzzbot",
      BUZZ_RELAY_URL: "wss://relay.example.com",
      BUZZ_PRIVATE_KEY: c.key,
      BUZZ_AUTH_TAG: c.tag,
      BUZZ_OWNER_PUBKEY: OWNER_PUBKEY,
    },
  });
  expect(source).toContain("${BUZZ_PRIVATE_KEY}");
  expect(source).not.toContain(c.key);
  expect(loaded.normalized.buzzPlatform?.enabled).toBe(false);
  expect(loaded.normalized.endpoints).toContainEqual(
    expect.objectContaining({
      id: "buzzbot-buzz",
      platform: "buzz",
      enabled: false,
    }),
  );
  expect(
    loaded.normalized.endpoints.some(
      (endpoint) => endpoint.platform === "telegram",
    ),
  ).toBe(false);
});

test("agent-team example activates only the selected canary after the master switch", () => {
  const source = example("agent-team/torana.yaml");
  const planner = credential(2);
  const builder = credential(3);
  const operator = credential(4);
  const env = {
    PORT: "3000",
    TELEGRAM_OWNER_ID: "111222333",
    TELEGRAM_BOT_TOKEN_PLANNER: "TEST_PLANNER:AAAAAAAAAAAAAAAAAAAAAAAAA",
    TELEGRAM_BOT_TOKEN_BUILDER: "TEST_BUILDER:AAAAAAAAAAAAAAAAAAAAAAAAA",
    TELEGRAM_BOT_TOKEN_OPERATOR: "TEST_OPERATOR:AAAAAAAAAAAAAAAAAAAAAAAAA",
    BUZZ_RELAY_URL: "wss://relay.example.com",
    BUZZ_OWNER_PUBKEY: OWNER_PUBKEY,
    BUZZ_PRIVATE_KEY_PLANNER: planner.key,
    BUZZ_AUTH_TAG_PLANNER: planner.tag,
    BUZZ_PRIVATE_KEY_BUILDER: builder.key,
    BUZZ_AUTH_TAG_BUILDER: builder.tag,
    BUZZ_PRIVATE_KEY_OPERATOR: operator.key,
    BUZZ_AUTH_TAG_OPERATOR: operator.tag,
  };
  const disabled = loadConfigFromString(source, { env });
  expect(
    disabled.normalized.endpoints.filter(
      (endpoint) => endpoint.platform === "buzz" && endpoint.enabled,
    ),
  ).toHaveLength(0);

  const canary = loadConfigFromString(
    source.replace(
      "    enabled: false\n    cli_path: buzz",
      "    enabled: true\n    cli_path: buzz",
    ),
    { env },
  );
  expect(
    canary.normalized.endpoints
      .filter((endpoint) => endpoint.platform === "buzz" && endpoint.enabled)
      .map((endpoint) => endpoint.id),
  ).toEqual(["operator-buzz"]);
});
