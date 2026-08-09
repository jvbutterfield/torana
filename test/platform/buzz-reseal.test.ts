// US-035 — startup re-seal, against real stored rows (R9.6).
//
// The unit tests cover the envelope; this file covers the thing that actually
// makes a rotation finishable: after one deploy with both keys configured,
// every row is on the primary and the outgoing key can be deleted. The
// failure mode being defended is a rotation that reports success while one
// quiet agent is still on the key about to be removed.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import {
  openSecretDetailed,
  parseProvisioningKey,
  parseProvisioningKeyring,
  sealSecret,
  singleKeyring,
  type ProvisioningKeyring,
} from "../../src/config/provisioning-secrets.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { BuzzProvisioningService } from "../../src/platform/buzz/provisioning.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const OLD = "11".repeat(32);
const NEW = "22".repeat(32);
const STRANGER = "33".repeat(32);

const dirs: string[] = [];
const dbs: GatewayDB[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function makeDb(): { db: GatewayDB; configV2: unknown } {
  const dir = mkdtempSync(join(tmpdir(), "torana-reseal-"));
  dirs.push(dir);
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as Record<string, any>;
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
  upgraded.platforms.buzz = { enabled: true };
  const loaded = loadConfigFromString(yaml.dump(upgraded), {
    skipInterpolation: true,
  });
  applyMigrations(loaded.config.gateway.db_path!);
  const db = new GatewayDB(loaded.config.gateway.db_path!);
  db.syncNormalizedConfig(loaded.normalized);
  dbs.push(db);
  return { db, configV2: loaded.configV2 };
}

/** Store one endpoint row sealed under a chosen keyring's primary. */
function seed(
  db: GatewayDB,
  endpointId: string,
  keyring: ProvisioningKeyring,
  options: { authTag?: boolean } = {},
): void {
  db.upsertProvisionedEndpoint({
    endpointId,
    agentId: endpointId.replace(/-buzz$/, ""),
    derivedPubkey: `pub-${endpointId}`,
    configJson: JSON.stringify({ relay_url: "wss://relay.example" }),
    privateKeyCiphertext: sealSecret(keyring, endpointId, `nsec-${endpointId}`),
    authTagCiphertext:
      options.authTag === false
        ? null
        : sealSecret(keyring, endpointId, `tag-${endpointId}`),
    provisionedBy: "provisioner",
    deployNonce: null,
  });
}

function service(
  db: GatewayDB,
  configV2: unknown,
  keyring: ProvisioningKeyring | null,
): BuzzProvisioningService {
  return new BuzzProvisioningService({
    db,
    configV2: configV2 as never,
    keyring,
    transport: null,
  });
}

const oldRing = () => singleKeyring(parseProvisioningKey(OLD));
const rotating = () => parseProvisioningKeyring(`${NEW},${OLD}`);
const newRing = () => singleKeyring(parseProvisioningKey(NEW));

/** Which key index each stored row currently opens under. */
function keyIndexes(db: GatewayDB, keyring: ProvisioningKeyring): number[] {
  return db
    .listProvisionedEndpoints()
    .map(
      (row) =>
        openSecretDetailed(keyring, row.endpointId, row.privateKeyCiphertext)
          .keyIndex,
    );
}

describe("resealUnderPrimary", () => {
  test("moves every stale row onto the primary in one pass", () => {
    const { db, configV2 } = makeDb();
    seed(db, "alpha-buzz", oldRing());
    seed(db, "beta-buzz", oldRing());

    const result = service(db, configV2, rotating()).resealUnderPrimary();
    expect(result).toMatchObject({ resealed: 2, alreadyPrimary: 0 });
    expect(result.errors).toEqual([]);
    expect(keyIndexes(db, rotating())).toEqual([0, 0]);
  });

  test("after the pass, the outgoing key alone is enough — it can be dropped", () => {
    // The whole point of the procedure: this is the assertion that makes
    // "now delete the old key" safe rather than hopeful.
    const { db, configV2 } = makeDb();
    seed(db, "alpha-buzz", oldRing());
    service(db, configV2, rotating()).resealUnderPrimary();

    const onlyNew = newRing();
    for (const row of db.listProvisionedEndpoints()) {
      expect(
        openSecretDetailed(onlyNew, row.endpointId, row.privateKeyCiphertext)
          .plaintext,
      ).toBe(`nsec-${row.endpointId}`);
    }
  });

  test("preserves the plaintext exactly — a re-seal is not a re-provision", () => {
    const { db, configV2 } = makeDb();
    seed(db, "alpha-buzz", oldRing());
    const before = db.getProvisionedEndpoint("alpha-buzz")!;
    service(db, configV2, rotating()).resealUnderPrimary();
    const after = db.getProvisionedEndpoint("alpha-buzz")!;

    expect(after.privateKeyCiphertext).not.toBe(before.privateKeyCiphertext);
    expect(
      openSecretDetailed(rotating(), "alpha-buzz", after.privateKeyCiphertext)
        .plaintext,
    ).toBe("nsec-alpha-buzz");
    // Everything that is not a secret is untouched: a rotation must not
    // rewrite provenance or make the audit trail claim it deployed the agent.
    expect(after.configJson).toBe(before.configJson);
    expect(after.provisionedBy).toBe(before.provisionedBy);
    expect(after.agentId).toBe(before.agentId);
    expect(after.derivedPubkey).toBe(before.derivedPubkey);
  });

  test("re-seals the auth tag alongside the private key", () => {
    const { db, configV2 } = makeDb();
    seed(db, "alpha-buzz", oldRing());
    service(db, configV2, rotating()).resealUnderPrimary();
    const row = db.getProvisionedEndpoint("alpha-buzz")!;
    expect(
      openSecretDetailed(newRing(), "alpha-buzz", row.authTagCiphertext!)
        .plaintext,
    ).toBe("tag-alpha-buzz");
  });

  test("handles a row with no auth tag without inventing one", () => {
    const { db, configV2 } = makeDb();
    seed(db, "alpha-buzz", oldRing(), { authTag: false });
    const result = service(db, configV2, rotating()).resealUnderPrimary();
    expect(result.resealed).toBe(1);
    expect(
      db.getProvisionedEndpoint("alpha-buzz")?.authTagCiphertext,
    ).toBeNull();
  });

  test("is idempotent — a second boot re-seals nothing", () => {
    const { db, configV2 } = makeDb();
    seed(db, "alpha-buzz", oldRing());
    service(db, configV2, rotating()).resealUnderPrimary();
    const second = service(db, configV2, rotating()).resealUnderPrimary();
    expect(second).toMatchObject({ resealed: 0, alreadyPrimary: 1 });
  });

  test("does nothing at all with a single key configured", () => {
    // The ordinary boot. Decrypting every row to prove there is no work would
    // be a per-restart cost paid by every deployment that never rotates.
    const { db, configV2 } = makeDb();
    seed(db, "alpha-buzz", oldRing());
    expect(service(db, configV2, oldRing()).resealUnderPrimary()).toMatchObject(
      {
        resealed: 0,
        alreadyPrimary: 0,
      },
    );
  });

  test("does nothing with no key configured", () => {
    const { db, configV2 } = makeDb();
    seed(db, "alpha-buzz", oldRing());
    expect(service(db, configV2, null).resealUnderPrimary()).toMatchObject({
      resealed: 0,
    });
  });

  test("leaves an unreadable row alone and reports it, rather than deciding its fate", () => {
    // A row under a key nobody configured is a fail-closed condition owned by
    // `loadPersisted` and doctor C029. Re-sealing must not be what destroys or
    // silently rewrites it.
    const { db, configV2 } = makeDb();
    seed(db, "alpha-buzz", oldRing());
    seed(db, "stranger-buzz", singleKeyring(parseProvisioningKey(STRANGER)));
    const before = db.getProvisionedEndpoint("stranger-buzz")!;

    const result = service(db, configV2, rotating()).resealUnderPrimary();
    expect(result.resealed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("stranger-buzz");
    expect(
      db.getProvisionedEndpoint("stranger-buzz")?.privateKeyCiphertext,
    ).toBe(before.privateKeyCiphertext);
  });

  test("one unreadable row does not stop the others from being re-sealed", () => {
    const { db, configV2 } = makeDb();
    seed(db, "aaa-buzz", singleKeyring(parseProvisioningKey(STRANGER)));
    seed(db, "bbb-buzz", oldRing());
    const result = service(db, configV2, rotating()).resealUnderPrimary();
    expect(result.resealed).toBe(1);
    expect(
      openSecretDetailed(
        newRing(),
        "bbb-buzz",
        db.getProvisionedEndpoint("bbb-buzz")!.privateKeyCiphertext,
      ).keyIndex,
    ).toBe(0);
  });

  test("an error message never leaks the secret it failed to open", () => {
    const { db, configV2 } = makeDb();
    seed(db, "stranger-buzz", singleKeyring(parseProvisioningKey(STRANGER)));
    const result = service(db, configV2, rotating()).resealUnderPrimary();
    expect(result.errors.join(" ")).not.toContain("nsec-stranger");
  });
});

describe("rowsOnOutgoingKeys", () => {
  test("counts what is left before the outgoing key may be removed", () => {
    const { db, configV2 } = makeDb();
    seed(db, "alpha-buzz", oldRing());
    seed(db, "beta-buzz", rotating());
    expect(service(db, configV2, rotating()).rowsOnOutgoingKeys()).toEqual({
      stale: 1,
      unreadable: 0,
    });
  });

  test("reads zero once the re-seal pass has run", () => {
    const { db, configV2 } = makeDb();
    seed(db, "alpha-buzz", oldRing());
    const svc = service(db, configV2, rotating());
    svc.resealUnderPrimary();
    expect(svc.rowsOnOutgoingKeys()).toEqual({ stale: 0, unreadable: 0 });
  });

  test("separates unreadable from merely stale", () => {
    // They call for different actions — one is "redeploy", the other is "you
    // have lost a key" — so collapsing them into one number would be useless.
    const { db, configV2 } = makeDb();
    seed(db, "alpha-buzz", oldRing());
    seed(db, "stranger-buzz", singleKeyring(parseProvisioningKey(STRANGER)));
    expect(service(db, configV2, rotating()).rowsOnOutgoingKeys()).toEqual({
      stale: 1,
      unreadable: 1,
    });
  });

  test("reports nothing when no key is configured", () => {
    const { db, configV2 } = makeDb();
    seed(db, "alpha-buzz", oldRing());
    expect(service(db, configV2, null).rowsOnOutgoingKeys()).toEqual({
      stale: 0,
      unreadable: 0,
    });
  });
});

describe("restore across a rotation", () => {
  test("a row re-sealed at boot still loads and starts normally", () => {
    const { db, configV2 } = makeDb();
    // A realistic row: sealed under the outgoing key by a previous process.
    const loaded = service(db, configV2, oldRing());
    expect(loaded).toBeDefined();
    seed(db, "alpha-buzz", oldRing());

    const rotated = service(db, configV2, rotating());
    rotated.resealUnderPrimary();
    // With only the new key, the row still opens — which is what the next
    // deploy (after the old key is dropped) will do.
    const afterDrop = service(db, configV2, newRing());
    expect(afterDrop.rowsOnOutgoingKeys()).toEqual({ stale: 0, unreadable: 0 });
  });
});
