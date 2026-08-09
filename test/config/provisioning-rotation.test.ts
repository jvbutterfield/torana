// US-035 — multi-key `TORANA_PROVISIONING_SECRETS_KEY` (R9.6).
//
// Rotation has to work without downtime and without re-provisioning, which
// means two keys coexist for exactly one deploy. The failure this file is
// built around is the quiet one: a rotation that *looks* finished while some
// row is still sealed under the key the operator is about to delete. Losing
// that key loses the agent identity permanently.

import { describe, expect, test } from "bun:test";

import {
  openSecret,
  openSecretDetailed,
  parseProvisioningKey,
  parseProvisioningKeyring,
  provisioningKeyringFromEnv,
  ProvisioningSecretsError,
  sealSecret,
  singleKeyring,
  PROVISIONING_KEY_ENV,
} from "../../src/config/provisioning-secrets.js";

const OLD = "11".repeat(32);
const NEW = "22".repeat(32);
const THIRD = "33".repeat(32);

const ring = (...keys: string[]) => parseProvisioningKeyring(keys.join(","));

describe("parseProvisioningKeyring", () => {
  test("a single key is its own primary", () => {
    const keyring = ring(OLD);
    expect(keyring.all).toHaveLength(1);
    expect(keyring.primary.equals(keyring.all[0]!)).toBe(true);
  });

  test("the first key is the primary and order is preserved", () => {
    const keyring = ring(NEW, OLD, THIRD);
    expect(keyring.all).toHaveLength(3);
    expect(keyring.primary.equals(parseProvisioningKey(NEW))).toBe(true);
    expect(keyring.all[1]!.equals(parseProvisioningKey(OLD))).toBe(true);
  });

  test("whitespace around entries is tolerated", () => {
    expect(parseProvisioningKeyring(` ${NEW} , ${OLD} `).all).toHaveLength(2);
  });

  test("empty entries are dropped rather than parsed as a bad key", () => {
    expect(parseProvisioningKeyring(`${NEW},,${OLD},`).all).toHaveLength(2);
  });

  test("a repeated key is refused — almost always a half-finished edit", () => {
    // The dangerous version of this typo: an operator means to prepend a new
    // primary, pastes the current one instead, and gets a "rotation" that
    // changes nothing while reporting every row as already current.
    expect(() => ring(NEW, NEW)).toThrow(ProvisioningSecretsError);
    expect(() => ring(NEW, OLD, NEW)).toThrow(/more than once/);
  });

  test("an all-empty value is refused", () => {
    expect(() => parseProvisioningKeyring("")).toThrow(
      ProvisioningSecretsError,
    );
    expect(() => parseProvisioningKeyring(" , , ")).toThrow(
      ProvisioningSecretsError,
    );
  });

  test("one malformed entry fails the whole ring, not just itself", () => {
    // Failing closed matters more than partial success: a ring that silently
    // dropped a bad entry could be missing the key some row needs.
    expect(() => ring(NEW, "not-a-key")).toThrow(ProvisioningSecretsError);
    expect(() => ring(NEW, "aa".repeat(16))).toThrow(/32 bytes/);
  });
});

describe("provisioningKeyringFromEnv", () => {
  test("returns null when unset or blank", () => {
    expect(provisioningKeyringFromEnv({})).toBeNull();
    expect(
      provisioningKeyringFromEnv({ [PROVISIONING_KEY_ENV]: "  " }),
    ).toBeNull();
  });

  test("reads a comma-separated rotation value", () => {
    const keyring = provisioningKeyringFromEnv({
      [PROVISIONING_KEY_ENV]: `${NEW},${OLD}`,
    });
    expect(keyring?.all).toHaveLength(2);
    expect(keyring?.primary.equals(parseProvisioningKey(NEW))).toBe(true);
  });
});

