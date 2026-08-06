// US-024 — dynamic endpoint provisioning.
//
// The property under test throughout: a provisioned endpoint is not a second,
// weaker kind of endpoint. It is validated by the same schema as YAML, it
// cannot shadow a YAML endpoint, its secrets never appear in a row or a
// response, and it survives a restart exactly as a YAML endpoint does.

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  finalizeEvent,
  verifyEvent,
  type Event,
  type Filter,
} from "nostr-tools";
import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import {
  openSecret,
  parseProvisioningKey,
  ProvisioningSecretsError,
  sealSecret,
  tokenMatches,
} from "../../src/config/provisioning-secrets.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { resetLoggerState } from "../../src/log.js";
import {
  BuzzProvisioningService,
  ProvisioningError,
  ProvisionRequestSchema,
} from "../../src/platform/buzz/provisioning.js";
import { BuzzTransport } from "../../src/platform/buzz/transport.js";
import {
  BUZZ_KINDS,
  createOwnerAuthTag,
  decodeSecret,
  publicKey,
  verifyOwnerAuthTag,
} from "../../src/platform/buzz/protocol.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const KEY = "11".repeat(32);
const PROVISIONED_KEY = "0a".repeat(32);
const SECOND_KEY = "0b".repeat(32);
const YAML_KEY = "0c".repeat(32);
const OWNER_SECRET = decodeSecret("04".padStart(64, "0"));
const RELAY_SECRET = decodeSecret("02".padStart(64, "0"));
const OWNER_PUBKEY = publicKey(OWNER_SECRET);
const PROVISIONED_PUBKEY = publicKey(decodeSecret(PROVISIONED_KEY));
const CHANNEL = "11111111-2222-4333-8444-555555555555";

const tempDirs: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const transports: BuzzTransport[] = [];
const dbs: GatewayDB[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((item) => item.stop()));
  for (const relay of servers.splice(0)) relay.stop(true);
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  resetLoggerState();
});

function authTagFor(privateKeyHex: string): string {
  return JSON.stringify(
    createOwnerAuthTag(
      OWNER_SECRET,
      publicKey(decodeSecret(privateKeyHex)),
      "kind=9",
    ),
  );
}

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
        socket.send(JSON.stringify(["AUTH", "provisioning-challenge"]));
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
                  ["p", PROVISIONED_PUBKEY],
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

function makeLoaded(options: { withYamlBuzz?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "torana-provisioning-"));
  tempDirs.push(dir);
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
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
  upgraded.limits.relay_ok_wait_ms = 1000;
  if (options.withYamlBuzz) {
    upgraded.agents[0].endpoints.push({
      id: "alpha-yaml-buzz",
      platform: "buzz",
      enabled: true,
      community_id: "primary",
      relay_url: options.withYamlBuzz,
      private_key: YAML_KEY,
      auth_tag: authTagFor(YAML_KEY),
      respond_to: "owner_only",
      owner_pubkey: OWNER_PUBKEY,
      allowed_pubkeys: [],
      subscribe: "mentions_and_dms",
      channel_overrides: {},
    });
  }
  return loadConfigFromString(yaml.dump(upgraded), { skipInterpolation: true });
}

function openDb(loaded: ReturnType<typeof makeLoaded>): GatewayDB {
  applyMigrations(loaded.config.gateway.db_path!);
  const db = new GatewayDB(loaded.config.gateway.db_path!);
  db.syncNormalizedConfig(loaded.normalized);
  dbs.push(db);
  return db;
}

function makeService(
  loaded: ReturnType<typeof makeLoaded>,
  db: GatewayDB,
  options: { key?: Buffer | null; transport?: BuzzTransport | null } = {},
) {
  return new BuzzProvisioningService({
    db,
    configV2: loaded.configV2,
    key: options.key === undefined ? parseProvisioningKey(KEY) : options.key,
    transport: options.transport ?? null,
  });
}

function request(relayUrl: string, overrides: Record<string, unknown> = {}) {
  return ProvisionRequestSchema.parse({
    agent_id: "alpha",
    relay_url: relayUrl,
    private_key: PROVISIONED_KEY,
    auth_tag: authTagFor(PROVISIONED_KEY),
    owner_pubkey: OWNER_PUBKEY,
    ...overrides,
  });
}

