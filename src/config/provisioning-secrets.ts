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
 * Parse the configured key. Accepts 64 hex characters or standard base64 —
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
 * Read the key from the environment. Returns null when unset — callers decide
 * whether that is fine (no provisioned rows) or fatal (rows exist).
 */
export function provisioningKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  const raw = env[PROVISIONING_KEY_ENV];
  if (raw === undefined || raw.trim() === "") return null;
  return parseProvisioningKey(raw);
}

/**
 * Seal a secret. The envelope is `v1.<iv>.<tag>.<ciphertext>`, all base64url,
 * with the endpoint id bound in as additional authenticated data so a
 * ciphertext cannot be moved from one row to another.
 */
export function sealSecret(
  key: Buffer,
  endpointId: string,
  plaintext: string,
): string {
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

/** Open a sealed secret. Throws on a wrong key, a tampered row, or a moved row. */
export function openSecret(
  key: Buffer,
  endpointId: string,
  envelope: string,
): string {
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
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(endpointId, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Never echo the cause: on a GCM failure it carries nothing useful and the
    // message is a place secrets could leak.
    throw new ProvisioningSecretsError(
      `provisioned secret for '${endpointId}' could not be decrypted; ` +
        `${PROVISIONING_KEY_ENV} is missing, wrong, or the row was altered`,
    );
  }
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