describe("sealing and opening across a rotation", () => {
  test("sealing always uses the primary, never an outgoing key", () => {
    const rotating = ring(NEW, OLD);
    const sealed = sealSecret(rotating, "alpha-buzz", "nsec-material");
    // Opens under the new key alone; the old one is irrelevant to it.
    expect(
      openSecret(
        singleKeyring(parseProvisioningKey(NEW)),
        "alpha-buzz",
        sealed,
      ),
    ).toBe("nsec-material");
    expect(() =>
      openSecret(
        singleKeyring(parseProvisioningKey(OLD)),
        "alpha-buzz",
        sealed,
      ),
    ).toThrow(ProvisioningSecretsError);
  });

  test("a row sealed under the outgoing key still opens, and says so", () => {
    const sealed = sealSecret(
      singleKeyring(parseProvisioningKey(OLD)),
      "alpha-buzz",
      "nsec-material",
    );
    const opened = openSecretDetailed(ring(NEW, OLD), "alpha-buzz", sealed);
    expect(opened.plaintext).toBe("nsec-material");
    // Index 1 is the fact the whole rotation turns on: this row is not yet on
    // the primary and the outgoing key cannot be dropped.
    expect(opened.keyIndex).toBe(1);
  });

  test("a row sealed under the primary reports index 0", () => {
    const rotating = ring(NEW, OLD);
    const sealed = sealSecret(rotating, "alpha-buzz", "nsec-material");
    expect(openSecretDetailed(rotating, "alpha-buzz", sealed).keyIndex).toBe(0);
  });

  test("both processes can read everything during the overlap window", () => {
    // The in-flight-deploy case: the old process seals under OLD, the new one
    // under NEW, and each holds both keys — so neither writes a row the other
    // cannot open.
    const oldProcess = ring(OLD, NEW);
    const newProcess = ring(NEW, OLD);
    const fromOld = sealSecret(oldProcess, "alpha-buzz", "from-old");
    const fromNew = sealSecret(newProcess, "alpha-buzz", "from-new");
    expect(openSecret(newProcess, "alpha-buzz", fromOld)).toBe("from-old");
    expect(openSecret(oldProcess, "alpha-buzz", fromNew)).toBe("from-new");
  });

  test("a row under neither key fails closed with both key counts named", () => {
    const stranded = sealSecret(
      singleKeyring(parseProvisioningKey(THIRD)),
      "alpha-buzz",
      "nsec-material",
    );
    expect(() => openSecret(ring(NEW, OLD), "alpha-buzz", stranded)).toThrow(
      /any of the 2 configured key\(s\)/,
    );
  });

  test("endpoint binding still holds with several keys on the ring", () => {
    // Trying every key must not become a way around the AAD binding: a
    // ciphertext moved to another row stays unopenable no matter how many keys
    // are tried.
    const rotating = ring(NEW, OLD);
    const sealed = sealSecret(rotating, "alpha-buzz", "nsec-material");
    expect(() => openSecret(rotating, "other-buzz", sealed)).toThrow(
      ProvisioningSecretsError,
    );
  });

  test("a tampered envelope fails under every key rather than opening under one", () => {
    const rotating = ring(NEW, OLD);
    const sealed = sealSecret(rotating, "alpha-buzz", "nsec-material");
    const parts = sealed.split(".");
    const flipped = Buffer.from(parts[3]!, "base64url");
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() =>
      openSecret(
        rotating,
        "alpha-buzz",
        [parts[0], parts[1], parts[2], flipped.toString("base64url")].join("."),
      ),
    ).toThrow(ProvisioningSecretsError);
  });

  test("a malformed envelope is rejected before any key is tried", () => {
    const rotating = ring(NEW, OLD);
    for (const bad of ["", "v1.a.b", "v2.a.b.c"]) {
      expect(() => openSecret(rotating, "alpha-buzz", bad)).toThrow(
        /malformed or from an unknown version|invalid nonce/,
      );
    }
  });

  test("an error message never carries the plaintext it failed to open", () => {
    const stranded = sealSecret(
      singleKeyring(parseProvisioningKey(THIRD)),
      "alpha-buzz",
      "nsec1supersecretmaterial",
    );
    try {
      openSecret(ring(NEW, OLD), "alpha-buzz", stranded);
      throw new Error("expected a failure");
    } catch (error) {
      expect(String(error)).not.toContain("nsec1supersecret");
    }
  });
});
