// The delete pipeline for Desktop-managed agents (R5, R12).
//
// Deletion is the most destructive thing this feature can do, and the protocol
// carries no delete op — so it is not a single check but a staged machine, and
// every transition here is persisted before it is acted on:
//
//   tombstone verified ──▶ staged_delete   drain endpoint, announce offline,
//                                          persist purge_deadline, alert
//        │ restore (operator) ──▶ active   endpoint stays down until the next
//        │                                 deploy or an explicit resume
//        └─ deadline passed ──▶ purge      audit record committed FIRST, then
//                                          endpoint, rows, and workspace
//
// Two rules shape everything below. **D2:** nothing but an owner-signed
// tombstone (or an explicit operator action through the API or CLI) may ever
// stage a deletion — there is no TTL, no idle timer, no presence heuristic, and
// absence from a reconcile set means nothing. **R12.5:** the purge audit record
// must outlive the data it describes, so it is written in its own committed
// transaction before the first byte is destroyed; a purge log deleted along
// with the agent proves nothing.

import { logger } from "../../log.js";
import type { AlertManager } from "../../alerts.js";
import type { GatewayDB, ProvisionedEndpointRow } from "../../db/gateway-db.js";
import type { ProvisioningConfig } from "../../config/v2.js";
import type { AgentTimeoutRegistry } from "./agent-timeouts.js";
import type { BuzzTransport } from "./transport.js";
import { STAGED_DELETE } from "./transport.js";
import {
  removeWorkspace,
  workspaceBytes,
  workspacePathFor,
} from "./provisioned-workspaces.js";
import { managedAgentCoordinate } from "./tombstone.js";

const log = logger("buzz.agent-lifecycle");

/** How often the purge sweep reads persisted deadlines (R14.4). */
export const PURGE_SWEEP_INTERVAL_MS = 300_000;

/**
 * Window over which stages are counted as one fan-out (spec §7.5).
 *
 * A persona-delete cascade arrives as N independent tombstones — live, one
 * frame at a time — so "stages in one sweep" cannot mean "stages in one array".
 * Counting over a short rolling window catches the cascade without delaying the
 * first stage, which R14.3 bounds at 10 s from delivery.
 */
export const FANOUT_WINDOW_MS = 5_000;

/** `signal` values written to `provisioning_audit` by this module. */
export const AUDIT_SIGNAL = Object.freeze({
  stage: "stage_delete",
  restore: "restore",
  purge: "purge",
  /** A tombstone that deleted nothing. Durable input to the R5.12 report. */
  rejectedTombstone: "tombstone_rejected",
});

export type StageTrigger =
  | {
      kind: "tombstone";
      eventId: string;
      ownerPubkey: string;
      relayUrl: string;
    }
  | { kind: "operator"; via: "api" | "cli" };

export interface StageResult {
  kind: "staged" | "already_staged" | "unknown_agent" | "not_configured";
  agentId: string;
  purgeDeadline?: string;
  /** Agents staged inside the current fan-out window, this one included. */
  fanout?: number;
}

export interface PurgeResult {
  agentId: string;
  /** False when the row was already gone — a converging re-run, not a failure. */
  destroyed: boolean;
  endpointRemoved: boolean;
  workspaceRemoved: boolean;
  workspaceBytes: number;
}

export interface AgentLifecycleDeps {
  db: GatewayDB;
  dataDir: string;
  /** Absent when the gateway cannot create agents at all; staging is inert. */
  provisioning: ProvisioningConfig | null;
  /**
   * Read lazily: the transport is built after this service, and after a
   * restart it is built *from* the endpoints this service can purge.
   */
  transport: () => BuzzTransport | null;
  alerts?: AlertManager | null;
  agentTimeouts?: AgentTimeoutRegistry | null;
  /** Deregisters the Bot at purge. Absent in tests with no registry. */
  agentRuntime?: { remove(agentId: string): boolean | void } | null;
  /** Lets the tombstone watcher re-evaluate its relay set after a change. */
  onFleetChanged?: (() => void) | null;
  now?: () => number;
  sweepIntervalMs?: number;
  /**
   * Best-effort managed-agent record probe for the reconciliation report.
   * Absent (or failing) leaves every record state `unknown` — the report is
   * advisory and must degrade rather than fail.
   */
  probeRecords?:
    | ((
        coordinates: readonly string[],
      ) => Promise<ReadonlyMap<string, RecordState>>)
    | null;
}

