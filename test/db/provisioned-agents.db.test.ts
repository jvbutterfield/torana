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

// US-034 — the staging columns and the purge sweep's read path.
describe("staged deletion", () => {
  test("stage writes both columns together and restore clears both", () => {
    insert();
    expect(
      db.stageProvisionedAgentDelete({
        agentId: "canary",
        stagedAt: "2026-08-09 00:00:00",
        purgeDeadline: "2026-08-12 00:00:00",
      }),
    ).toBe(true);
    expect(db.getProvisionedAgent("canary")).toMatchObject({
      lifecycle: "staged_delete",
      stagedAt: "2026-08-09 00:00:00",
      purgeDeadline: "2026-08-12 00:00:00",
    });
    expect(db.restoreProvisionedAgent("canary")).toBe(true);
    expect(db.getProvisionedAgent("canary")).toMatchObject({
      lifecycle: "active",
      stagedAt: null,
      purgeDeadline: null,
    });
  });

  test("the schema refuses a half-applied stage", () => {
    // The CHECK is what makes "both columns move together" true even against a
    // writer that bypasses this layer. A lifecycle without a deadline would be
    // a row the sweep skips forever.
    insert();
    const raw = new Database(dbPath);
    try {
      expect(() =>
        raw
          .prepare(
            "UPDATE provisioned_agents SET lifecycle='staged_delete' WHERE agent_id=?",
          )
          .run("canary"),
      ).toThrow();
    } finally {
      raw.close();
    }
    expect(db.getProvisionedAgent("canary")?.lifecycle).toBe("active");
  });

  test("staging refuses a row that is already staged", () => {
    // Backfill overlap redelivers tombstones. Re-staging would push the
    // deadline out on every reconnect and the grace window would never end.
    insert();
    db.stageProvisionedAgentDelete({
      agentId: "canary",
      stagedAt: "2026-08-09 00:00:00",
      purgeDeadline: "2026-08-12 00:00:00",
    });
    expect(
      db.stageProvisionedAgentDelete({
        agentId: "canary",
        stagedAt: "2026-08-10 00:00:00",
        purgeDeadline: "2026-08-13 00:00:00",
      }),
    ).toBe(false);
    expect(db.getProvisionedAgent("canary")?.purgeDeadline).toBe(
      "2026-08-12 00:00:00",
    );
  });

  test("only the explicit hatch may rewrite a deadline, and only on a staged row", () => {
    insert();
    expect(
      db.setProvisionedAgentPurgeDeadline("canary", "2026-08-09 00:00:00"),
    ).toBe(false);
    db.stageProvisionedAgentDelete({
      agentId: "canary",
      stagedAt: "2026-08-09 00:00:00",
      purgeDeadline: "2026-08-12 00:00:00",
    });
    expect(
      db.setProvisionedAgentPurgeDeadline("canary", "2026-08-09 00:00:00"),
    ).toBe(true);
    expect(db.getProvisionedAgent("canary")?.purgeDeadline).toBe(
      "2026-08-09 00:00:00",
    );
  });

  test("the sweep reads only expired staged rows, oldest deadline first", () => {
    insert();
    insert({ agentId: "second", derivedPubkey: "pub-second" });
    insert({ agentId: "third", derivedPubkey: "pub-third" });
    db.stageProvisionedAgentDelete({
      agentId: "canary",
      stagedAt: "2026-08-09 00:00:00",
      purgeDeadline: "2026-08-12 00:00:00",
    });
    db.stageProvisionedAgentDelete({
      agentId: "second",
      stagedAt: "2026-08-09 00:00:00",
      purgeDeadline: "2026-08-10 00:00:00",
    });
    // `third` stays active: no deadline, so nothing may ever sweep it (D2).
    expect(
      db
        .listProvisionedAgentsDueForPurge("2026-08-13 00:00:00")
        .map((row) => row.agentId),
    ).toEqual(["second", "canary"]);
    expect(
      db
        .listProvisionedAgentsDueForPurge("2026-08-11 00:00:00")
        .map((row) => row.agentId),
    ).toEqual(["second"]);
    expect(db.listProvisionedAgentsDueForPurge("2026-08-09 00:00:00")).toEqual(
      [],
    );
  });
});

describe("tombstone cursors", () => {
  test("round-trips, and an unknown relay reads as null", () => {
    expect(db.getTombstoneCursor("wss://relay.example")).toBeNull();
    db.advanceTombstoneCursor({
      relayUrl: "wss://relay.example",
      lastCreatedAt: 1_700_000_000,
      lastEventId: "aa".repeat(32),
    });
    expect(db.getTombstoneCursor("wss://relay.example")).toMatchObject({
      lastCreatedAt: 1_700_000_000,
      lastEventId: "aa".repeat(32),
    });
  });

  test("never moves backwards, so a late old event cannot rewind the window", () => {
    db.advanceTombstoneCursor({
      relayUrl: "wss://relay.example",
      lastCreatedAt: 1_700_000_000,
      lastEventId: "new",
    });
    db.advanceTombstoneCursor({
      relayUrl: "wss://relay.example",
      lastCreatedAt: 1_600_000_000,
      lastEventId: "old",
    });
    expect(db.getTombstoneCursor("wss://relay.example")).toMatchObject({
      lastCreatedAt: 1_700_000_000,
      lastEventId: "new",
    });
  });

  test("cursors are per relay", () => {
    db.advanceTombstoneCursor({
      relayUrl: "wss://a.example",
      lastCreatedAt: 1,
      lastEventId: null,
    });
    db.advanceTombstoneCursor({
      relayUrl: "wss://b.example",
      lastCreatedAt: 2,
      lastEventId: null,
    });
    expect(db.getTombstoneCursor("wss://a.example")?.lastCreatedAt).toBe(1);
    expect(db.getTombstoneCursor("wss://b.example")?.lastCreatedAt).toBe(2);
  });
});

describe("audit retrieval by signal", () => {
  test("returns only the requested signals, newest first", () => {
    insert();
    db.appendProvisioningAudit({
      agentId: "canary",
      signal: "create",
      actor: "provisioner",
      outcome: "created",
    });
    for (const outcome of ["unmatched_pubkey", "yaml_identity"]) {
      db.appendProvisioningAudit({
        agentId: "(unmatched)",
        signal: "tombstone_rejected",
        actor: "relay-tombstone",
        outcome,
      });
    }
    const rows = db.listProvisioningAuditBySignal(["tombstone_rejected"]);
    expect(rows.map((row) => row.outcome)).toEqual([
      "yaml_identity",
      "unmatched_pubkey",
    ]);
  });

  test("an empty signal list returns nothing rather than everything", () => {
    insert();
    db.appendProvisioningAudit({
      agentId: "canary",
      signal: "create",
      actor: "provisioner",
      outcome: "created",
    });
    expect(db.listProvisioningAuditBySignal([])).toEqual([]);
  });

  test("a purge record survives the agent it describes", () => {
    // `provisioning_audit` is deliberately not foreign-keyed: a cascade would
    // delete exactly the evidence that proves what was destroyed (R12.5).
    insert();
    db.appendProvisioningAudit({
      agentId: "canary",
      signal: "purge",
      actor: "purge-sweep",
      outcome: "purged",
      detail: { workspace_bytes: 42 },
    });
    db.deleteProvisionedAgent("canary");
    const rows = db.listProvisioningAudit("canary");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.signal).toBe("purge");
  });
});
