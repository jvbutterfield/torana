// US-032 — every row of the deploy decision table (plan §3.1).
//
// The table is the safety boundary for the whole feature: after this plan an
// id unknown to YAML means *create*, so a mis-ordered gate turns a typo into a
// silently provisioned agent, and a missed conflict turns one identity into
// two agents. Rows are tested individually and the *ordering* between them is
// tested too, because "checks all present" and "checks in the right order" are
// different properties and only the second one is true here.

import { describe, expect, test } from "bun:test";

import {
  classifyDeploy,
  type ClassifyInput,
} from "../../src/platform/buzz/deploy-classification.js";
import type { ProvisionedAgentRow } from "../../src/db/gateway-db.js";

function agentRow(
  overrides: Partial<ProvisionedAgentRow> = {},
): ProvisionedAgentRow {
  return {
    agentId: "canary",
    derivedPubkey: "pub-canary",
    harness: "claude",
    systemPrompt: "",
    model: null,
    timeoutsJson: "{}",
    instructionVersion: "abc123def456",
    lifecycle: "active",
    stagedAt: null,
    purgeDeadline: null,
    provisionedBy: "provisioner",
    createdAt: "2026-08-08T00:00:00Z",
    updatedAt: "2026-08-08T00:00:00Z",
    ...overrides,
  };
}

function input(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    agentId: "canary",
    pubkey: "pub-canary",
    yamlAgentIdsWithRunner: new Set(["yamlbot"]),
    reservedYamlIds: new Set(["dev-team"]),
    existingAgent: null,
    agentBoundToPubkey: null,
    yamlIdentityOwner: null,
    ...overrides,
  };
}

const AGENT_BLOCK = { harness: "claude", system_prompt: "be terse" };

describe("row 1 — YAML agent with a runner", () => {
  test("takes the endpoint-attach path and applies no instructions", () => {
    const result = classifyDeploy(
      input({ agentId: "yamlbot", agent: AGENT_BLOCK, ownerPubkey: "owner" }),
    );
    expect(result.kind).toBe("yaml_attach");
    // Even though instruction fields were supplied, they are not applied —
    // the provider reports them as such (R3.5).
    expect(result).toMatchObject({ instructionsApplied: false });
  });
});

describe("row 2 — an id YAML has already claimed (publisher)", () => {
  test("is refused loudly and changes nothing (R1.5)", () => {
    // Before this plan such an id was merely "unknown". Now "unknown" means
    // create, so without this gate a deploy naming a publisher reaches the
    // create path and dies deep inside schema validation complaining about
    // publisher uniqueness — true, but useless to the operator.
    const result = classifyDeploy(
      input({ agentId: "dev-team", agent: AGENT_BLOCK, ownerPubkey: "owner" }),
    );
    expect(result).toEqual({
      kind: "reject",
      code: "conflict",
      message: "agent 'dev-team' is managed by static config",
    });
  });

  test("is refused even with no agent block", () => {
    const result = classifyDeploy(input({ agentId: "dev-team" }));
    expect(result).toMatchObject({ kind: "reject", code: "conflict" });
  });
});

describe("row 3 — create", () => {
  test("an unknown id with a valid agent block and an owner creates", () => {
    const result = classifyDeploy(
      input({ agent: AGENT_BLOCK, ownerPubkey: "owner-hex" }),
    );
    expect(result).toEqual({
      kind: "create_provisioned",
      agent: AGENT_BLOCK,
      ownerPubkey: "owner-hex",
    });
  });

  test("refuses without owner_pubkey — an ownerless agent is undeletable", () => {
    // The failure would be invisible until the first delete: nothing could
    // authorize !shutdown and no tombstone could ever be verified.
    const result = classifyDeploy(input({ agent: AGENT_BLOCK }));
    expect(result).toMatchObject({ kind: "reject", code: "missing_owner" });
    expect((result as { message: string }).message).toContain("owner_pubkey");
  });

  test("refuses an agent block with no harness", () => {
    const result = classifyDeploy(
      input({ agent: { system_prompt: "hi" }, ownerPubkey: "owner" }),
    );
    expect(result).toMatchObject({
      kind: "reject",
      code: "invalid_request",
    });
  });
});

describe("row 4 — unknown id, no agent block", () => {
  test("is an actionable error naming the configured agents", () => {
    const result = classifyDeploy(input({ agentId: "typo" }));
    expect(result).toMatchObject({ kind: "reject", code: "unknown_agent" });
    const message = (result as { message: string }).message;
    expect(message).toContain("yamlbot");
    expect(message).toContain("typo");
  });
});

