// Runtime provisioning of Buzz endpoints.
//
// A provisioned endpoint is a DB row that behaves exactly like an
// `agents[].endpoints[]` block in torana.yaml. That "exactly" is load-bearing:
// the row is merged into the parsed config and re-validated through
// `ConfigV2Schema`, so identity checks, auth-tag authorization, id collisions
// and shared-identity rules are the same code that guards YAML rather than a
// second, weaker copy of it.
//
// Provisioning creates endpoints and — since US-032 — Desktop-managed agents.
// Which one a deploy means is decided by `classifyDeploy` before any write
// happens; see `deploy-classification.ts` for the table and why its ordering
// matters. A YAML-declared id always takes the endpoint-attach path and its
// agent definition is never touched (R1.4).

import { z } from "zod";
import {
  ConfigV2Schema,
  normalizeV2,
  type ConfigV2,
  type NormalizedConfigModel,
  type NormalizedEndpointConfig,
} from "../../config/v2.js";
import {
  openSecret,
  sealSecret,
  PROVISIONING_KEY_ENV,
} from "../../config/provisioning-secrets.js";
import type {
  GatewayDB,
  ProvisionedAgentRow,
  ProvisionedEndpointRow,
} from "../../db/gateway-db.js";
import type { BotConfig } from "../../config/schema.js";
import type { ProvisioningConfig } from "../../config/v2.js";
import {
  classifyDeploy,
  type DeployAgentBlock,
} from "./deploy-classification.js";
import {
  projectAgentBlock,
  projectInstructions,
  ProjectionError,
  type ProjectedInstructions,
} from "./provisioned-agents.js";
import {
  ensureWorkspace,
  removeWorkspace,
  workspacePathFor,
  WorkspaceError,
} from "./provisioned-workspaces.js";
import { addSecrets, logger } from "../../log.js";
import { decodeSecret, publicKey } from "./protocol.js";
import type { AgentTimeoutRegistry } from "./agent-timeouts.js";
import type { BuzzTransport } from "./transport.js";

const log = logger("buzz.provisioning");

/**
 * The provider-facing request body. Deliberately narrower than the full
 * endpoint schema: everything a remote deploy may set, and nothing that would
 * let it reach into runner or agent configuration.
 */
export const ProvisionRequestSchema = z
  .object({
    agent_id: z.string().min(1),
    relay_url: z.string().min(1),
    private_key: z.string().min(1),
    auth_tag: z.string().min(1),
    community_id: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,47}$/)
      .default("primary"),
    respond_to: z
      .enum(["owner_only", "allowlist", "anyone", "nobody"])
      .default("owner_only"),
    owner_pubkey: z.string().optional(),
    allowed_pubkeys: z.array(z.string()).default([]),
    subscribe: z
      .enum(["mentions_and_dms", "all_channels"])
      .default("mentions_and_dms"),
    owner_shutdown: z.enum(["enabled", "disabled"]).default("enabled"),
    deploy_nonce: z.string().max(200).optional(),
    /**
     * Present only for a Desktop-managed agent. Its absence is what
     * distinguishes "attach an endpoint to an agent you already configured"
     * from "create this agent". Deliberately narrow: a harness *name* from the
     * operator's allowlist, instructions, and requested timeouts. Nothing here
     * can name a binary, add an argv element, or set an env key (D4, R7.3).
     */
    agent: z
      .object({
        harness: z.string().min(1).optional(),
        system_prompt: z.string().default(""),
        model: z.string().nullable().optional(),
        turn_timeout_seconds: z.number().nullable().optional(),
        idle_timeout_seconds: z.number().nullable().optional(),
        max_turn_duration_seconds: z.number().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ProvisionRequest = z.infer<typeof ProvisionRequestSchema>;

export type ProvisionOutcome =
  /** Live, healthy, and already matching the request. Nothing was touched. */
  | { kind: "unchanged"; endpointId: string; pubkey: string }
  | { kind: "created"; endpointId: string; pubkey: string }
  | { kind: "replaced"; endpointId: string; pubkey: string }
  /**
   * The endpoint was durably disabled by an owner `!shutdown` and this deploy
   * brought it back. Distinct from `replaced` because it reverses an explicit
   * owner decision — see the note at the revive site in `upsert`.
   */
  | { kind: "revived"; endpointId: string; pubkey: string };

export class ProvisioningError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "unknown_agent"
      | "conflict"
      | "capacity"
      | "not_configured",
    message: string,
  ) {
    super(message);
    this.name = "ProvisioningError";
  }
}

