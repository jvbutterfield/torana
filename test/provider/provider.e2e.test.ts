// US-025 E2E — the real provider binary against a real Torana gateway and a
// fake relay. Gated by BUZZ_PROVIDER_E2E=1 because it compiles the provider
// and starts a gateway.
//
//   BUZZ_PROVIDER_E2E=1 bun test test/provider/provider.e2e.test.ts
//
// What this proves that the unit tests cannot: the provider's request body is
// actually accepted by Torana's schema, the poll loop's readiness condition
// actually becomes true against a live endpoint, and the agent it deployed
// really connects to a relay.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  finalizeEvent,
  nip19,
  verifyEvent,
  type Event,
  type Filter,
} from "nostr-tools";

import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { startGateway, type RunningGateway } from "../../src/main.js";
import { resetLoggerState } from "../../src/log.js";
import {
  BUZZ_KINDS,
  createOwnerAuthTag,
  decodeSecret,
  publicKey,
  verifyOwnerAuthTag,
} from "../../src/platform/buzz/protocol.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const ENABLED = process.env.BUZZ_PROVIDER_E2E === "1";

const ENDPOINT_KEY = "0a".repeat(32);
const ENDPOINT_PUBKEY = publicKey(decodeSecret(ENDPOINT_KEY));
// The Desktop always sends an nsec, so the E2E does too.
const ENDPOINT_NSEC = nip19.nsecEncode(decodeSecret(ENDPOINT_KEY));
const OWNER_SECRET = decodeSecret("04".padStart(64, "0"));
const OWNER_PUBKEY = publicKey(OWNER_SECRET);
const RELAY_SECRET = decodeSecret("02".padStart(64, "0"));
const CHANNEL = "11111111-2222-4333-8444-555555555555";
const ADMIN_TOKEN = "provisioning-e2e-token-0123456789ab";
const SECRETS_KEY = "1f".repeat(32);
const AUTH_TAG = JSON.stringify(
  createOwnerAuthTag(OWNER_SECRET, ENDPOINT_PUBKEY, "kind=9"),
);

const dirs: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
let gateway: RunningGateway | null = null;

afterEach(async () => {
  if (gateway) await gateway.shutdown("test");
  gateway = null;
  for (const relay of servers.splice(0)) relay.stop(true);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  resetLoggerState();
});

interface SocketData {
  authenticated: boolean;
  subscriptions: Map<string, Filter[]>;
}

function createRelay() {
  const stored: Event[] = [];
  const server = Bun.serve<SocketData>({
    port: 0,
    fetch(request, server) {
      if (
        server.upgrade(request, {
          data: { authenticated: false, subscriptions: new Map() },
        })
      ) {
        return undefined;
      }
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify(["AUTH", "provider-e2e-challenge"]));
      },
      message(socket, raw) {
        const frame = JSON.parse(String(raw)) as [string, ...unknown[]];
        if (frame[0] === "AUTH") {
          const auth = frame[1] as Event;
          const ownerTag = auth.tags.find((tag) => tag[0] === "auth");
          const ok =
            verifyEvent(auth) &&
            Boolean(
              ownerTag &&
              verifyOwnerAuthTag(
                ownerTag as Parameters<typeof verifyOwnerAuthTag>[0],
                auth.pubkey,
              ),
            );
          socket.data.authenticated = ok;
          socket.send(JSON.stringify(["OK", auth.id, ok, "authenticated"]));
          return;
        }
        if (!socket.data.authenticated) return;
        if (frame[0] === "EVENT") {
          const event = frame[1] as Event;
          stored.push(event);
          socket.send(JSON.stringify(["OK", event.id, true, "saved"]));
          return;
        }
        if (frame[0] !== "REQ") return;
        const id = String(frame[1]);
        socket.data.subscriptions.set(id, frame.slice(2) as Filter[]);
        socket.send(
          JSON.stringify([
            "EVENT",
            id,
            finalizeEvent(
              {
                kind: BUZZ_KINDS.groupMembers,
                created_at: 1_700_000_000,
                content: "",
                tags: [
                  ["d", CHANNEL],
                  ["p", ENDPOINT_PUBKEY],
                ],
              },
              RELAY_SECRET,
            ),
          ]),
        );
        socket.send(JSON.stringify(["EOSE", id]));
      },
    },
  });
  servers.push(server);
  return {
    url: `ws://127.0.0.1:${server.port}`,
    presence: () =>
      stored.filter((event) => event.kind === BUZZ_KINDS.presence),
  };
}