function makeTransport(
  loaded: ReturnType<typeof makeLoaded>,
  db: GatewayDB,
  endpoints = loaded.normalized.endpoints,
): BuzzTransport {
  const transport = new BuzzTransport({
    db,
    normalized: loaded.normalized,
    endpoints,
    lifecyclePollMs: 20,
  });
  transports.push(transport);
  return transport;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out: ${message}`);
}

describe("provisioning secrets", () => {
  test("a sealed secret round-trips and is bound to its endpoint", () => {
    const key = parseProvisioningKey(KEY);
    const sealed = sealSecret(key, "alpha-buzz", "nsec-material");
    expect(sealed).not.toContain("nsec-material");
    expect(openSecret(key, "alpha-buzz", sealed)).toBe("nsec-material");

    // Same plaintext, different envelope every time: the nonce is fresh.
    expect(sealSecret(key, "alpha-buzz", "nsec-material")).not.toBe(sealed);

    // Moving a ciphertext to another row does not open it.
    expect(() => openSecret(key, "other-buzz", sealed)).toThrow(
      ProvisioningSecretsError,
    );
  });

  test("a wrong key, a tampered envelope, and a truncated envelope all fail closed", () => {
    const key = parseProvisioningKey(KEY);
    const other = parseProvisioningKey("22".repeat(32));
    const sealed = sealSecret(key, "alpha-buzz", "nsec-material");

    expect(() => openSecret(other, "alpha-buzz", sealed)).toThrow(
      ProvisioningSecretsError,
    );

    const parts = sealed.split(".");
    const flipped = Buffer.from(parts[3]!, "base64url");
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() =>
      openSecret(
        key,
        "alpha-buzz",
        [parts[0], parts[1], parts[2], flipped.toString("base64url")].join("."),
      ),
    ).toThrow(ProvisioningSecretsError);

    for (const bad of ["", "v1.a.b", "v2.a.b.c", sealed.replace("v1", "v9")]) {
      expect(() => openSecret(key, "alpha-buzz", bad)).toThrow(
        ProvisioningSecretsError,
      );
    }
  });

  test("the key must be 32 bytes, in hex or base64", () => {
    expect(parseProvisioningKey(KEY)).toHaveLength(32);
    expect(
      parseProvisioningKey(Buffer.alloc(32, 7).toString("base64")),
    ).toHaveLength(32);
    for (const bad of ["", "  ", "abc", "11".repeat(16), "z".repeat(64)]) {
      expect(() => parseProvisioningKey(bad)).toThrow(ProvisioningSecretsError);
    }
  });

  test("token comparison is length-safe and exact", () => {
    expect(tokenMatches("a-long-admin-token", "a-long-admin-token")).toBe(true);
    expect(tokenMatches("a-long-admin-token", "a-long-admin-toke")).toBe(false);
    expect(tokenMatches("a-long-admin-token", "b-long-admin-token")).toBe(
      false,
    );
    expect(tokenMatches("", "")).toBe(true);
  });
});

describe("provisioning validation", () => {
  test("an unknown agent is rejected and the error lists the real ones", async () => {
    const loaded = makeLoaded();
    const db = openDb(loaded);
    const service = makeService(loaded, db, {
      transport: makeTransport(loaded, db),
    });
    await expect(
      service.upsert(
        "ghost-buzz",
        request("ws://127.0.0.1:1", {
          agent_id: "nobody",
        }),
        "test-token",
      ),
    ).rejects.toMatchObject({ code: "unknown_agent" });
    try {
      await service.upsert(
        "ghost-buzz",
        request("ws://127.0.0.1:1", { agent_id: "nobody" }),
        "test-token",
      );
    } catch (error) {
      expect((error as Error).message).toContain("alpha");
    }
    expect(service.configuredAgentIds()).toEqual(["alpha"]);
  });

  test("a YAML endpoint id and a YAML identity both win", async () => {
    const relay = createRelay();
    const loaded = makeLoaded({ withYamlBuzz: relay.url });
    const db = openDb(loaded);
    const service = makeService(loaded, db, {
      transport: makeTransport(loaded, db, []),
    });

    await expect(
      service.upsert("alpha-yaml-buzz", request(relay.url), "test-token"),
    ).rejects.toMatchObject({ code: "conflict" });

    // Same identity under a different id is equally refused — the pubkey is
    // what the relay authenticates, not the id.
    await expect(
      service.upsert(
        "alpha-provisioned",
        request(relay.url, {
          private_key: YAML_KEY,
          auth_tag: authTagFor(YAML_KEY),
        }),
        "test-token",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("an invalid auth tag is rejected with the YAML error surface", async () => {
    const loaded = makeLoaded();
    const db = openDb(loaded);
    const service = makeService(loaded, db, {
      transport: makeTransport(loaded, db, []),
    });
    await expect(
      service.upsert(
        "alpha-provisioned",
        request("ws://127.0.0.1:1", {
          // A tag that authorizes a *different* key.
          auth_tag: authTagFor(SECOND_KEY),
        }),
        "test-token",
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });

    try {
      await service.upsert(
        "alpha-provisioned",
        request("ws://127.0.0.1:1", { auth_tag: authTagFor(SECOND_KEY) }),
        "test-token",
      );
    } catch (error) {
      expect((error as Error).message).toContain("auth tag");
    }
  });

  test("a malformed private key is rejected before anything is stored", async () => {
    const loaded = makeLoaded();
    const db = openDb(loaded);
    const service = makeService(loaded, db, {
      transport: makeTransport(loaded, db, []),
    });
    await expect(
      service.upsert(
        "alpha-provisioned",
        ProvisionRequestSchema.parse({
          agent_id: "alpha",
          relay_url: "ws://127.0.0.1:1",
          private_key: "not-a-key",
          auth_tag: authTagFor(PROVISIONED_KEY),
          owner_pubkey: OWNER_PUBKEY,
        }),
        "test-token",
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(db.listProvisionedEndpoints()).toEqual([]);
  });

  test("provisioning refuses when no secrets key is configured", async () => {
    const loaded = makeLoaded();
    const db = openDb(loaded);
    const service = makeService(loaded, db, {
      key: null,
      transport: makeTransport(loaded, db, []),
    });
    await expect(
      service.upsert("alpha-provisioned", request("ws://127.0.0.1:1"), "t"),
    ).rejects.toMatchObject({ code: "not_configured" });
  });

  test("the endpoint ceiling is refused, not degraded", async () => {
    const loaded = makeLoaded();
    const db = openDb(loaded);
    const service = new BuzzProvisioningService({
      db,
      configV2: loaded.configV2,
      key: parseProvisioningKey(KEY),
      transport: makeTransport(loaded, db, []),
      maxEndpoints: 0,
    });
    await expect(
      service.upsert("alpha-provisioned", request("ws://127.0.0.1:1"), "t"),
    ).rejects.toMatchObject({ code: "capacity" });
  });

  test("the request schema rejects unknown fields and bad enums", () => {
    expect(
      ProvisionRequestSchema.safeParse({
        agent_id: "alpha",
        relay_url: "ws://x",
        private_key: PROVISIONED_KEY,
        auth_tag: "{}",
        runner: { type: "command", cmd: ["sh"] },
      }).success,
    ).toBe(false);
    expect(
      ProvisionRequestSchema.safeParse({
        agent_id: "alpha",
        relay_url: "ws://x",
        private_key: PROVISIONED_KEY,
        auth_tag: "{}",
        respond_to: "everyone",
      }).success,
    ).toBe(false);
  });
});

describe("provisioning lifecycle", () => {
  test(
    "deploy connects and publishes presence, and re-deploy is a strict no-op",
    async () => {
      const relay = createRelay();
      const loaded = makeLoaded();
      const db = openDb(loaded);
      const transport = makeTransport(loaded, db, []);
      await transport.start(async () => {});
      const service = makeService(loaded, db, { transport });

      const created = await service.upsert(
        "alpha-provisioned",
        request(relay.url),
        "provision-token",
      );
      expect(created).toMatchObject({
        kind: "created",
        endpointId: "alpha-provisioned",
        pubkey: PROVISIONED_PUBKEY,
      });
      await waitFor(
        () => transport.snapshot("alpha-provisioned")?.connected === true,
        "provisioned endpoint connected",
      );
      await waitFor(
        () => relay.presence().length >= 1,
        "presence published for the provisioned endpoint",
      );

      const status = service.status("alpha-provisioned")!;
      expect(status.agentId).toBe("alpha");
      expect(status.pubkey).toBe(PROVISIONED_PUBKEY);
      expect(status.connected).toBe(true);
      expect(status.lifecycleState).toBe("active");
      expect(status.provisionedBy).toBe("provision-token");

      const again = await service.upsert(
        "alpha-provisioned",
        request(relay.url),
        "provision-token",
      );
      expect(again.kind).toBe("unchanged");
      // A no-op does not churn the connection.
      expect(transport.snapshot("alpha-provisioned")?.connected).toBe(true);
    },
    { timeout: 30_000 },
  );

  test(
    "a disabled endpoint is replaced and restarted by a fresh deploy",
    async () => {
      const relay = createRelay();
      const loaded = makeLoaded();
      const db = openDb(loaded);
      const transport = makeTransport(loaded, db, []);
      await transport.start(async () => {});
      const service = makeService(loaded, db, { transport });
      await service.upsert("alpha-provisioned", request(relay.url), "t");
      await waitFor(
        () => transport.snapshot("alpha-provisioned")?.connected === true,
        "connected",
      );

      // Stand in for an owner !shutdown: durably disabled.
      db.setEndpointLifecycle(
        "alpha-provisioned",
        "disabled",
        "owner_shutdown",
      );
      await waitFor(
        () => transport.snapshot("alpha-provisioned")?.state === "disabled",
        "endpoint went down",
      );

      const outcome = await service.upsert(
        "alpha-provisioned",
        request(relay.url),
        "t",
      );
      expect(outcome.kind).toBe("replaced");
      expect(db.getEndpointState("alpha-provisioned")!.lifecycleState).toBe(
        "active",
      );
      await waitFor(
        () => transport.snapshot("alpha-provisioned")?.connected === true,
        "reconnected after redeploy",
      );
    },
    { timeout: 30_000 },
  );

  test(
    "supervisor add / remove / re-add is idempotent",
    async () => {
      const relay = createRelay();
      const loaded = makeLoaded();
      const db = openDb(loaded);
      const transport = makeTransport(loaded, db, []);
      await transport.start(async () => {});
      const service = makeService(loaded, db, { transport });

      await service.upsert("alpha-provisioned", request(relay.url), "t");
      await waitFor(
        () => transport.snapshot("alpha-provisioned")?.connected === true,
        "connected",
      );
      expect(transport.snapshots()).toHaveLength(1);
      expect(transport.botIds).toEqual(["alpha"]);

      // Re-deploy with a changed field: replace, never duplicate.
      await service.upsert(
        "alpha-provisioned",
        request(relay.url, { subscribe: "all_channels" }),
        "t",
      );
      expect(transport.snapshots()).toHaveLength(1);

      expect(await service.remove("alpha-provisioned")).toBe(true);
      expect(transport.snapshots()).toHaveLength(0);
      expect(transport.hasEndpoint("alpha-provisioned")).toBe(false);
      expect(service.status("alpha-provisioned")).toBeNull();
      // Removing twice is not an error.
      expect(await service.remove("alpha-provisioned")).toBe(false);

      await service.upsert("alpha-provisioned", request(relay.url), "t");
      expect(transport.snapshots()).toHaveLength(1);
      await waitFor(
        () => transport.snapshot("alpha-provisioned")?.connected === true,
        "reconnected after re-add",
      );
    },
    { timeout: 30_000 },
  );

  test(
    "delete drains the endpoint before removing it",
    async () => {
      const relay = createRelay();
      const loaded = makeLoaded();
      const db = openDb(loaded);
      const transport = makeTransport(loaded, db, []);
      await transport.start(async () => {});
      const service = makeService(loaded, db, { transport });
      await service.upsert("alpha-provisioned", request(relay.url), "t");
      await waitFor(
        () => relay.presence().length >= 1,
        "online presence published",
      );

      await service.remove("alpha-provisioned");
      // Stopping a supervisor announces offline rather than going quiet and
      // leaving the dot lit until the relay's TTL lapses.
      expect(
        relay.presence().some((event) => event.content === "offline"),
      ).toBe(true);
      expect(db.getProvisionedEndpoint("alpha-provisioned")).toBeNull();
    },
    { timeout: 30_000 },
  );
});

describe("provisioning persistence", () => {
  test("secrets are ciphertext at rest and absent from status", async () => {
    const loaded = makeLoaded();
    const db = openDb(loaded);
    const service = makeService(loaded, db, {
      transport: makeTransport(loaded, db, []),
    });
    await service.upsert("alpha-provisioned", request("ws://127.0.0.1:1"), "t");

    const row = db.getProvisionedEndpoint("alpha-provisioned")!;
    expect(row.privateKeyCiphertext).not.toContain(PROVISIONED_KEY);
    expect(row.configJson).not.toContain(PROVISIONED_KEY);
    expect(row.configJson).not.toContain("auth_tag");
    expect(JSON.stringify(service.status("alpha-provisioned"))).not.toContain(
      PROVISIONED_KEY,
    );

    // And nothing anywhere in the physical database file either.
    const raw = new Database(loaded.config.gateway.db_path!, {
      readonly: true,
    });
    try {
      const dump = raw
        .query("SELECT * FROM provisioned_endpoints")
        .all()
        .map((r) => JSON.stringify(r))
        .join("");
      expect(dump).not.toContain(PROVISIONED_KEY);
      expect(dump).toContain("v1.");
    } finally {
      raw.close();
    }
  });

  test("a restart restores provisioned endpoints", async () => {
    const relay = createRelay();
    const loaded = makeLoaded();
    const db = openDb(loaded);
    const service = makeService(loaded, db, {
      transport: makeTransport(loaded, db, []),
    });
    await service.upsert("alpha-provisioned", request(relay.url), "t");
    db.close();
    dbs.length = 0;

    const restarted = new GatewayDB(loaded.config.gateway.db_path!);
    dbs.push(restarted);
    restarted.syncNormalizedConfig(loaded.normalized);
    const afterRestart = makeService(loaded, restarted);
    const persisted = afterRestart.loadPersisted();
    expect(persisted.errors).toEqual([]);
    expect(persisted.endpoints.map((item) => item.id)).toEqual([
      "alpha-provisioned",
    ]);
    // The restored endpoint carries its real secrets again.
    expect(persisted.endpoints[0]!.buzz!.pubkey).toBe(PROVISIONED_PUBKEY);
    expect(persisted.endpoints[0]!.agentId).toBe("alpha");
  });

  test("a missing or wrong key fails closed on restore", async () => {
    const loaded = makeLoaded();
    const db = openDb(loaded);
    const service = makeService(loaded, db, {
      transport: makeTransport(loaded, db, []),
    });
    await service.upsert("alpha-provisioned", request("ws://127.0.0.1:1"), "t");

    const noKey = makeService(loaded, db, { key: null }).loadPersisted();
    expect(noKey.endpoints).toEqual([]);
    expect(noKey.errors[0]).toContain("TORANA_PROVISIONING_SECRETS_KEY");

    const wrongKey = makeService(loaded, db, {
      key: parseProvisioningKey("33".repeat(32)),
    }).loadPersisted();
    expect(wrongKey.endpoints).toEqual([]);
    expect(wrongKey.errors[0]).toContain("could not be decrypted");
  });

  test("a row whose agent disappeared from YAML is reported, not started", async () => {
    const loaded = makeLoaded();
    const db = openDb(loaded);
    const service = makeService(loaded, db, {
      transport: makeTransport(loaded, db, []),
    });
    await service.upsert("alpha-provisioned", request("ws://127.0.0.1:1"), "t");

    // The agent is gone from the config this process booted with.
    const withoutAgent = new BuzzProvisioningService({
      db,
      configV2: { ...loaded.configV2!, agents: [] },
      key: parseProvisioningKey(KEY),
      transport: null,
    });
    const restored = withoutAgent.loadPersisted();
    expect(restored.endpoints).toEqual([]);
    expect(restored.errors.join(" ")).toContain("unknown agent");
  });

  test("an error carries no secret material", async () => {
    const loaded = makeLoaded();
    const db = openDb(loaded);
    const service = makeService(loaded, db, {
      transport: makeTransport(loaded, db, []),
    });
    await service.upsert("alpha-provisioned", request("ws://127.0.0.1:1"), "t");
    const errors = makeService(loaded, db, {
      key: parseProvisioningKey("44".repeat(32)),
    }).loadPersisted().errors;
    expect(errors.join(" ")).not.toContain(PROVISIONED_KEY);
    expect(errors.join(" ")).not.toContain("nsec");
  });
});

describe("ProvisioningError", () => {
  test("carries a machine-readable code", () => {
    const error = new ProvisioningError("conflict", "already deployed");
    expect(error.code).toBe("conflict");
    expect(error).toBeInstanceOf(Error);
  });
});
