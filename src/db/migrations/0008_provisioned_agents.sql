PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

-- Agents whose *definition* lives here rather than in torana.yaml, created by
-- a Buzz Desktop deploy through the provisioning API.
--
-- The row is not a config file in disguise. It holds only what the Desktop
-- owns — harness selection by name, instructions, model, requested timeouts —
-- and Torana synthesizes a complete v2 agent block from it at load and deploy
-- time, then runs that projection through the unchanged ConfigV2Schema. The
-- runner path and base environment come from the operator's harness allowlist,
-- never from the payload, so a Desktop record can never name a binary.
--
-- A provisioned agent's endpoint stays in provisioned_endpoints (id
-- `<agent_id>-buzz`), written in the same transaction as the row here.
CREATE TABLE provisioned_agents (
  agent_id TEXT PRIMARY KEY,
  -- Reconcile key, and the same identity the endpoint authenticates with.
  -- Unique because one identity may back exactly one agent (invariant I4,
  -- extended from endpoints to agent definitions).
  derived_pubkey TEXT NOT NULL UNIQUE,
  -- Name from provisioning.harnesses. Validated against the allowlist on every
  -- projection, not just at create: an operator may remove a harness, and that
  -- must surface as a doctor failure rather than a silent fallback.
  harness TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  -- NULL means "use the harness default" — distinct from the empty string,
  -- which would be an explicitly blank model and is rejected upstream.
  model TEXT,
  -- Desktop-supplied timeouts as received, *before* clamping. Storing the
  -- pre-clamp values keeps the deploy result honest ("you asked for X, I
  -- applied Y") and lets a later ceiling change re-clamp from the original
  -- request instead of from an already-clamped number.
  timeouts_json TEXT NOT NULL,
  -- sha256 over the canonical applied instruction set, first 12 hex chars.
  -- Recomputed at every projection because applied values depend on harness
  -- config: a harness edit changes what the agent actually runs, and the
  -- version must move with it rather than reporting a stale digest.
  instruction_version TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle IN ('active', 'staged_delete')),
  staged_at TEXT,
  -- Persisted rather than held in an in-memory timer: a restart mid-grace must
  -- neither resurrect a staged agent nor purge it early.
  purge_deadline TEXT,
  provisioned_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Staging state and its deadline move together. Without this, a half-applied
  -- stage (lifecycle moved, deadline missing) would be a row the purge sweep
  -- silently skips forever, and a restore that cleared lifecycle but left the
  -- deadline would purge a live agent.
  CHECK (
    (lifecycle = 'staged_delete') = (purge_deadline IS NOT NULL)
    AND (lifecycle = 'staged_delete') = (staged_at IS NOT NULL)
  )
);

-- The purge sweep reads by deadline; every other row is dead weight to it.
CREATE INDEX idx_provisioned_agents_purge_deadline
  ON provisioned_agents(purge_deadline)
  WHERE purge_deadline IS NOT NULL;

CREATE INDEX idx_provisioned_agents_lifecycle
  ON provisioned_agents(lifecycle);

-- Per-relay cursor for the tombstone watcher's backfill.
--
-- Keyed on the relay URL because the watcher holds one connection per distinct
-- relay across all provisioned agents. On startup and on every reconnect the
-- watcher queries `since = last_created_at - overlap`; the event id lets it
-- distinguish "already processed this exact event" from "a second event landed
-- in the same second", which a timestamp alone cannot.
CREATE TABLE buzz_tombstone_cursors (
  relay_url TEXT PRIMARY KEY,
  last_created_at INTEGER NOT NULL,
  last_event_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only lifecycle audit.
--
-- Deliberately not foreign-keyed to provisioned_agents: the most important row
-- this table ever holds is the purge record, which by definition outlives the
-- agent it describes. A cascade would delete exactly the evidence that proves
-- what was destroyed. Retention pruning is an explicit operator action and
-- exempts purge records by default.
CREATE TABLE provisioning_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  -- create | update | start | stop | stage_delete | restore | purge | reject
  signal TEXT NOT NULL,
  -- Who caused it: a token name, `relay-tombstone`, or `operator-cli`. Never a
  -- secret; token *values* are never written here.
  actor TEXT NOT NULL,
  outcome TEXT NOT NULL,
  -- Free-form JSON. Prompts appear only as digests and secrets never appear;
  -- the existing scrub set covers writes to this column.
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_provisioning_audit_agent
  ON provisioning_audit(agent_id, created_at);

-- Retention pruning scans by age and must exclude purge records cheaply.
CREATE INDEX idx_provisioning_audit_created
  ON provisioning_audit(created_at, signal);

PRAGMA user_version = 8;
COMMIT;