describe("row 5 — existing provisioned record", () => {
  test("reconciles when active", () => {
    const existing = agentRow();
    const result = classifyDeploy(input({ existingAgent: existing }));
    expect(result).toEqual({ kind: "reconcile_provisioned", existing });
  });

  test("reconciles even when no agent block is sent", () => {
    // An old provider, or a reconcile deploy: the record already exists, so
    // there is nothing to create and nothing to refuse.
    const existing = agentRow();
    const result = classifyDeploy(
      input({ existingAgent: existing, agent: undefined }),
    );
    expect(result.kind).toBe("reconcile_provisioned");
  });
});

describe("row 6 — identity conflicts", () => {
  test("an identity already bound to a different provisioned agent", () => {
    const other = agentRow({ agentId: "other", derivedPubkey: "pub-canary" });
    const result = classifyDeploy(input({ agentBoundToPubkey: other }));
    expect(result).toMatchObject({ kind: "reject", code: "conflict" });
    expect((result as { message: string }).message).toContain("'other'");
  });

  test("an identity managed by static config", () => {
    const result = classifyDeploy(input({ yamlIdentityOwner: "yamlbot" }));
    expect(result).toMatchObject({ kind: "reject", code: "conflict" });
    expect((result as { message: string }).message).toContain("static config");
  });

  test("a known id arriving under a different identity", () => {
    // The pubkey is what the relay authenticates and what a tombstone is
    // matched against, so a silent re-key would break delete verification.
    const result = classifyDeploy(
      input({ existingAgent: agentRow({ derivedPubkey: "pub-different" }) }),
    );
    expect(result).toMatchObject({ kind: "reject", code: "conflict" });
    expect((result as { message: string }).message).toContain(
      "different identity",
    );
  });

  test("the same identity under the same id is not a conflict", () => {
    const existing = agentRow();
    const result = classifyDeploy(
      input({ existingAgent: existing, agentBoundToPubkey: existing }),
    );
    expect(result.kind).toBe("reconcile_provisioned");
  });
});

describe("row 7 — deploy onto a staged deletion", () => {
  test("un-stages rather than reconciling", () => {
    // The Desktop record was deleted, so only a deliberate re-create with the
    // same identity reaches this. Treated as fresh owner intent, and the
    // caller logs and audits it loudly.
    const existing = agentRow({
      lifecycle: "staged_delete",
      stagedAt: "2026-08-08T00:00:00Z",
      purgeDeadline: "2026-08-11T00:00:00Z",
    });
    const result = classifyDeploy(input({ existingAgent: existing }));
    expect(result).toEqual({ kind: "unstage_provisioned", existing });
  });
});

describe("gate ordering", () => {
  test("identity conflicts are checked before YAML precedence", () => {
    // Otherwise a stolen identity arriving under a YAML id would take the
    // attach path and the conflict would never be reported.
    const result = classifyDeploy(
      input({
        agentId: "yamlbot",
        agentBoundToPubkey: agentRow({ agentId: "other" }),
      }),
    );
    expect(result).toMatchObject({ kind: "reject", code: "conflict" });
  });

  test("YAML precedence is checked before the create path", () => {
    // The gate that stops a typo'd publisher id becoming a new agent.
    const result = classifyDeploy(
      input({
        agentId: "dev-team",
        agent: AGENT_BLOCK,
        ownerPubkey: "owner",
      }),
    );
    expect(result.kind).toBe("reject");
  });

  test("YAML precedence is checked before an existing provisioned record", () => {
    // Belt and braces: a YAML id must never resolve to a provisioned record
    // even if one somehow exists for it, because YAML always wins (R1.4).
    const result = classifyDeploy(
      input({
        agentId: "yamlbot",
        existingAgent: agentRow({
          agentId: "yamlbot",
          derivedPubkey: "pub-canary",
        }),
      }),
    );
    expect(result.kind).toBe("yaml_attach");
  });

  test("a staged record is un-staged, not treated as a create", () => {
    const result = classifyDeploy(
      input({
        existingAgent: agentRow({
          lifecycle: "staged_delete",
          stagedAt: "2026-08-08T00:00:00Z",
          purgeDeadline: "2026-08-11T00:00:00Z",
        }),
        agent: AGENT_BLOCK,
        ownerPubkey: "owner",
      }),
    );
    expect(result.kind).toBe("unstage_provisioned");
  });
});
