// Encryption at rest for provisioned-endpoint secrets.
//
// YAML endpoints get their private key and auth tag from env interpolation at
// startup, and the deployment materializes those into a non-persistent runtime
// directory — so there was no durable secret store to reuse when endpoints
// became creatable at runtime. Provisioned rows therefore carry their own
// ciphertext, encrypted under a key that lives only in the process
// environment.
//
// The key is deliberately *not* in the database. A copied, restored, or stolen
// volume is not enough to recover an agent identity, and a restore without the
// env var yields rows that fail closed instead of an endpoint nobody can
// account for.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const PROVISIONING_KEY_ENV = "TORANA_PROVISIONING_SECRETS_KEY";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Bumped if the envelope format ever changes; refuse anything unrecognized. */
const VERSION = "v1";

export class ProvisioningSecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisioningSecretsError";
  }
}

/**
 * Parse one configured key. Accepts 64 hex characters or standard base64 —
 * both are 32 bytes, and operators generate these with whichever of
 * `openssl rand -hex 32` / `-base64 32` they reach for first.
 */
export function parseProvisioningKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ProvisioningSecretsError(`${PROVISIONING_KEY_ENV} is empty`);
  }
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else if (/^[A-Za-z0-9+/]{43}=?$/.test(trimmed)) {
    key = Buffer.from(trimmed, "base64");
  } else {
    throw new ProvisioningSecretsError(
      `${PROVISIONING_KEY_ENV} must be 32 bytes as 64 hex characters or base64`,
    );
  }
  if (key.length !== KEY_BYTES) {
    throw new ProvisioningSecretsError(
      `${PROVISIONING_KEY_ENV} must decode to ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

/**
 * The keys this process may use, primary first (R9.6).
 *
 * Rotation needs two keys to coexist for one deploy: the new primary, which
 * everything is sealed under from now on, and the outgoing one, which existing
 * rows are still sealed under until they are re-sealed. Expressed as a type
 * rather than a bare array so that "seal with the primary, open with any" is
 * visible at every call site instead of being a convention about index 0.
 */
export interface ProvisioningKeyring {
  /** Everything sealed from now on uses this one. */
  primary: Buffer;
  /** Primary first, then the keys kept only so old rows still open. */
  all: Buffer[];
}

/**
 * Build a keyring from the raw env value: comma-separated, primary first.
 *
 * Duplicates are rejected rather than tolerated. A repeated key is almost
 * always a half-finished edit — an operator who meant to prepend a new primary
 * and instead pasted the existing one would otherwise get a "rotation" that
 * silently changes nothing and reports every row as already current.
 */
export function parseProvisioningKeyring(raw: string): ProvisioningKeyring {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) {
    throw new ProvisioningSecretsError(`${PROVISIONING_KEY_ENV} is empty`);
  }
  const all = parts.map((part) => parseProvisioningKey(part));
  const seen = new Set<string>();
  for (const key of all) {
    const fingerprint = key.toString("base64");
    if (seen.has(fingerprint)) {
      throw new ProvisioningSecretsError(
        `${PROVISIONING_KEY_ENV} lists the same key more than once; ` +
          `during a rotation it should be "<new primary>,<outgoing key>"`,
      );
    }
    seen.add(fingerprint);
  }
  return { primary: all[0]!, all };
}

/**
 * Read the keyring from the environment. Returns null when unset — callers
 * decide whether that is fine (no provisioned rows) or fatal (rows exist).
 */
export function provisioningKeyringFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProvisioningKeyring | null {
  const raw = env[PROVISIONING_KEY_ENV];
  if (raw === undefined || raw.trim() === "") return null;
  return parseProvisioningKeyring(raw);
}

/** A keyring holding one key, for callers that never rotate (tests, tools). */
export function singleKeyring(key: Buffer): ProvisioningKeyring {
  return { primary: key, all: [key] };
}

/**
 * Seal a secret under the ring's **primary** key. The envelope is
 * `v1.<iv>.<tag>.<ciphertext>`, all base64url, with the endpoint id bound in as
 * additional authenticated data so a ciphertext cannot be moved from one row to
 * another.
 *
 * Takes the keyring rather than a bare key so no call site can accidentally
 * seal under an outgoing one: during a rotation both are loaded, and sealing
 * with the wrong one would write rows that die when the old key is removed.
 */
export function sealSecret(
  keyring: ProvisioningKeyring,
  endpointId: string,
  plaintext: string,
): string {
  const key = keyring.primary;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(endpointId, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Open a sealed secret with any key on the ring, newest first.
 *
 * Returns which key opened it, because that is the fact rotation turns on: a
 * non-zero index means the row is still sealed under an outgoing key and has to
 * be re-sealed before that key can be removed. Reporting it here rather than
 * re-deriving it later keeps the answer to "is this rotation finished?" honest.
 *
 * Throws on a wrong key, a tampered row, or a row moved between endpoints.
 */
export function openSecretDetailed(
  keyring: ProvisioningKeyring,
  endpointId: string,
  envelope: string,
): { plaintext: string; keyIndex: number } {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new ProvisioningSecretsError(
      "provisioned secret envelope is malformed or from an unknown version",
    );
  }
  const iv = Buffer.from(parts[1]!, "base64url");
  const tag = Buffer.from(parts[2]!, "base64url");
  const ciphertext = Buffer.from(parts[3]!, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new ProvisioningSecretsError(
      "provisioned secret envelope has an invalid nonce or tag length",
    );
  }
  for (const [keyIndex, key] of keyring.all.entries()) {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAAD(Buffer.from(endpointId, "utf8"));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
      return { plaintext, keyIndex };
    } catch {
      // Wrong key for this row, or a tampered row. Either way, try the next —
      // GCM gives no way to tell them apart, which is the point.
    }
  }
  // Never echo a cause: on a GCM failure it carries nothing useful and the
  // message is a place secrets could leak.
  throw new ProvisioningSecretsError(
    `provisioned secret for '${endpointId}' could not be decrypted with any of ` +
      `the ${keyring.all.length} configured key(s); ${PROVISIONING_KEY_ENV} is ` +
      `missing the right key, or the row was altered`,
  );
}

/** Open a sealed secret. Throws on a wrong key, a tampered row, or a moved row. */
export function openSecret(
  keyring: ProvisioningKeyring,
  endpointId: string,
  envelope: string,
): string {
  return openSecretDetailed(keyring, endpointId, envelope).plaintext;
}

/**
 * Constant-time bearer comparison for the provisioning admin token. The
 * dedicated token is the only thing standing between the public edge and
 * creating an endpoint, so it is not compared with `===`.
 */
export function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) {
    // Still burn a comparison so a length mismatch is not measurably faster.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