/** `datetime('now')` format, which is what every timestamp column here uses. */
export function sqlTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

export class BuzzAgentLifecycleService {
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  /** Epoch millis of recent stages, for fan-out counting. */
  private recentStages: number[] = [];

  constructor(private readonly deps: AgentLifecycleDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Stage a deletion: drain, announce offline, persist the deadline, alert.
   *
   * Order is deliberate. The drain runs first so in-flight turns finish and the
   * agent says goodbye while it can still reach the relay; the row moves after,
   * because a crash between the two leaves the cursor un-advanced and the
   * tombstone is simply re-delivered by the next backfill. The reverse order
   * would leave a staged row whose endpoint never announced offline, and
   * clients would show the agent online until the relay's 180 s TTL lapsed.
   */
  async stage(agentId: string, trigger: StageTrigger): Promise<StageResult> {
    const provisioning = this.deps.provisioning;
    if (!provisioning) {
      return { kind: "not_configured", agentId };
    }
    const row = this.deps.db.getProvisionedAgent(agentId);
    if (!row) return { kind: "unknown_agent", agentId };
    if (row.lifecycle === "staged_delete") {
      return {
        kind: "already_staged",
        agentId,
        purgeDeadline: row.purgeDeadline ?? undefined,
      };
    }

    const endpoint = this.endpointFor(agentId);
    if (endpoint) {
      try {
        const drained = await this.deps
          .transport()
          ?.drainEndpoint(endpoint.endpointId, STAGED_DELETE);
        if (drained !== true) {
          log.info("no live supervisor to drain while staging", {
            agent_id: agentId,
            endpoint_id: endpoint.endpointId,
          });
        }
      } catch (error) {
        // The record intent matters more than a clean goodbye: the lifecycle
        // write below keeps the endpoint down regardless, because the
        // supervisor polls it.
        log.warn("draining an endpoint for staged deletion failed", {
          agent_id: agentId,
          endpoint_id: endpoint.endpointId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.deps.db.setEndpointLifecycle(
        endpoint.endpointId,
        "disabled",
        STAGED_DELETE,
      );
    }

    const now = this.now();
    const stagedAt = sqlTimestamp(now);
    const purgeDeadline = sqlTimestamp(
      now + provisioning.delete_grace_hours * 3_600_000,
    );
    const staged = this.deps.db.stageProvisionedAgentDelete({
      agentId,
      stagedAt,
      purgeDeadline,
    });
    if (!staged) {
      // Lost a race with another stage. The other one owns the deadline.
      const current = this.deps.db.getProvisionedAgent(agentId);
      return {
        kind: "already_staged",
        agentId,
        purgeDeadline: current?.purgeDeadline ?? undefined,
      };
    }

    const fanout = this.recordStage(now);
    this.deps.db.appendProvisioningAudit({
      agentId,
      signal: AUDIT_SIGNAL.stage,
      actor: this.actorOf(trigger),
      outcome: "staged",
      detail: {
        purge_deadline: purgeDeadline,
        staged_at: stagedAt,
        endpoint_id: endpoint?.endpointId ?? null,
        instruction_version: row.instructionVersion,
        fanout,
        ...(trigger.kind === "tombstone"
          ? {
              event_id: trigger.eventId,
              owner_pubkey: trigger.ownerPubkey,
              relay_url: trigger.relayUrl,
            }
          : { via: trigger.via }),
      },
    });
    log.warn("provisioned agent staged for deletion", {
      agent_id: agentId,
      purge_deadline: purgeDeadline,
      fanout,
      trigger: trigger.kind,
      ...(trigger.kind === "tombstone" ? { event_id: trigger.eventId } : {}),
    });
    void this.deps.alerts?.agentStagedForDeletion(
      agentId,
      purgeDeadline,
      fanout,
    );
    this.deps.onFleetChanged?.();
    return { kind: "staged", agentId, purgeDeadline, fanout };
  }

  /**
   * Return a staged agent to `active` during its grace period (R5.5).
   *
   * The endpoint stays down. Restoring says "do not destroy this", not "bring
   * it back up" — and the agent now runs with no Desktop record behind it,
   * which is a state the reconciliation report is meant to show rather than
   * something to paper over. It comes back on the next deploy, or on an
   * explicit `torana endpoints resume`.
   */
  restore(
    agentId: string,
    actor: string,
  ): "restored" | "not_staged" | "unknown_agent" {
    const row = this.deps.db.getProvisionedAgent(agentId);
    if (!row) return "unknown_agent";
    if (row.lifecycle !== "staged_delete") return "not_staged";
    if (!this.deps.db.restoreProvisionedAgent(agentId)) return "not_staged";
    this.deps.db.appendProvisioningAudit({
      agentId,
      signal: AUDIT_SIGNAL.restore,
      actor,
      outcome: "restored",
      detail: {
        cancelled_purge_deadline: row.purgeDeadline,
        staged_at: row.stagedAt,
        // Which tombstone this reversal answers. Read back by `wasReversed` so
        // the same event redelivered by a backfill cannot undo the operator.
        reversed_event_id: this.stagingEventId(agentId),
      },
    });
    log.warn("staged deletion reversed by operator", {
      agent_id: agentId,
      cancelled_purge_deadline: row.purgeDeadline,
      actor,
    });
    this.deps.onFleetChanged?.();
    return "restored";
  }

  /**
   * Bring a purge forward to now (`--acknowledge-data-loss`).
   *
   * Deliberately expressed as "move the deadline", not "destroy now": the sweep
   * remains the single code path that destroys anything, so an operator hatch
   * cannot skip the audit-first ordering or the endpoint drain. Callers that
   * want it to happen immediately run the sweep themselves.
   */
  expedite(
    agentId: string,
    actor: string,
  ): "scheduled" | "unknown_agent" | "not_configured" {
    const provisioning = this.deps.provisioning;
    if (!provisioning) return "not_configured";
    const row = this.deps.db.getProvisionedAgent(agentId);
    if (!row) return "unknown_agent";
    const now = sqlTimestamp(this.now());
    if (row.lifecycle === "staged_delete") {
      this.deps.db.setProvisionedAgentPurgeDeadline(agentId, now);
    } else {
      this.deps.db.stageProvisionedAgentDelete({
        agentId,
        stagedAt: now,
        purgeDeadline: now,
      });
    }
    this.deps.db.appendProvisioningAudit({
      agentId,
      signal: AUDIT_SIGNAL.stage,
      actor,
      outcome: "expedited",
      detail: { purge_deadline: now, previous_lifecycle: row.lifecycle },
    });
    log.warn("purge deadline brought forward by operator", {
      agent_id: agentId,
      actor,
    });
    this.deps.onFleetChanged?.();
    return "scheduled";
  }

  /** Start the periodic purge sweep, and run one immediately (R5.4 restart). */
  start(): void {
    if (this.sweepTimer) return;
    void this.sweepPurges();
    this.sweepTimer = setInterval(
      () => void this.sweepPurges(),
      this.deps.sweepIntervalMs ?? PURGE_SWEEP_INTERVAL_MS,
    );
    (this.sweepTimer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * Purge every staged agent whose deadline has passed.
   *
   * Serialized against itself: a sweep that overlaps its predecessor would run
   * two purges of the same agent concurrently, and the second would see a
   * half-destroyed one.
   */
  async sweepPurges(): Promise<PurgeResult[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    const results: PurgeResult[] = [];
    try {
      const due = this.deps.db.listProvisionedAgentsDueForPurge(
        sqlTimestamp(this.now()),
      );
      for (const row of due) {
        try {
          results.push(await this.purge(row.agentId, "purge-sweep"));
        } catch (error) {
          log.error("purging a staged agent failed; the sweep will retry", {
            agent_id: row.agentId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.sweeping = false;
    }
    if (results.length > 0) this.deps.onFleetChanged?.();
    return results;
  }

  /**
   * Destroy one agent: record, endpoint, sealed secrets, workspace (R5.6).
   *
   * The audit row is committed **before** anything is destroyed, and it is what
   * survives — `provisioning_audit` is deliberately not foreign-keyed to the
   * agent for exactly this reason. Everything after it tolerates already being
   * done, so a crash mid-purge converges on the next sweep instead of wedging:
   * a workspace removed by the previous attempt, or an endpoint already dropped
   * through the R5.7 manual hatch, is skipped with a log line.
   */
  async purge(agentId: string, actor: string): Promise<PurgeResult> {
    const row = this.deps.db.getProvisionedAgent(agentId);
    const endpoint = this.endpointFor(agentId);
    if (!row && !endpoint) {
      return {
        agentId,
        destroyed: false,
        endpointRemoved: false,
        workspaceRemoved: false,
        workspaceBytes: 0,
      };
    }

    const workspace = workspacePathFor(this.deps.dataDir, agentId);
    let bytes = 0;
    try {
      bytes = await workspaceBytes(this.deps.dataDir, agentId);
    } catch (error) {
      // A byte count is evidence, not a precondition. Losing it must not stop
      // the purge, but the audit must say the number is missing rather than 0.
      log.warn("could not measure a workspace before purge", {
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      bytes = -1;
    }

    // ── audit first, in its own committed transaction ───────────────────────
    this.deps.db.appendProvisioningAudit({
      agentId,
      signal: AUDIT_SIGNAL.purge,
      actor,
      outcome: "purged",
      detail: {
        pubkey: row?.derivedPubkey ?? null,
        endpoint_id: endpoint?.endpointId ?? null,
        harness: row?.harness ?? null,
        instruction_version: row?.instructionVersion ?? null,
        workspace_path: workspace,
        workspace_bytes: bytes < 0 ? null : bytes,
        staged_at: row?.stagedAt ?? null,
        purge_deadline: row?.purgeDeadline ?? null,
        staging_event_id: this.stagingEventId(agentId),
        created_at: row?.createdAt ?? null,
        purged_at: sqlTimestamp(this.now()),
      },
    });

    // ── destruction ─────────────────────────────────────────────────────────
    let endpointRemoved = false;
    if (endpoint) {
      try {
        endpointRemoved =
          (await this.deps
            .transport()
            ?.removeEndpoint(endpoint.endpointId, { drainReason: "purge" })) ??
          false;
      } catch (error) {
        log.warn("removing an endpoint during purge failed", {
          agent_id: agentId,
          endpoint_id: endpoint.endpointId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.deps.db.setEndpointLifecycle(
        endpoint.endpointId,
        "disabled",
        "purged",
      );
    }

    this.deps.agentTimeouts?.delete(agentId);
    try {
      this.deps.agentRuntime?.remove(agentId);
    } catch (error) {
      log.warn("deregistering an agent during purge failed", {
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.deps.db.transaction(() => {
      if (endpoint) this.deps.db.deleteProvisionedEndpoint(endpoint.endpointId);
      this.deps.db.deleteProvisionedAgent(agentId);
    });

    let workspaceRemoved = false;
    try {
      workspaceRemoved = removeWorkspace(this.deps.dataDir, agentId);
    } catch (error) {
      log.error("removing a workspace during purge failed", {
        agent_id: agentId,
        workspace,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    log.warn("provisioned agent purged", {
      agent_id: agentId,
      endpoint_id: endpoint?.endpointId ?? null,
      workspace_removed: workspaceRemoved,
      workspace_bytes: bytes < 0 ? null : bytes,
      actor,
    });
    return {
      agentId,
      destroyed: true,
      endpointRemoved,
      workspaceRemoved,
      workspaceBytes: bytes < 0 ? 0 : bytes,
    };
  }

  /**
   * The advisory reconciliation report (R5.12, R12.4).
   *
   * There is no write path in here, and there must never be one: the entire
   * point is that a state Torana cannot account for surfaces to a human instead
   * of triggering an automatic action. The relay probe is best-effort — a relay
   * that is down leaves every record state `unknown`, which is the honest
   * answer, and never `absent`, which would read as "the Desktop deleted it".
   */
  async reconciliationReport(): Promise<ReconciliationReport> {
    const agents = this.deps.db.listProvisionedAgents();
    const endpoints = this.deps.db.listProvisionedEndpoints();
    const transport = this.deps.transport();

    const coordinates: string[] = [];
    const rows = agents.map((row) => {
      const endpoint = endpoints.find((item) => item.agentId === row.agentId);
      const stored = endpoint ? readEndpointBlock(endpoint) : null;
      const coordinate =
        stored?.ownerPubkey !== null && stored?.ownerPubkey !== undefined
          ? managedAgentCoordinate(stored.ownerPubkey, row.derivedPubkey)
          : null;
      if (coordinate) coordinates.push(coordinate);
      const health = endpoint ? transport?.snapshot(endpoint.endpointId) : null;
      return {
        agentId: row.agentId,
        pubkey: row.derivedPubkey,
        ownerPubkey: stored?.ownerPubkey ?? null,
        relayUrl: stored?.relayUrl ?? null,
        harness: row.harness,
        lifecycle: row.lifecycle,
        stagedAt: row.stagedAt,
        purgeDeadline: row.purgeDeadline,
        instructionVersion: row.instructionVersion,
        endpointId: endpoint?.endpointId ?? null,
        endpointState:
          (endpoint &&
            this.deps.db.getEndpointState(endpoint.endpointId)
              ?.lifecycleState) ??
          null,
        connected: health ? Boolean(health.connected) : null,
        presenceStale: health ? health.presence.stale : null,
        coordinate,
        recordState: "unknown" as RecordState,
      };
    });

    // Per-coordinate states, not a set of "present" ones: a relay that is down
    // must leave its agents `unknown`, never `absent` — and `absent` reads as
    // "the Desktop deleted this", which is the one conclusion an unreachable
    // relay cannot support.
    let probed: ReadonlyMap<string, RecordState> | null = null;
    if (this.deps.probeRecords && coordinates.length > 0) {
      try {
        probed = await this.deps.probeRecords(coordinates);
      } catch (error) {
        log.warn("reconciliation record probe failed; states stay unknown", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (probed) {
      for (const row of rows) {
        if (!row.coordinate) continue;
        row.recordState = probed.get(row.coordinate) ?? "unknown";
      }
    }

    const rejected = this.deps.db
      .listProvisioningAuditBySignal([AUDIT_SIGNAL.rejectedTombstone], 100)
      .map((entry) => {
        let detail: Record<string, unknown> = {};
        try {
          detail = entry.detail
            ? (JSON.parse(entry.detail) as Record<string, unknown>)
            : {};
        } catch {
          detail = {};
        }
        return {
          seenAt: entry.createdAt,
          reason: entry.outcome,
          eventId: asString(detail.event_id),
          agentPubkey: asString(detail.agent_pubkey),
          ownerPubkey: asString(detail.owner_pubkey),
          relayUrl: asString(detail.relay_url),
          detail: asString(detail.message),
        };
      });

    return {
      generatedAt: new Date(this.now()).toISOString(),
      recordProbe: probed ? "queried" : "unavailable",
      agents: rows,
      rejectedTombstones: rejected,
    };
  }

  /**
   * Record a tombstone that deleted nothing (R5.11).
   *
   * Written to the audit table rather than held in memory so it survives the
   * restart an operator is most likely to perform before reading the report.
   */
  recordRejectedTombstone(input: {
    reason: string;
    eventId: string | null;
    agentPubkey: string | null;
    ownerPubkey: string | null;
    relayUrl: string;
    message: string;
  }): void {
    this.deps.db.appendProvisioningAudit({
      // Not an agent id: nothing matched. Kept non-empty because the column is
      // NOT NULL, and deliberately unlike any BotIdSchema value.
      agentId: input.agentPubkey ?? "(unmatched)",
      signal: AUDIT_SIGNAL.rejectedTombstone,
      actor: "relay-tombstone",
      outcome: input.reason,
      detail: {
        event_id: input.eventId,
        agent_pubkey: input.agentPubkey,
        owner_pubkey: input.ownerPubkey,
        relay_url: input.relayUrl,
        message: input.message,
      },
    });
  }

  /**
   * Did an operator already reverse *this* tombstone?
   *
   * Keyed on the event id rather than on a timestamp comparison, deliberately.
   * The tombstone's `created_at` is the relay's clock and the audit row's is
   * ours; deciding whether to destroy an agent by comparing the two is the
   * mistake upstream's own collector refuses to make. An id either matches a
   * reversal or it does not.
   *
   * This is the durable half of redelivery protection — the watcher's
   * in-process dedupe is empty after a restart, which is exactly when the
   * backfill overlap hands the reversed tombstone back.
   */
  wasReversed(agentId: string, eventId: string): boolean {
    for (const entry of this.deps.db.listProvisioningAudit(agentId, 100)) {
      if (entry.signal !== AUDIT_SIGNAL.restore || !entry.detail) continue;
      try {
        const detail = JSON.parse(entry.detail) as {
          reversed_event_id?: unknown;
        };
        if (detail.reversed_event_id === eventId) return true;
      } catch {
        // A malformed row proves nothing either way; keep looking.
      }
    }
    return false;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private actorOf(trigger: StageTrigger): string {
    return trigger.kind === "tombstone"
      ? "relay-tombstone"
      : `operator-${trigger.via}`;
  }

  private endpointFor(agentId: string): ProvisionedEndpointRow | null {
    return (
      this.deps.db
        .listProvisionedEndpoints()
        .find((row) => row.agentId === agentId) ?? null
    );
  }

  /** The tombstone that staged this agent, for the purge record. */
  private stagingEventId(agentId: string): string | null {
    return stagingEventIdFor(this.deps.db, agentId);
  }

  private recordStage(nowMs: number): number {
    this.recentStages = this.recentStages.filter(
      (at) => nowMs - at < FANOUT_WINDOW_MS,
    );
    this.recentStages.push(nowMs);
    return this.recentStages.length;
  }
}

export type RecordState = "present" | "absent" | "unknown";

export interface ReconciliationReport {
  generatedAt: string;
  recordProbe: "queried" | "unavailable";
  agents: Array<{
    agentId: string;
    pubkey: string;
    ownerPubkey: string | null;
    relayUrl: string | null;
    harness: string;
    lifecycle: string;
    stagedAt: string | null;
    purgeDeadline: string | null;
    instructionVersion: string;
    endpointId: string | null;
    endpointState: string | null;
    connected: boolean | null;
    presenceStale: boolean | null;
    coordinate: string | null;
    recordState: RecordState;
  }>;
  rejectedTombstones: Array<{
    seenAt: string;
    reason: string;
    eventId: string | null;
    agentPubkey: string | null;
    ownerPubkey: string | null;
    relayUrl: string | null;
    detail: string | null;
  }>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The id of the tombstone that most recently staged this agent, if any.
 *
 * Shared with the provisioning service, whose row-7 un-stage is the other way a
 * staged deletion gets reversed: a deploy is fresh owner intent, and the
 * redelivered tombstone that preceded it must not undo it.
 */
export function stagingEventIdFor(
  db: GatewayDB,
  agentId: string,
): string | null {
  for (const entry of db.listProvisioningAudit(agentId, 100)) {
    if (entry.signal !== AUDIT_SIGNAL.stage || !entry.detail) continue;
    try {
      const detail = JSON.parse(entry.detail) as { event_id?: unknown };
      return asString(detail.event_id);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Relay URL and owner pubkey from a stored endpoint row.
 *
 * Read from `config_json`, which is the redacted copy: no secret is opened to
 * answer "which relay and whose owner", so the report and the watcher's target
 * list both work without touching the sealing key.
 */
export function readEndpointBlock(row: ProvisionedEndpointRow): {
  relayUrl: string | null;
  ownerPubkey: string | null;
} {
  try {
    const stored = JSON.parse(row.configJson) as {
      relay_url?: unknown;
      owner_pubkey?: unknown;
    };
    return {
      relayUrl: asString(stored.relay_url),
      ownerPubkey: asString(stored.owner_pubkey),
    };
  } catch {
    return { relayUrl: null, ownerPubkey: null };
  }
}
