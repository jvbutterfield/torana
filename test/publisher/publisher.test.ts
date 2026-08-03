import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { runDoctor } from "../../src/doctor.js";
import { Metrics } from "../../src/metrics.js";
import { OutboxProcessor } from "../../src/outbox.js";
import { BuzzAdapter } from "../../src/platform/buzz/adapter.js";
import {
  createOwnerAuthTag,
  decodeSecret,
  publicKey,
} from "../../src/platform/buzz/protocol.js";
import { authenticatePublisher } from "../../src/publisher/auth.js";
import { PublisherService } from "../../src/publisher/service.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const PUBLISHER_KEY = "71".padStart(64, "0");
const OWNER_SECRET = decodeSecret("72".padStart(64, "0"));
const PUBLISHER_PUBKEY = publicKey(decodeSecret(PUBLISHER_KEY));
const OWNER_PUBKEY = publicKey(OWNER_SECRET);
const CHANNEL = "4109b9b8-c553-4d29-98f5-403d8419ac18";
const TOKEN = "publisher-test-token-00000000000000000000";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "torana-publisher-"));
  const value = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  value.gateway.data_dir = dir;
  value.gateway.db_path = join(dir, "gateway.db");
  value.platforms.buzz.enabled = true;
  value.publishers = [
    {
      id: "dev-team",
      enabled: true,
      endpoint: {
        id: "dev-team-buzz",
        platform: "buzz",
        community_id: "primary",
        relay_url: "wss://relay.example.com",
        private_key: PUBLISHER_KEY,
        auth_tag: JSON.stringify(
          createOwnerAuthTag(OWNER_SECRET, PUBLISHER_PUBKEY, "kind=9"),
        ),
        owner_pubkey: OWNER_PUBKEY,
        expected_pubkey: PUBLISHER_PUBKEY,
      },
      destination: { external_conversation_id: CHANNEL },
    },
  ];
  value.publisher_api = {
    enabled: true,
    tokens: [
      {
        name: "notifier",
        secret_ref: TOKEN,
        publisher_ids: ["dev-team"],
        scopes: ["publish", "status"],
      },
    ],
  };
  return { dir, value };
}

