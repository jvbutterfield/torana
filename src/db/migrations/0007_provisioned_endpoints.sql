PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

-- Buzz endpoints created at runtime by the provisioning API rather than
-- declared in torana.yaml. The row is the durable record; the running
-- supervisor is derived from it at startup and on every provisioning call.
--
-- Secrets are stored encrypted (AES-256-GCM) under a key supplied by
-- TORANA_PROVISIONING_SECRETS_KEY, which is deliberately *not* in this
-- database: a stolen or restored volume without that env var yields rows that
-- cannot be decrypted, and startup fails closed rather than silently running
-- an endpoint whose identity nobody can verify.
CREATE TABLE provisioned_endpoints (
  endpoint_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  -- Pubkey derived from the private key. Reconciliation is keyed on this, not
  -- on the endpoint id, because the identity is what the relay authenticates.
  derived_pubkey TEXT NOT NULL,
  -- Normalized endpoint block, secrets removed, as it would appear under
  -- agents[].endpoints[] in YAML. Re-validated through the same schema on
  -- every load.
  config_json TEXT NOT NULL,
  private_key_ciphertext TEXT NOT NULL,
  auth_tag_ciphertext TEXT,
  provisioned_by TEXT NOT NULL,
  deploy_nonce TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One live endpoint per identity (spec invariant I4, within Torana's scope).
CREATE UNIQUE INDEX idx_provisioned_endpoints_pubkey
  ON provisioned_endpoints(derived_pubkey);

CREATE INDEX idx_provisioned_endpoints_agent
  ON provisioned_endpoints(agent_id);

PRAGMA user_version = 7;
COMMIT;