export interface ProvisioningDeps {
  db: GatewayDB;
  /** The parsed YAML config this process started with. */
  configV2: ConfigV2 | null;
  /** Sealing key, or null when `TORANA_PROVISIONING_SECRETS_KEY` is unset. */
  key: Buffer | null;
  transport: BuzzTransport | null;
  /** Ceiling on live endpoints; provisioning refuses rather than degrades. */
  maxEndpoints?: number;
  /** Absent when the gateway is not configured to create agents at all. */
  provisioning?: ProvisioningConfig | null;
  /** Root the per-agent workspaces hang off. */
  dataDir?: string;
  /** Populated on create and restore; read by the scheduler per dispatch. */
  agentTimeouts?: AgentTimeoutRegistry | null;
  /**
   * Runtime hooks for Desktop-managed agents. Injected rather than imported so
   * the service can be tested without a live registry, and so the create
   * arm's unwind has an explicit deregister to call.
   */
  agentRuntime?: {
    upsert(input: {
      agentId: string;
      botConfig: BotConfig;
      endpointId: string;
    }): void;
    remove(agentId: string): void;
  } | null;
}

/** A Desktop-managed agent rebuilt from its row, ready to register. */
export interface RestoredAgent {
  agentId: string;
  botConfig: BotConfig;
  endpointId: string;
}

interface StoredEndpointBlock {
  id: string;
  [key: string]: unknown;
}

export class BuzzProvisioningService {
  constructor(private readonly deps: ProvisioningDeps) {}

  /**
   * The transport is built after the routes are registered — and is built
   * *from* the endpoints this service restores — so it is attached rather than
   * injected. Until it is, provisioning refuses instead of half-succeeding.
   */
  attachTransport(transport: BuzzTransport): void {
    this.deps.transport = transport;
  }

  /** Agent ids that a deploy may bind to: declared in YAML, with a runner. */
  configuredAgentIds(): string[] {
    return (this.deps.configV2?.agents ?? [])
      .filter((agent) => agent.runner !== undefined)
      .map((agent) => agent.id)
      .sort();
  }

