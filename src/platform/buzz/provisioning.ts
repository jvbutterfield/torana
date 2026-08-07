// Runtime provisioning of Buzz endpoints.
//
// A provisioned endpoint is a DB row that behaves exactly like an
// `agents[].endpoints[]` block in torana.yaml. That "exactly" is load-bearing:
// the row is merged into the parsed config and re-validated through
// `ConfigV2Schema`, so identity checks, auth-tag authorization, id collisions
// and shared-identity rules are the same code that guards YAML rather than a
// second, weaker copy of it.
//
// Provisioning creates *endpoints*, never agents or runners. Every request
// names an agent that already exists in YAML with a configured runner, which
// is also what makes publisher-only identities (no agent to bind to) fail
// naturally rather than by special case.

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
import type { GatewayDB, ProvisionedEndpointRow } from "../../db/gateway-db.js";
import { addSecrets, logger } from "../../log.js";
import { decodeSecret, publicKey } from "./protocol.js";
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
    normalized: NormalizedConfigModel | null;
    errors: string[];
  } {
    const rows = this.deps.db.listProvisionedEndpoints();
    if (rows.length === 0) {
      return { endpoints: [], normalized: null, errors: [] };
    }
    if (!this.deps.key) {
      // Fail closed and loudly. Running with provisioned rows we cannot open
      // would silently drop agents an operator believes are deployed.
      return {
        endpoints: [],
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
    if (blocks.length === 0) return { endpoints: [], normalized: null, errors };
    try {
      const merged = this.merge(blocks);
      return {
        endpoints: blocks
          .map((block) =>
            merged.model.endpoints.find((item) => item.id === block.id),
          )
          .filter((item): item is NormalizedEndpointConfig => Boolean(item)),
        normalized: merged.model,
        errors,
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return { endpoints: [], normalized: null, errors };
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
    if (!this.configuredAgentIds().includes(request.agent_id)) {
      throw new ProvisioningError(
        "unknown_agent",
        `unknown agent '${request.agent_id}'; provisioning attaches an endpoint to an ` +
          `agent that is already configured with a runner. Configured agents: ` +
          `${this.configuredAgentIds().join(", ") || "(none)"}`,
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

  // ── internals ─────────────────────────────────────────────────────────────

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
  private merge(blocks: StoredEndpointBlock[]): {
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
    for (const block of blocks) {
      const agentId = this.agentIdFor(block);
      const agent = draft.agents.find((item) => item.id === agentId);
      if (!agent) {
        throw new ProvisioningError(
          "unknown_agent",
          `unknown agent '${agentId}'; configured agents: ${
            this.configuredAgentIds().join(", ") || "(none)"
          }`,
        );
      }
      const { agent_id: _ignored, ...endpointFields } = block as Record<
        string,
        unknown
      >;
      agent.endpoints.push(
        endpointFields as unknown as ConfigV2["agents"][number]["endpoints"][number],
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
