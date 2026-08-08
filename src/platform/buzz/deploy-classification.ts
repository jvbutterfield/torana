// The deploy decision table (plan §3.1).
//
// One route — `PUT /v1/admin/buzz/endpoints/:id` — now serves two kinds of
// agent, so "what does this deploy mean?" stopped being obvious enough to
// leave inline. Every gate is evaluated **before any write**, and the order
// matters: after this plan, an id unknown to YAML means *create*, so the YAML
// gates have to fire first or a typo'd id would silently provision a new agent
// next to the one the operator meant.
//
// Classification is deliberately separated from mutation. It is pure, so every
// row of the table can be tested without a database, a transport, or a
// workspace — which is the only realistic way to get coverage of rows that are
// hard to reach live (a publisher id, an identity bound elsewhere, a deploy
// landing on a staged deletion).

import type { ProvisionedAgentRow } from "../../db/gateway-db.js";

/** What the caller supplied about the agent itself, if anything. */
export interface DeployAgentBlock {
  harness?: string;
  system_prompt?: string;
  model?: string | null;
  turn_timeout_seconds?: number | null;
  idle_timeout_seconds?: number | null;
  max_turn_duration_seconds?: number | null;
}

export interface ClassifyInput {
  agentId: string;
  /** Pubkey derived from the submitted nsec — the reconcile key (R2.2). */
  pubkey: string;
  /** Present only when the provider sent an `agent` block. */
  agent?: DeployAgentBlock;
  /** Required to create: without it nothing can ever authorize a delete. */
  ownerPubkey?: string;
  /** YAML agent ids that declare a runner. */
  yamlAgentIdsWithRunner: ReadonlySet<string>;
  /** YAML agent ids with no runner — publishers and the like. */
  yamlAgentIdsWithoutRunner: ReadonlySet<string>;
  /** The provisioned record for this id, if one exists. */
  existingAgent: ProvisionedAgentRow | null;
  /** The provisioned record bound to this pubkey, if a different one exists. */
  agentBoundToPubkey: ProvisionedAgentRow | null;
  /** A YAML Buzz identity matching this pubkey, if any. */
  yamlIdentityOwner: string | null;
}

export type DeployClassification =
  /** Row 1 — a YAML agent with a runner: today's endpoint-attach path. */
  | { kind: "yaml_attach"; instructionsApplied: false }
  /** Row 3 — create the agent, its workspace, and its endpoint. */
  | { kind: "create_provisioned"; agent: DeployAgentBlock; ownerPubkey: string }
  /** Row 5 — an existing provisioned agent; the caller diffs to decide. */
  | { kind: "reconcile_provisioned"; existing: ProvisionedAgentRow }
  /** Row 7 — a deploy landing on a staged deletion: fresh owner intent. */
  | { kind: "unstage_provisioned"; existing: ProvisionedAgentRow }
  /** Rows 2, 4, 6 — refuse, with the reason the operator needs. */
  | { kind: "reject"; code: RejectCode; message: string };

export type RejectCode =
  | "conflict"
  | "invalid_request"
  | "unknown_agent"
  | "missing_owner";

function list(ids: Iterable<string>): string {
  const sorted = [...ids].sort();
  return sorted.length > 0 ? sorted.join(", ") : "(none)";
}

/**
 * Decide what a deploy means. Pure: no reads, no writes, no clock.
 *
 * Ordering is load-bearing and is asserted by tests, not just by reading:
 * identity conflicts are checked before the id is even considered, because a
 * pubkey bound to a different agent is a conflict no matter which id it
 * arrives under.
 */
export function classifyDeploy(input: ClassifyInput): DeployClassification {
  // ── Identity conflicts (row 6) ────────────────────────────────────────────
  // First, and independent of the id: one identity backs at most one agent.
  if (input.yamlIdentityOwner !== null) {
    return {
      kind: "reject",
      code: "conflict",
      message: `that identity is managed by static config as agent '${input.yamlIdentityOwner}'`,
    };
  }
  if (
    input.agentBoundToPubkey &&
    input.agentBoundToPubkey.agentId !== input.agentId
  ) {
    return {
      kind: "reject",
      code: "conflict",
      message: `that identity is already deployed as agent '${input.agentBoundToPubkey.agentId}'`,
    };
  }
  if (
    input.existingAgent &&
    input.existingAgent.derivedPubkey !== input.pubkey
  ) {
    // The mirror case: the id is known but arrives under a new identity. Left
    // as a conflict rather than a silent re-key, because the pubkey is what
    // the relay authenticates and what a tombstone will be matched against.
    return {
      kind: "reject",
      code: "conflict",
      message: `agent '${input.agentId}' is already deployed under a different identity`,
    };
  }

  // ── YAML precedence (rows 1 and 2) ────────────────────────────────────────
  if (input.yamlAgentIdsWithRunner.has(input.agentId)) {
    // Instruction fields are reported not-applied by the caller (R3.5); the
    // record store is never touched for a YAML id (R1.4).
    return { kind: "yaml_attach", instructionsApplied: false };
  }
  if (input.yamlAgentIdsWithoutRunner.has(input.agentId)) {
    // R1.5, made loud. Before this plan a runner-less YAML id was merely
    // "unknown"; now "unknown" means *create*, so without this gate a deploy
    // naming a publisher would quietly provision a second agent beside it.
    return {
      kind: "reject",
      code: "conflict",
      message: `agent '${input.agentId}' is managed by static config`,
    };
  }

  // ── Known provisioned record (rows 5 and 7) ───────────────────────────────
  if (input.existingAgent) {
    return input.existingAgent.lifecycle === "staged_delete"
      ? { kind: "unstage_provisioned", existing: input.existingAgent }
      : { kind: "reconcile_provisioned", existing: input.existingAgent };
  }

  // ── Unknown everywhere (rows 3 and 4) ─────────────────────────────────────
  if (!input.agent) {
    return {
      kind: "reject",
      code: "unknown_agent",
      message:
        `unknown agent '${input.agentId}' and no agent block was supplied. ` +
        `Either the provider predates Desktop-managed agents, or this id is a ` +
        `typo. Configured agents: ${list(input.yamlAgentIdsWithRunner)}`,
    };
  }
  if (!input.agent.harness) {
    return {
      kind: "reject",
      code: "invalid_request",
      message: `creating agent '${input.agentId}' requires a harness name`,
    };
  }
  if (!input.ownerPubkey) {
    // Without an owner nothing can ever authorize `!shutdown` and no tombstone
    // can be verified, so an ownerless provisioned agent would be undeletable
    // by design — invisible until the first delete attempt.
    return {
      kind: "reject",
      code: "missing_owner",
      message:
        `creating agent '${input.agentId}' requires owner_pubkey: without it ` +
        `the agent could never be stopped or deleted from the Desktop`,
    };
  }
  return {
    kind: "create_provisioned",
    agent: input.agent,
    ownerPubkey: input.ownerPubkey,
  };
}