describe("publisher configuration and durable enqueue", () => {
  test("doctor explicitly probes a disabled publisher without publishing", async () => {
    const { dir, value } = fixture();
    try {
      value.publishers[0].enabled = false;
      value.agents[0].endpoints.push({
        id: "alpha-buzz",
        platform: "buzz",
        enabled: true,
        community_id: "primary",
        relay_url: "wss://relay.example.com",
        private_key: "73".padStart(64, "0"),
        respond_to: "allowlist",
        allowed_pubkeys: [OWNER_PUBKEY],
        subscribe: "mentions_and_dms",
        channel_overrides: {},
      });
      const loaded = loadConfigFromString(yaml.dump(value), {
        skipInterpolation: true,
      });
      applyMigrations(loaded.config.gateway.db_path!);
      let probeCalls = 0;
      const result = await runDoctor({
        config: loaded.config,
        configPath: join(dir, "torana.yaml"),
        normalized: loaded.normalized,
        sourceConfigVersion: 2,
        publisherProbeId: "dev-team",
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: 1,
                is_bot: true,
                first_name: "Alpha",
                username: "alpha_bot",
              },
            }),
            { headers: { "content-type": "application/json" } },
          )) as unknown as typeof fetch,
        buzzProbe: async ({ endpoint }) => {
          probeCalls += 1;
          expect(endpoint.id).toBe("dev-team-buzz");
          expect(endpoint.enabled).toBe(false);
          return { authenticated: true as const, channels: [CHANNEL] };
        },
      });
      expect(probeCalls).toBe(1);
      expect(result.checks.find((check) => check.id === "C016")).toEqual({
        id: "C016",
        status: "skip",
        detail:
          "publisher probe is transient and does not require the gateway lock",
      });
      expect(
        result.checks.find(
          (check) => check.id === "C018" && check.detail.includes("alpha-buzz"),
        ),
      ).toEqual({
        id: "C018",
        status: "skip",
        detail:
          "Buzz endpoint 'alpha-buzz' is not the requested publisher endpoint; relay auth not probed",
      });
      expect(
        result.checks.find(
          (check) =>
            check.id === "C018" && check.detail.includes("dev-team-buzz"),
        )?.status,
      ).toBe("ok");
      expect(
        result.checks.find(
          (check) => check.id === "C020" && check.detail.includes("dev-team"),
        )?.status,
      ).toBe("ok");
      const publisherProbe = result.checks.find((check) => check.id === "C028");
      expect(publisherProbe?.status).toBe("ok");
      expect(publisherProbe?.detail).toContain("no message published");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("disabled publisher probe fails when the pinned destination is absent", async () => {
    const { dir, value } = fixture();
    try {
      value.publishers[0].enabled = false;
      const loaded = loadConfigFromString(yaml.dump(value), {
        skipInterpolation: true,
      });
      applyMigrations(loaded.config.gateway.db_path!);
      const result = await runDoctor({
        config: loaded.config,
        configPath: join(dir, "torana.yaml"),
        normalized: loaded.normalized,
        sourceConfigVersion: 2,
        publisherProbeId: "dev-team",
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: 1,
                is_bot: true,
                first_name: "Alpha",
                username: "alpha_bot",
              },
            }),
            { headers: { "content-type": "application/json" } },
          )) as unknown as typeof fetch,
        buzzProbe: async () => ({
          authenticated: true as const,
          channels: ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"],
        }),
      });
      expect(result.checks.find((check) => check.id === "C020")?.status).toBe(
        "fail",
      );
      expect(result.checks.find((check) => check.id === "C028")?.status).toBe(
        "fail",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("publisher credentials and bearer scopes stay independent and redacted", () => {
    const { dir, value } = fixture();
    try {
      const loaded = loadConfigFromString(yaml.dump(value), {
        skipInterpolation: true,
      });
      expect(loaded.publisherApiTokens).toHaveLength(1);
      expect(loaded.agentApiTokens).toHaveLength(0);
      expect(loaded.secrets).toContain(TOKEN);
      expect(loaded.secrets).toContain(PUBLISHER_KEY);
      expect(
        authenticatePublisher(loaded.publisherApiTokens, `Bearer ${TOKEN}`),
      ).toHaveProperty("token.name", "notifier");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails closed on a pinned identity mismatch or publisher runner field", () => {
    const { dir, value } = fixture();
    try {
      value.publishers[0].endpoint.expected_pubkey = "00".repeat(32);
      expect(() =>
        loadConfigFromString(yaml.dump(value), { skipInterpolation: true }),
      ).toThrow(/derived public key does not match expected_pubkey/);
      value.publishers[0].endpoint.expected_pubkey = PUBLISHER_PUBKEY;
      value.publishers[0].runner = value.agents[0].runner;
      expect(() =>
        loadConfigFromString(yaml.dump(value), { skipInterpolation: true }),
      ).toThrow(/unrecognized key.*runner/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("same key signs and inserts once; changed canonical payload conflicts", () => {
    const { dir, value } = fixture();
    try {
      const loaded = loadConfigFromString(yaml.dump(value), {
        skipInterpolation: true,
      });
      applyMigrations(loaded.config.gateway.db_path!);
      const db = new GatewayDB(loaded.config.gateway.db_path!);
      db.syncNormalizedConfig(loaded.normalized);
      db.setBuzzChannels("dev-team-buzz", [CHANNEL]);
      const endpoint = loaded.normalized.endpoints.find(
        (candidate) => candidate.id === "dev-team-buzz",
      )!;
      const adapters = new Map([[endpoint.id, new BuzzAdapter(endpoint)]]);
      const outbox = new OutboxProcessor(
        loaded.config,
        db,
        adapters,
        new Metrics(loaded.config),
        null,
        { normalized: loaded.normalized },
      );
      const service = new PublisherService({
        normalized: loaded.normalized,
        db,
        outbox,
        health: () => [
          {
            endpointId: endpoint.id,
            agentId: "dev-team",
            state: "healthy",
            connected: true,
            channels: 1,
            lastError: null,
            disconnectedSince: null,
          },
        ],
      });
      const key = "publisher-key-0000000001";
      const first = service.publish("dev-team", key, {
        content: "Build complete ✓",
        source: "worker-terminal",
        severity: "info",
      });
      const replay = service.publish("dev-team", key, {
        content: "Build complete ✓",
        source: "worker-terminal",
        severity: "info",
      });
      const conflict = service.publish("dev-team", key, {
        content: "Different",
        source: "worker-terminal",
        severity: "info",
      });
      expect(first.kind).toBe("accepted");
      expect(replay.kind).toBe("replay");
      expect(conflict.kind).toBe("conflict");
      db.setEndpointLifecycle("dev-team-buzz", "disabled", "test");
      expect(
        service.publish("dev-team", key, {
          content: "Build complete ✓",
          source: "worker-terminal",
          severity: "info",
        }).kind,
      ).toBe("replay");
      expect(
        service.publish("dev-team", "publisher-key-0000000002", {
          content: "new while disabled",
          source: "worker-terminal",
          severity: "info",
        }),
      ).toEqual({ kind: "rejected", reason: "publisher_disabled" });
      const counts = db
        ._unsafeQuery(
          `SELECT (SELECT COUNT(*) FROM publisher_publications) AS publications,
                  (SELECT COUNT(*) FROM outbox) AS outbox_rows`,
        )
        .get() as { publications: number; outbox_rows: number };
      expect(counts).toEqual({ publications: 1, outbox_rows: 1 });
      const status = db.getPublisherPublication("dev-team", key);
      expect(status?.status).toBe("pending");
      expect(status).not.toHaveProperty("content");
      expect(db.sweepPublisherRetention(Date.now() + 60_000)).toBe(0);
      if (first.kind !== "accepted") throw new Error("expected acceptance");
      db.markOutboxSent(first.outboxId, "event-id");
      expect(db.sweepPublisherRetention(Date.now() + 60_000)).toBe(1);
      expect(db.getPublisherPublication("dev-team", key)).toBeNull();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