describe.skipIf(!ENABLED)("provider E2E", () => {
  test(
    "the compiled binary deploys a working endpoint onto a live gateway",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "torana-provider-e2e-"));
      dirs.push(dir);
      const relay = createRelay();

      const upgraded = upgradeV1Object(
        makeTestConfig([makeTestBotConfig("alpha")]),
      ) as any;
      upgraded.gateway.data_dir = dir;
      upgraded.gateway.db_path = join(dir, "gateway.db");
      upgraded.gateway.port = 0;
      upgraded.platforms.buzz = {
        enabled: true,
        reconnect: { base_ms: 100, cap_ms: 100 },
        subscription: {
          historical_limit: 100,
          replay_overlap_secs: 5,
          heartbeat_secs: 30,
        },
        message_max_bytes: 65_536,
      };
      upgraded.agent_api = {
        enabled: true,
        tokens: [
          {
            name: "provisioner",
            secret_ref: ADMIN_TOKEN,
            bot_ids: ["alpha"],
            scopes: ["endpoints:admin"],
          },
        ],
      };
      const loaded = loadConfigFromString(yaml.dump(upgraded), {
        skipInterpolation: true,
      });
      applyMigrations(loaded.config.gateway.db_path!);

      process.env.TORANA_PROVISIONING_SECRETS_KEY = SECRETS_KEY;
      gateway = await startGateway({
        config: loaded.config,
        normalized: loaded.normalized,
        configV2: loaded.configV2,
        secrets: loaded.secrets,
        agentApiTokens: loaded.agentApiTokens,
        publisherApiTokens: loaded.publisherApiTokens,
      });
      const base = `http://127.0.0.1:${gateway.server.port}`;

      // The provider reads its bearer from its own config file, never from
      // provider_config — so the E2E has to place one.
      const providerConfigDir = mkdtempSync(
        join(tmpdir(), "torana-provider-home-"),
      );
      dirs.push(providerConfigDir);
      // The real discovery path: ~/.config/torana/provider.json, mode 0600.
      mkdirSync(join(providerConfigDir, ".config", "torana"), {
        recursive: true,
      });
      writeFileSync(
        join(providerConfigDir, ".config", "torana", "provider.json"),
        JSON.stringify({ admin_token: ADMIN_TOKEN }),
        { mode: 0o600 },
      );

      const binary = join(dir, "buzz-backend-torana");
      const build = Bun.spawn(
        [
          "bun",
          "build",
          join(import.meta.dir, "../../src/provider/buzz-backend-torana.ts"),
          "--compile",
          "--outfile",
          binary,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await build.exited).toBe(0);

      // Discovery-shaped invocation: the Desktop always asks `info` first.
      const info = Bun.spawn([binary], {
        stdin: new TextEncoder().encode(JSON.stringify({ op: "info" })),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: providerConfigDir },
      });
      const infoOut = JSON.parse(await new Response(info.stdout).text());
      expect(await info.exited).toBe(0);
      expect(infoOut.protocol_version).toBe(1);

      const deployRequest = {
        op: "deploy",
        request_id: "22222222-3333-4444-8555-666666666666",
        agent: {
          name: "Alpha",
          relay_url: relay.url,
          private_key_nsec: ENDPOINT_NSEC,
          auth_tag: AUTH_TAG,
          respond_to: "owner_only",
          launch: { owner_pubkey: OWNER_PUBKEY },
        },
        provider_config: {
          torana_url: base,
          torana_agent_id: "alpha",
          torana_endpoint_id: "alpha-provisioned",
        },
      };
      const deployProc = Bun.spawn([binary], {
        stdin: new TextEncoder().encode(JSON.stringify(deployRequest)),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: providerConfigDir },
      });
      const stdout = await new Response(deployProc.stdout).text();
      const stderr = await new Response(deployProc.stderr).text();
      const code = await deployProc.exited;

      expect({ code, stdout }).toMatchObject({ code: 0 });
      const result = JSON.parse(stdout);
      expect(result.ok).toBe(true);
      expect(result.agent_id).toBe("railway:agent-team:alpha-provisioned");

      // Not a single byte of identity on either stream.
      expect(stdout).not.toContain(ENDPOINT_NSEC);
      expect(stderr).not.toContain(ENDPOINT_NSEC);
      expect(stdout).not.toContain(ADMIN_TOKEN);

      // The endpoint is genuinely live: it authenticated to the relay and
      // published presence.
      expect(relay.presence().length).toBeGreaterThanOrEqual(1);

      // And a second, identical deploy reconciles instead of duplicating.
      const again = Bun.spawn([binary], {
        stdin: new TextEncoder().encode(JSON.stringify(deployRequest)),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: providerConfigDir },
      });
      const againOut = JSON.parse(await new Response(again.stdout).text());
      expect(await again.exited).toBe(0);
      expect(againOut.result).toBe("unchanged");

      const status = await fetch(
        `${base}/v1/admin/buzz/endpoints/alpha-provisioned`,
        { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
      );
      expect(status.status).toBe(200);
      const statusBody = await status.json();
      expect(statusBody.connected).toBe(true);
      expect(JSON.stringify(statusBody)).not.toContain(ENDPOINT_NSEC);

      delete process.env.TORANA_PROVISIONING_SECRETS_KEY;
    },
    { timeout: 180_000 },
  );
});
