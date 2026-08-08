// US-031 — GatewayDB accessors for provisioned agents.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations } from "../../src/db/migrate.js";

let tmpDir: string;
let dbPath: string;
let db: GatewayDB;

/** Stage a row directly; the stage/restore API itself lands in Phase 5. */
function stageDirectly(agentId: string, deadline: string): void {
  const raw = new Database(dbPath);
  raw
    .prepare(
      `UPDATE provisioned_agents
          SET lifecycle='staged_delete', staged_at=?, purge_deadline=?
        WHERE agent_id=?`,
    )
    .run("2026-08-08T00:00:00Z", deadline, agentId);
  raw.close();
}

function insert(
  overrides: Partial<Parameters<GatewayDB["upsertProvisionedAgent"]>[0]> = {},
) {
  db.upsertProvisionedAgent({
    agentId: "canary",
    derivedPubkey: "pub-canary",
    harness: "claude",
    systemPrompt: "be terse",
    model: null,
    timeoutsJson: "{}",
    instructionVersion: "abc123def456",
    provisionedBy: "provisioner",
    ...overrides,
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-pa-db-"));
  dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
  db = new GatewayDB(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("provisioned agent accessors", () => {
  test("round-trips a row", () => {
    insert();
    const row = db.getProvisionedAgent("canary");
    expect(row?.agentId).toBe("canary");
    expect(row?.harness).toBe("claude");
    expect(row?.systemPrompt).toBe("be terse");
    expect(row?.model).toBeNull();
    expect(row?.lifecycle).toBe("active");
    expect(row?.purgeDeadline).toBeNull();
  });

  test("returns null for an unknown agent", () => {
    expect(db.getProvisionedAgent("nobody")).toBeNull();
  });

  test("looks up by the reconcile key", () => {
    insert();
    expect(db.getProvisionedAgentByPubkey("pub-canary")?.agentId).toBe(
      "canary",
    );
    expect(db.getProvisionedAgentByPubkey("pub-nobody")).toBeNull();
  });

  test("upsert updates in place rather than duplicating", () => {
    insert();
    insert({ systemPrompt: "be verbose", instructionVersion: "ffffffffffff" });
    expect(db.listProvisionedAgents()).toHaveLength(1);
    const row = db.getProvisionedAgent("canary");
    expect(row?.systemPrompt).toBe("be verbose");
    expect(row?.instructionVersion).toBe("ffffffffffff");
  });

  test("lists in a stable order", () => {
    insert({ agentId: "zeta", derivedPubkey: "pub-zeta" });
    insert({ agentId: "alpha", derivedPubkey: "pub-alpha" });
    expect(db.listProvisionedAgents().map((r) => r.agentId)).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  test("counts every row, staged included (R11.1)", () => {
    insert();
    insert({ agentId: "second", derivedPubkey: "pub-second" });
    expect(db.countProvisionedAgents()).toBe(2);
    // A staged row still holds an identity, a workspace, and sealed secrets,
    // so it must keep occupying a slot in the cap.
    stageDirectly("second", "2026-08-11T00:00:00Z");
    expect(db.countProvisionedAgents()).toBe(2);
  });

  test("an ordinary upsert cannot un-stage a pending deletion", () => {
    // A reconcile deploy fires on every community UI load. If it reset
    // lifecycle, a staged deletion would be silently cancelled by a page view.
    insert();
    stageDirectly("canary", "2026-08-11T00:00:00Z");
    insert({ systemPrompt: "changed" });
    const row = db.getProvisionedAgent("canary");
    expect(row?.lifecycle).toBe("staged_delete");
    expect(row?.purgeDeadline).toBe("2026-08-11T00:00:00Z");
    expect(row?.systemPrompt).toBe("changed");
  });

  test("re-persists a recomputed instruction version alone", () => {
    insert();
    const before = db.getProvisionedAgent("canary");
    expect(
      db.setProvisionedAgentInstructionVersion("canary", "0123456789ab"),
    ).toBe(true);
    const after = db.getProvisionedAgent("canary");
    expect(after?.instructionVersion).toBe("0123456789ab");
    expect(after?.systemPrompt).toBe(before?.systemPrompt);
  });

  test("re-persisting a version for an unknown agent reports failure", () => {
    expect(
      db.setProvisionedAgentInstructionVersion("nobody", "0123456789ab"),
    ).toBe(false);
  });

  test("delete removes the row and reports whether it existed", () => {
    insert();
    expect(db.deleteProvisionedAgent("canary")).toBe(true);
    expect(db.deleteProvisionedAgent("canary")).toBe(false);
    expect(db.listProvisionedAgents()).toEqual([]);
  });
});