  /**
   * Rebuild every persisted endpoint at startup. Rows are validated through
   * the same merge as a live deploy, so a row that has become invalid (its
   * agent removed from YAML, its id now colliding with a YAML endpoint) is
   * reported rather than silently started.
   */
  loadPersisted(): {
    endpoints: NormalizedEndpointConfig[];
    /** Desktop-managed agents to register before transports start (R1.6). */
    agents: RestoredAgent[];
    normalized: NormalizedConfigModel | null;
    errors: string[];
  } {
    const rows = this.deps.db.listProvisionedEndpoints();
    if (rows.length === 0) {
      return { endpoints: [], agents: [], normalized: null, errors: [] };
    }
    if (!this.deps.key) {
      // Fail closed and loudly. Running with provisioned rows we cannot open
      // would silently drop agents an operator believes are deployed.
      return {
        endpoints: [],
        agents: [],
        normalized: null,
        errors: [
          `${rows.length} provisioned endpoint(s) are stored but ${PROVISIONING_KEY_ENV} is not set; ` +
            `their secrets cannot be decrypted`,
        ],
      };
    }
    const blocks: StoredEndpointBlock[] = [];
    const errors: string[] = [];
    for (const row of rows) {
      try {
        blocks.push(this.blockFromRow(row));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (blocks.length === 0)
      return { endpoints: [], agents: [], normalized: null, errors };
    try {
      const merged = this.merge(blocks);
      const agents: RestoredAgent[] = [];
      for (const row of this.deps.db.listProvisionedAgents()) {
        const endpoint = rows.find(
          (candidate) => candidate.agentId === row.agentId,
        );
        if (!endpoint) {
          // A row with no endpoint cannot be projected — one create writes
          // both, so this means something wrote the table out of band.
          errors.push(
            `provisioned agent '${row.agentId}' has no endpoint row and was not restored`,
          );
          continue;
        }
        const botConfig = merged.config.agents.find(
          (item) => item.id === row.agentId,
        );
        if (!botConfig) {
          errors.push(
            `provisioned agent '${row.agentId}' did not survive configuration normalization`,
          );
          continue;
        }
        // Applied values depend on harness config, so a harness edit between
        // restarts legitimately changes what this agent runs. Recompute and
        // re-persist, or the stored digest would misreport a live agent (R3.6).
        try {
          const projected = projectInstructions(
            row,
            this.requireProvisioning(),
          );
          if (projected.instructionVersion !== row.instructionVersion) {
            log.info("instruction version moved with harness configuration", {
              agent_id: row.agentId,
              from: row.instructionVersion,
              to: projected.instructionVersion,
            });
            this.deps.db.setProvisionedAgentInstructionVersion(
              row.agentId,
              projected.instructionVersion,
            );
          }
        } catch (error) {
          errors.push(
            `provisioned agent '${row.agentId}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
        agents.push({
          agentId: row.agentId,
          botConfig: botConfig as unknown as BotConfig,
          endpointId: endpoint.endpointId,
        });
      }
      return {
        endpoints: blocks
          .map((block) =>
            merged.model.endpoints.find((item) => item.id === block.id),
          )
          .filter((item): item is NormalizedEndpointConfig => Boolean(item)),
        agents,
        normalized: merged.model,
        errors,
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return { endpoints: [], agents: [], normalized: null, errors };
    }
  }

  status(endpointId: string): {
    endpointId: string;
    agentId: string;
    pubkey: string;
    createdAt: string;
    updatedAt: string;
    provisionedBy: string;
    lifecycleState: string | null;
    runtimeState: string | null;
    connected: boolean;
    presence: {
      lastPublishedAt: number | null;
      consecutiveFailures: number;
      stale: boolean;
    } | null;
  } | null {
    const row = this.deps.db.getProvisionedEndpoint(endpointId);
    if (!row) return null;
    const health = this.deps.transport?.snapshot(endpointId) ?? null;
    return {
      endpointId: row.endpointId,
      agentId: row.agentId,
      pubkey: row.derivedPubkey,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      provisionedBy: row.provisionedBy,
      lifecycleState:
        this.deps.db.getEndpointState(endpointId)?.lifecycleState ?? null,
      runtimeState: health?.state ?? null,
      connected: health?.connected ?? false,
      presence: health
        ? {
            lastPublishedAt: health.presence.lastPublishedAt,
            consecutiveFailures: health.presence.consecutiveFailures,
            stale: health.presence.stale,
          }
        : null,
    };
  }

  /**
   * Create or reconcile an endpoint. Reconciliation is keyed on the pubkey
   * derived from the submitted key, not on the endpoint id, because the
   * identity is what the relay authenticates and what a viewer sees online.
   */
  async upsert(
    endpointId: string,
    request: ProvisionRequest,
    actor: string,
  ): Promise<ProvisionOutcome> {
    if (!this.deps.key) {
      throw new ProvisioningError(
        "not_configured",
        `${PROVISIONING_KEY_ENV} is not set; endpoint provisioning is disabled`,
      );
    }
    if (!this.deps.configV2) {
      throw new ProvisioningError(
        "not_configured",
        "endpoint provisioning requires a version 2 configuration",
      );
    }
    if (!this.deps.transport) {
      throw new ProvisioningError(
        "not_configured",
        "the Buzz platform is disabled; enable platforms.buzz before provisioning",
      );
    }
    let pubkey: string;
    try {
      pubkey = publicKey(decodeSecret(request.private_key));
    } catch (error) {
      throw new ProvisioningError(
        "invalid_request",
        `private_key is not a usable Buzz identity: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // What does this deploy mean? Classified before any write, with the gate
    // ordering that matters living in one pure, tested place (plan §3.1).
    const yamlWithRunner = new Set(this.configuredAgentIds());
    // Publishers share one global id namespace with agents, so their ids —
    // and their endpoint ids — are reserved against a provisioned create.
    const reservedYamlIds = new Set<string>();
    for (const publisher of this.deps.configV2.publishers ?? []) {
      reservedYamlIds.add(publisher.id);
      reservedYamlIds.add(publisher.endpoint.id);
    }
    let yamlIdentityOwner: string | null = null;
    for (const agent of this.deps.configV2.agents) {
      for (const endpoint of agent.endpoints) {
        if (
          endpoint.platform === "buzz" &&
          safePubkey(endpoint.private_key) === pubkey
        ) {
          yamlIdentityOwner = agent.id;
        }
      }
    }
    const classification = classifyDeploy({
      agentId: request.agent_id,
      pubkey,
      agent: request.agent,
      ownerPubkey: request.owner_pubkey,
      yamlAgentIdsWithRunner: yamlWithRunner,
      reservedYamlIds,
      existingAgent: this.deps.db.getProvisionedAgent(request.agent_id),
      agentBoundToPubkey: this.deps.db.getProvisionedAgentByPubkey(pubkey),
      yamlIdentityOwner,
    });

    if (classification.kind === "reject") {
      this.deps.db.appendProvisioningAudit({
        agentId: request.agent_id,
        signal: "reject",
        actor,
        outcome: classification.code,
        detail: { message: classification.message },
      });
      throw new ProvisioningError(
        classification.code === "missing_owner"
          ? "invalid_request"
          : classification.code,
        classification.message,
      );
    }

    if (classification.kind === "create_provisioned") {
      const created = await this.createProvisionedAgent({
        endpointId,
        request,
        agent: classification.agent,
        pubkey,
        actor,
      });
      this.deps.db.appendProvisioningAudit({
        agentId: request.agent_id,
        signal: "create",
        actor,
        outcome: "created",
        detail: {
          endpoint_id: endpointId,
          harness: classification.agent.harness,
          instruction_version: created.instructions.instructionVersion,
          clamped: created.instructions.clamped,
        },
      });
      log.info("provisioned agent created", {
        agent_id: request.agent_id,
        endpoint_id: endpointId,
        actor,
        instruction_version: created.instructions.instructionVersion,
      });
      return { kind: "created", endpointId, pubkey };
    }

    // A YAML-declared endpoint always wins. torana.yaml is baked into the
    // deploy image and re-validated on every deploy, so letting a provider
    // create a row that shadows one would mean the next redeploy silently
    // reverts or duplicates it.
    for (const agent of this.deps.configV2.agents) {
      for (const endpoint of agent.endpoints) {
        if (endpoint.id === endpointId) {
          throw new ProvisioningError(
            "conflict",
            `endpoint '${endpointId}' is managed by static config`,
          );
        }
        if (
          endpoint.platform === "buzz" &&
          safePubkey(endpoint.private_key) === pubkey
        ) {
          throw new ProvisioningError(
            "conflict",
            `that identity is managed by static config as endpoint '${endpoint.id}'`,
          );
        }
      }
    }

    const existingById = this.deps.db.getProvisionedEndpoint(endpointId);
    const existingByPubkey =
      this.deps.db.getProvisionedEndpointByPubkey(pubkey);
    if (existingByPubkey && existingByPubkey.endpointId !== endpointId) {
      // Never a second live endpoint for one identity (invariant I4, within
      // Torana's own scope).
      throw new ProvisioningError(
        "conflict",
        `that identity is already deployed as endpoint '${existingByPubkey.endpointId}'`,
      );
    }

    const block = this.blockFromRequest(endpointId, request);

    // Strict no-op: same identity, same configuration, already live and
    // healthy. The Desktop's "Start" is an unconditional deploy, so this is
    // the common case, not an edge case.
    const priorState = this.deps.db.getEndpointState(endpointId);
    if (existingById && this.sameConfig(existingById, block, pubkey)) {
      const health = this.deps.transport.snapshot(endpointId);
      if (health?.connected && priorState?.lifecycleState === "active") {
        return { kind: "unchanged", endpointId, pubkey };
      }
    }

    const others = this.deps.db
      .listProvisionedEndpoints()
      .filter((row) => row.endpointId !== endpointId)
      .map((row) => this.blockFromRow(row));

    const ceiling = this.deps.maxEndpoints;
    if (ceiling !== undefined) {
      const yamlCount = this.deps.configV2.agents.reduce(
        (total, agent) =>
          total +
          agent.endpoints.filter((endpoint) => endpoint.platform === "buzz")
            .length,
        0,
      );
      if (yamlCount + others.length + 1 > ceiling) {
        throw new ProvisioningError(
          "capacity",
          `configured Buzz endpoint ceiling of ${ceiling} would be exceeded`,
        );
      }
    }

    // The real gate: validate the merged config exactly as YAML is validated.
    const merged = this.merge([...others, block]);
    const normalizedEndpoint = merged.model.endpoints.find(
      (item) => item.id === endpointId,
    );
    if (!normalizedEndpoint) {
      throw new ProvisioningError(
        "invalid_request",
        "endpoint did not survive configuration normalization",
      );
    }

    // Register before the row is stored and before the transport is wired, so
    // every subsequent log line — including anything the endpoint's own
    // supervisor emits — sees these values as redactable. Deliberately placed
    // after validation rather than at entry: an unvalidated body would let a
    // caller grow the redaction set (which `redactString` scans per log line)
    // with arbitrary strings.
    addSecrets([request.private_key, request.auth_tag]);

    this.deps.db.upsertProvisionedEndpoint({
      endpointId,
      agentId: request.agent_id,
      derivedPubkey: pubkey,
      configJson: JSON.stringify(redactBlock(block)),
      privateKeyCiphertext: sealSecret(
        this.deps.key,
        endpointId,
        request.private_key,
      ),
      authTagCiphertext: sealSecret(
        this.deps.key,
        endpointId,
        request.auth_tag,
      ),
      provisionedBy: actor,
      deployNonce: request.deploy_nonce ?? null,
    });
    this.deps.db.syncNormalizedConfig(merged.model);

    // A previous owner `!shutdown` left this endpoint durably disabled, and a
    // deploy clears it. That was owner intent at `desktop-v0.5.5`, where a
    // deploy only happened when the owner pressed Start. It is no longer: from
    // `desktop-v0.5.6` the Desktop's `reconcile_on_workspace_apply` redeploys
    // every provider-backed agent before each community UI load, and the two
    // are indistinguishable here — same op, same payload, a fresh `request_id`
    // on both paths, no intent field in the protocol.
    //
    // We honour the revive rather than break the Start button, which is the
    // operator's normal way back up. The invariant that survives is the one I5
    // was written for: no process restart, supervisor flap, or reconnect brings
    // a shut-down endpoint back. A deploy can, and when it does it is recorded
    // rather than silent — this branch exists so the behaviour is a decision on
    // the record, not a side effect of the no-op guard above failing to match.
    const revived =
      priorState?.lifecycleState === "disabled" &&
      priorState.stateReason === "owner_shutdown";
    if (revived) {
      log.warn("Buzz endpoint revived by deploy after an owner shutdown", {
        endpoint_id: endpointId,
        agent_id: request.agent_id,
        actor,
      });
    }
    this.deps.db.setEndpointLifecycle(endpointId, "active", null);
    await this.deps.transport.upsertEndpoint(normalizedEndpoint);

    log.info("Buzz endpoint provisioned", {
      endpoint_id: endpointId,
      agent_id: request.agent_id,
      actor,
      replaced: Boolean(existingById),
      revived,
    });
    return {
      kind: revived ? "revived" : existingById ? "replaced" : "created",
      endpointId,
      pubkey,
    };
  }

  /**
   * Drain, stop, and forget an endpoint. Idempotent. The supervisor owns the
   * drain so that in-flight turns finish and the endpoint announces `offline`
   * while it can still reach the relay.
   */
  async remove(endpointId: string): Promise<boolean> {
    const row = this.deps.db.getProvisionedEndpoint(endpointId);
    if (!row) return false;
    await this.deps.transport?.removeEndpoint(endpointId, {
      drainReason: "provider_delete",
    });
    this.deps.db.setEndpointLifecycle(
      endpointId,
      "disabled",
      "provider_delete",
    );
    this.deps.db.deleteProvisionedEndpoint(endpointId);
    log.info("Buzz endpoint deprovisioned", { endpoint_id: endpointId });
    return true;
  }

  /**
   * Every Desktop-managed agent with the state an operator needs to act (R12.3).
   *
   * Workspace bytes are read from the periodic sweep's last figure rather than
   * walked here: a list route that stats every agent's tree would turn an
   * operator refresh into disk load proportional to the fleet.
   */
  listAgents(): Array<{
    agentId: string;
    pubkey: string;
    harness: string;
    lifecycle: string;
    instructionVersion: string;
    stagedAt: string | null;
    purgeDeadline: string | null;
    endpointId: string | null;
    endpointState: string | null;
    connected: boolean | null;
    createdAt: string;
    updatedAt: string;
    provisionedBy: string;
  }> {
    return this.deps.db.listProvisionedAgents().map((row) => {
      const endpoint = this.deps.db
        .listProvisionedEndpoints()
        .find((candidate) => candidate.agentId === row.agentId);
      const endpointId = endpoint?.endpointId ?? null;
      const state = endpointId
        ? this.deps.db.getEndpointState(endpointId)
        : null;
      const health = endpointId
        ? (this.deps.transport?.snapshot(endpointId) ?? null)
        : null;
      return {
        agentId: row.agentId,
        pubkey: row.derivedPubkey,
        harness: row.harness,
        lifecycle: row.lifecycle,
        instructionVersion: row.instructionVersion,
        stagedAt: row.stagedAt,
        purgeDeadline: row.purgeDeadline,
        endpointId,
        endpointState: state?.lifecycleState ?? null,
        connected: health ? Boolean(health.connected) : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        provisionedBy: row.provisionedBy,
      };
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private requireProvisioning(): ProvisioningConfig {
    const provisioning = this.deps.provisioning;
    if (!provisioning) {
      throw new ProvisioningError(
        "not_configured",
        "creating agents requires a `provisioning` block in torana.yaml; " +
          "without one this gateway can only attach endpoints to agents you have declared",
      );
    }
    return provisioning;
  }

  private requireDataDir(): string {
    const dataDir = this.deps.dataDir;
    if (!dataDir) {
      throw new ProvisioningError(
        "not_configured",
        "agent provisioning requires a data directory for workspaces",
      );
    }
    return dataDir;
  }

  /**
   * Create a Desktop-managed agent: row, endpoint, workspace, runtime.
   *
   * Order matters, and so does the unwind (R2.4). Cheap validation first, then
   * the workspace, then the rows in one transaction, then runtime
   * registration, then the endpoint. Anything that throws unwinds in reverse,
   * leaving no directory, no rows, no Bot, and no supervisor.
   *
   * One deliberate asymmetry: the row transaction commits *before* runtime
   * registration, so a crash between the two leaves committed rows that the
   * startup restore path completes. Create is self-healing across a crash; the
   * unwind exists for in-process failures only.
   */
  private async createProvisionedAgent(input: {
    endpointId: string;
    request: ProvisionRequest;
    agent: DeployAgentBlock;
    pubkey: string;
    actor: string;
  }): Promise<{ instructions: ProjectedInstructions }> {
    const { endpointId, request, agent, pubkey, actor } = input;
    const agentId = request.agent_id;
    const provisioning = this.requireProvisioning();
    const dataDir = this.requireDataDir();

    // Cap first: refusing before any side effect is what makes R11.2's
    // "must not degrade running agents" true rather than aspirational.
    const existingCount = this.deps.db.countProvisionedAgents();
    if (existingCount + 1 > provisioning.max_agents) {
      throw new ProvisioningError(
        "capacity",
        `provisioning.max_agents is ${provisioning.max_agents} and ${existingCount} ` +
          `agent(s) already exist (staged deletions still count, because they still ` +
          `hold an identity, a workspace, and sealed secrets)`,
      );
    }

    const timeouts = {
      turn_timeout_seconds: agent.turn_timeout_seconds ?? null,
      idle_timeout_seconds: agent.idle_timeout_seconds ?? null,
      max_turn_duration_seconds: agent.max_turn_duration_seconds ?? null,
    };
    const pendingRow: ProvisionedAgentRow = {
      agentId,
      derivedPubkey: pubkey,
      harness: agent.harness ?? "",
      systemPrompt: agent.system_prompt ?? "",
      model: agent.model ?? null,
      timeoutsJson: JSON.stringify(timeouts),
      instructionVersion: "",
      lifecycle: "active",
      stagedAt: null,
      purgeDeadline: null,
      provisionedBy: actor,
      createdAt: "",
      updatedAt: "",
    };

    // Resolve instructions before anything is written: an unknown harness or
    // an oversized prompt must be a clean refusal, not a half-created agent.
    let instructions: ProjectedInstructions;
    try {
      instructions = projectInstructions(pendingRow, provisioning);
    } catch (error) {
      if (error instanceof ProjectionError) {
        throw new ProvisioningError(
          error.code === "unknown_harness"
            ? "invalid_request"
            : "invalid_request",
          error.message,
        );
      }
      throw error;
    }
    pendingRow.instructionVersion = instructions.instructionVersion;

    const block = this.blockFromRequest(endpointId, request);
    const others = this.deps.db
      .listProvisionedEndpoints()
      .filter((row) => row.endpointId !== endpointId)
      .map((row) => this.blockFromRow(row));

    // The real gate, same as for endpoints: the synthesized agent is validated
    // by the unchanged ConfigV2Schema before a single byte is written.
    const merged = this.merge([...others, block], {
      pendingAgents: [pendingRow],
    });
    const normalizedEndpoint = merged.model.endpoints.find(
      (item) => item.id === endpointId,
    );
    if (!normalizedEndpoint) {
      throw new ProvisioningError(
        "invalid_request",
        "endpoint did not survive configuration normalization",
      );
    }
    const botConfig = merged.config.agents.find((item) => item.id === agentId);
    if (!botConfig) {
      throw new ProvisioningError(
        "invalid_request",
        "agent did not survive configuration normalization",
      );
    }

    addSecrets([request.private_key, request.auth_tag]);

    // ── side effects begin; everything below unwinds in reverse ─────────────
    let workspaceCreated = false;
    let rowsCommitted = false;
    let runtimeRegistered = false;
    try {
      ensureWorkspace({
        dataDir,
        agentId,
        minFreeBytes: provisioning.min_free_bytes,
      });
      workspaceCreated = true;

      this.deps.db.transaction(() => {
        this.deps.db.upsertProvisionedAgent({
          agentId,
          derivedPubkey: pubkey,
          harness: pendingRow.harness,
          systemPrompt: pendingRow.systemPrompt,
          model: pendingRow.model,
          timeoutsJson: pendingRow.timeoutsJson,
          instructionVersion: pendingRow.instructionVersion,
          provisionedBy: actor,
        });
        this.deps.db.upsertProvisionedEndpoint({
          endpointId,
          agentId,
          derivedPubkey: pubkey,
          configJson: JSON.stringify(redactBlock(block)),
          privateKeyCiphertext: sealSecret(
            this.deps.key!,
            endpointId,
            request.private_key,
          ),
          authTagCiphertext: sealSecret(
            this.deps.key!,
            endpointId,
            request.auth_tag,
          ),
          provisionedBy: actor,
          deployNonce: request.deploy_nonce ?? null,
        });
      });
      rowsCommitted = true;

      this.deps.db.syncNormalizedConfig(merged.model);
      this.deps.agentTimeouts?.set(agentId, instructions.applied);
      this.deps.agentRuntime?.upsert({
        agentId,
        botConfig: botConfig as unknown as BotConfig,
        endpointId,
      });
      runtimeRegistered = true;

      this.deps.db.setEndpointLifecycle(endpointId, "active", null);
      await this.deps.transport!.upsertEndpoint(normalizedEndpoint);
    } catch (error) {
      // Reverse order, best-effort, and loud. A failure inside the unwind must
      // not mask the error that caused it.
      this.deps.agentTimeouts?.delete(agentId);
      if (runtimeRegistered) {
        try {
          this.deps.agentRuntime?.remove(agentId);
        } catch (unwind) {
          log.error("unwind: deregistering the agent runtime failed", {
            agent_id: agentId,
            error: String(unwind),
          });
        }
      }
      if (rowsCommitted) {
        try {
          this.deps.db.transaction(() => {
            this.deps.db.deleteProvisionedEndpoint(endpointId);
            this.deps.db.deleteProvisionedAgent(agentId);
          });
        } catch (unwind) {
          log.error("unwind: removing provisioned rows failed", {
            agent_id: agentId,
            error: String(unwind),
          });
        }
      }
      if (workspaceCreated) {
        try {
          removeWorkspace(dataDir, agentId);
        } catch (unwind) {
          log.error("unwind: removing the workspace failed", {
            agent_id: agentId,
            error: String(unwind),
          });
        }
      }
      if (error instanceof WorkspaceError) {
        throw new ProvisioningError(
          error.code === "insufficient_space" ? "capacity" : "invalid_request",
          error.message,
        );
      }
      throw error;
    }

    return { instructions };
  }

  private blockFromRequest(
    endpointId: string,
    request: ProvisionRequest,
  ): StoredEndpointBlock {
    return {
      id: endpointId,
      // Carried on the block so a first-time deploy can be bound before any
      // row exists; stripped again before the block becomes an endpoint entry,
      // and stored in its own column rather than in config_json.
      agent_id: request.agent_id,
      platform: "buzz",
      enabled: true,
      community_id: request.community_id,
      relay_url: request.relay_url,
      private_key: request.private_key,
      auth_tag: request.auth_tag,
      respond_to: request.respond_to,
      ...(request.owner_pubkey ? { owner_pubkey: request.owner_pubkey } : {}),
      allowed_pubkeys: request.allowed_pubkeys,
      subscribe: request.subscribe,
      owner_shutdown: request.owner_shutdown,
      channel_overrides: {},
    };
  }

  private blockFromRow(row: ProvisionedEndpointRow): StoredEndpointBlock {
    if (!this.deps.key) {
      throw new Error(
        `${PROVISIONING_KEY_ENV} is not set; cannot open provisioned endpoint '${row.endpointId}'`,
      );
    }
    const stored = JSON.parse(row.configJson) as StoredEndpointBlock;
    const privateKey = openSecret(
      this.deps.key,
      row.endpointId,
      row.privateKeyCiphertext,
    );
    const authTag = row.authTagCiphertext
      ? openSecret(this.deps.key, row.endpointId, row.authTagCiphertext)
      : null;
    // The restore path: these were sealed by an earlier process, so the
    // config-load `setSecrets()` never saw them. Register at the moment they
    // are decrypted — this is the only funnel through which a stored secret
    // re-enters the process.
    addSecrets(authTag ? [privateKey, authTag] : [privateKey]);
    return {
      ...stored,
      id: row.endpointId,
      agent_id: row.agentId,
      private_key: privateKey,
      ...(authTag ? { auth_tag: authTag } : {}),
    };
  }

  private sameConfig(
    row: ProvisionedEndpointRow,
    block: StoredEndpointBlock,
    pubkey: string,
  ): boolean {
    return (
      row.derivedPubkey === pubkey &&
      row.agentId === block.agent_id &&
      row.configJson === JSON.stringify(redactBlock(block))
    );
  }

  /**
   * Merge provisioned endpoint blocks into the YAML config and re-run the
   * whole v2 schema over the result. Everything that guards a YAML endpoint —
   * key/auth-tag verification, owner policy, globally unique endpoint ids, the
   * reserved `<agent>-agent-api` id, shared-identity rules — applies here
   * unchanged, and Zod's message is returned verbatim so the operator sees the
   * same error they would have seen from a bad YAML edit.
   */
  private merge(
    blocks: StoredEndpointBlock[],
    opts: { pendingAgents?: readonly ProvisionedAgentRow[] } = {},
  ): {
    config: ConfigV2;
    model: NormalizedConfigModel;
  } {
    if (!this.deps.configV2) {
      throw new ProvisioningError(
        "not_configured",
        "endpoint provisioning requires a version 2 configuration",
      );
    }
    const draft = structuredClone(this.deps.configV2) as ConfigV2;
    // A create validates before it commits, so its row is not in the database
    // yet; pending rows take precedence over stored ones for that reason.
    const pending = new Map(
      (opts.pendingAgents ?? []).map((row) => [row.agentId, row]),
    );
    for (const block of blocks) {
      const agentId = this.agentIdFor(block);
      const { agent_id: _ignored, ...endpointFields } = block as Record<
        string,
        unknown
      >;
      const agent = draft.agents.find((item) => item.id === agentId);
      if (agent) {
        agent.endpoints.push(
          endpointFields as unknown as ConfigV2["agents"][number]["endpoints"][number],
        );
        continue;
      }
      // Not in YAML: it must be a Desktop-managed agent, whose definition is
      // synthesized here and then validated by the very same parse below.
      const row =
        pending.get(agentId) ?? this.deps.db.getProvisionedAgent(agentId);
      if (!row) {
        throw new ProvisioningError(
          "unknown_agent",
          `unknown agent '${agentId}'; configured agents: ${
            this.configuredAgentIds().join(", ") || "(none)"
          }`,
        );
      }
      const provisioning = this.requireProvisioning();
      draft.agents.push(
        projectAgentBlock({
          agentId,
          workspace: workspacePathFor(this.requireDataDir(), agentId),
          instructions: projectInstructions(row, provisioning),
          provisioning,
          endpointBlock: endpointFields,
        }) as unknown as ConfigV2["agents"][number],
      );
    }
    let parsed: ConfigV2;
    try {
      parsed = ConfigV2Schema.parse(draft);
    } catch (error) {
      throw new ProvisioningError("invalid_request", formatZodError(error));
    }
    const result = normalizeV2(parsed);
    return { config: parsed, model: result.model };
  }

  private agentIdFor(block: StoredEndpointBlock): string {
    if (typeof block.agent_id === "string") return block.agent_id;
    const row = this.deps.db.getProvisionedEndpoint(block.id);
    if (row) return row.agentId;
    throw new ProvisioningError(
      "invalid_request",
      `provisioned endpoint '${block.id}' has no agent binding`,
    );
  }
}

/**
 * The stored copy never contains secrets — only the sealed columns do — and
 * never repeats the agent binding, which has its own column.
 */
function redactBlock(block: StoredEndpointBlock): Record<string, unknown> {
  const {
    private_key: _key,
    auth_tag: _tag,
    agent_id: _agent,
    ...rest
  } = block as Record<string, unknown>;
  return rest;
}

function safePubkey(privateKey: string): string | null {
  try {
    return publicKey(decodeSecret(privateKey));
  } catch {
    return null;
  }
}

function formatZodError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}
