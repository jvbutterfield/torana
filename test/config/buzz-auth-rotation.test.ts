import { expect, test } from "bun:test";
import yaml from "js-yaml";

import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import {
  createOwnerAuthTag,
  decodeSecret,
  publicKey,
} from "../../src/platform/buzz/protocol.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const OWNER = decodeSecret("51".padStart(64, "0"));
const OLD_KEY = "52".padStart(64, "0");
const NEW_KEY = "53".padStart(64, "0");

function authTag(privateKey: string): string {
  return JSON.stringify(
    createOwnerAuthTag(OWNER, publicKey(decodeSecret(privateKey)), "kind=9"),
  );
}

test("auth rotation fails closed until the owner tag matches the new key", () => {
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  const endpoint = {
    id: "alpha-buzz",
    platform: "buzz",
    enabled: false,
    community_id: "primary",
    relay_url: "wss://relay.example.com",
    private_key: OLD_KEY,
    auth_tag: authTag(OLD_KEY),
    owner_pubkey: publicKey(OWNER),
    respond_to: "owner_only",
  };
  upgraded.agents[0].endpoints.push(endpoint);
  expect(() =>
    loadConfigFromString(yaml.dump(upgraded), { skipInterpolation: true }),
  ).not.toThrow();

  endpoint.private_key = NEW_KEY;
  expect(() =>
    loadConfigFromString(yaml.dump(upgraded), { skipInterpolation: true }),
  ).toThrow(/auth tag signature does not authorize this endpoint key/);

  endpoint.auth_tag = authTag(NEW_KEY);
  expect(() =>
    loadConfigFromString(yaml.dump(upgraded), { skipInterpolation: true }),
  ).not.toThrow();
});
