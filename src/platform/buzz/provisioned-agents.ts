// Projection of a Desktop-managed agent record into a real Torana agent.
//
// The central claim of the managed-agents design is that a provisioned agent
// is *not* a relaxation of the config schema. A `provisioned_agents` row plus
// the operator's harness entry is projected into a complete v2 agent block and
// run through the **unchanged** `ConfigV2Schema` + `normalizeV2`. Both of
// R1.2's blockers — `runner` is required, `endpoints` needs at least one entry
// — are satisfied structurally, because the projection always supplies exactly
// one runner and exactly one endpoint. No YAML author's validation is weakened
// so that a Desktop record can exist.
//
// Everything the Desktop supplies enters through a placeholder in an
// operator-authored template. The Desktop names a harness; the operator owns
// the binary path, the argv *shape*, and the base environment. A payload can
// therefore never add an argv element or an env key (D4, R7.3) — only fill a
// slot the operator already wrote.

import { createHash } from "node:crypto";

import type { ProvisionedAgentRow } from "../../db/gateway-db.js";
import {
  PROVISIONING_TIMEOUT_FLOOR_SECS,
  type ProvisioningConfig,
} from "../../config/v2.js";

/** Timeouts as the Desktop asked for them, before any clamping. */
export interface RequestedTimeouts {
  turn_timeout_seconds?: number | null;
  idle_timeout_seconds?: number | null;
  max_turn_duration_seconds?: number | null;
}

/** Timeouts as Torana will actually run them. */
export interface AppliedTimeouts {
  turnTimeoutSecs: number;
  idleTimeoutSecs: number;
  maxTurnDurationSecs: number;
}

export interface ClampedField {
  field: keyof RequestedTimeouts;
  requested: number;
  applied: number;
  reason: "below_floor" | "above_ceiling";
}

export interface ProjectedInstructions {
  harness: string;
  systemPrompt: string;
  /** The model actually passed to the runner: request, else harness default. */
  modelApplied: string | null;
  applied: AppliedTimeouts;
  /** Non-empty when a requested value did not survive the ceilings. */
  clamped: ClampedField[];
  /** First 12 hex chars of the digest over the applied instruction set. */
  instructionVersion: string;
}

export class ProjectionError extends Error {
  constructor(
    readonly code:
      | "unknown_harness"
      | "prompt_too_large"
      | "not_configured"
      | "invalid_timeouts",
    message: string,
  ) {
    super(message);
    this.name = "ProjectionError";
  }
}

export function parseRequestedTimeouts(json: string): RequestedTimeouts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ProjectionError(
      "invalid_timeouts",
      "stored timeouts_json is not valid JSON",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProjectionError(
      "invalid_timeouts",
      "stored timeouts_json must be a JSON object",
    );
  }
  const record = parsed as Record<string, unknown>;
  const read = (key: keyof RequestedTimeouts): number | null => {
    const value = record[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ProjectionError(
        "invalid_timeouts",
        `timeouts_json.${key} must be a finite number`,
      );
    }
    return value;
  };
  return {
    turn_timeout_seconds: read("turn_timeout_seconds"),
    idle_timeout_seconds: read("idle_timeout_seconds"),
    max_turn_duration_seconds: read("max_turn_duration_seconds"),
  };
}

/**
 * Clamp one Desktop-supplied timeout into `[floor, ceiling]`.
 *
 * An omitted value is not a clamp — it means "no opinion", and the harness
 * ceiling is the natural value to run at. A value that *was* supplied and did
 * not survive is recorded so the deploy result can say so rather than silently
 * running something the operator did not ask for (R7.6).
 */
function clampOne(
  field: keyof RequestedTimeouts,
  requested: number | null | undefined,
  ceiling: number,
  clamped: ClampedField[],
): number {
  if (requested === null || requested === undefined) return ceiling;
  const rounded = Math.floor(requested);
  if (rounded < PROVISIONING_TIMEOUT_FLOOR_SECS) {
    clamped.push({
      field,
      requested,
      applied: PROVISIONING_TIMEOUT_FLOOR_SECS,
      reason: "below_floor",
    });
    return PROVISIONING_TIMEOUT_FLOOR_SECS;
  }
  if (rounded > ceiling) {
    clamped.push({
      field,
      requested,
      applied: ceiling,
      reason: "above_ceiling",
    });
    return ceiling;
  }
  return rounded;
}

/**
 * Digest over the instruction set Torana has **actually applied**.
 *
 * Hashing applied rather than requested values is what makes the version
 * meaningful: two deploys differing only in an excess that both clamp to the
 * same ceiling are the same instructions, and reporting them as different
 * would make the version noise. The corollary is that the digest depends on
 * harness config, so it must be recomputed at every projection — a harness
 * edit legitimately changes what a running agent executes, and a stale stored
 * digest would misreport it (R3.6).
 */
export function instructionVersionOf(input: {
  harness: string;
  systemPrompt: string;
  modelApplied: string | null;
  applied: AppliedTimeouts;
}): string {
  // Canonical JSON: fixed key order, no incidental whitespace. Any change to
  // this shape changes every agent's version, so it is deliberately minimal.
  const canonical = JSON.stringify([
    input.harness,
    input.systemPrompt,
    input.modelApplied,
    input.applied.turnTimeoutSecs,
    input.applied.idleTimeoutSecs,
    input.applied.maxTurnDurationSecs,
  ]);
  return createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")
    .slice(0, 12);
}

/** Resolve a row against the harness allowlist into applied instructions. */
export function projectInstructions(
  row: Pick<
    ProvisionedAgentRow,
    "harness" | "systemPrompt" | "model" | "timeoutsJson"
  >,
  provisioning: ProvisioningConfig,
): ProjectedInstructions {
  const harness = provisioning.harnesses[row.harness];
  if (!harness) {
    const known = Object.keys(provisioning.harnesses).sort();
    throw new ProjectionError(
      "unknown_harness",
      `harness '${row.harness}' is not allowlisted; configured harnesses: ${
        known.join(", ") || "(none)"
      }`,
    );
  }

  const promptBytes = Buffer.byteLength(row.systemPrompt, "utf8");
  if (promptBytes > harness.max_system_prompt_bytes) {
    throw new ProjectionError(
      "prompt_too_large",
      `system prompt is ${promptBytes} bytes; harness '${row.harness}' allows ${harness.max_system_prompt_bytes}`,
    );
  }

  const requested = parseRequestedTimeouts(row.timeoutsJson);
  const clamped: ClampedField[] = [];
  const applied: AppliedTimeouts = {
    turnTimeoutSecs: clampOne(
      "turn_timeout_seconds",
      requested.turn_timeout_seconds,
      harness.ceilings.turn_timeout_secs,
      clamped,
    ),
    idleTimeoutSecs: clampOne(
      "idle_timeout_seconds",
      requested.idle_timeout_seconds,
      harness.ceilings.idle_timeout_secs,
      clamped,
    ),
    maxTurnDurationSecs: clampOne(
      "max_turn_duration_seconds",
      requested.max_turn_duration_seconds,
      harness.ceilings.max_turn_duration_secs,
      clamped,
    ),
  };

  // An empty model string is not a model; treat it as "unset" so it falls back
  // to the harness default rather than passing `--model ""` to a CLI.
  const requestedModel =
    row.model !== null && row.model.trim() !== "" ? row.model : null;
  const modelApplied = requestedModel ?? harness.defaults.model ?? null;

  return {
    harness: row.harness,
    systemPrompt: row.systemPrompt,
    modelApplied,
    applied,
    clamped,
    instructionVersion: instructionVersionOf({
      harness: row.harness,
      systemPrompt: row.systemPrompt,
      modelApplied,
      applied,
    }),
  };
}

/** Values a harness template placeholder may be filled with. */
export interface PlaceholderValues {
  model: string;
  system_prompt: string;
  agent_id: string;
  workspace: string;
}

/**
 * Substitute placeholders in one template string.
 *
 * Single-pass so a value that itself contains `{model}` is never re-expanded:
 * a system prompt is attacker-adjacent text, and a second pass would let it
 * reach for another placeholder's value.
 */
export function fillPlaceholders(
  template: string,
  values: PlaceholderValues,
): string {
  return template.replace(/\{([^{}]*)\}/g, (whole, name: string) =>
    name in values ? values[name as keyof PlaceholderValues] : whole,
  );
}

/**
 * Drop argv elements whose placeholders resolved to nothing.
 *
 * `["--model", "{model}"]` with no model must yield neither element: passing a
 * bare `--model` with no value makes most CLIs consume the next flag as its
 * argument, silently corrupting the rest of the command line.
 */
function fillArgs(
  args: readonly string[],
  values: PlaceholderValues,
  omit: ReadonlySet<string>,
): string[] {
  const isOmitted = (arg: string): boolean =>
    [...omit].some((name) => arg.includes(`{${name}}`));
  const out: string[] = [];
  for (const raw of args) {
    if (!isOmitted(raw)) {
      out.push(fillPlaceholders(raw, values));
      continue;
    }
    // This element carries an omitted placeholder, so it is dropped. If the
    // element it followed is a bare flag, that flag was this value's label and
    // must go with it — a dangling `--model` would swallow the next flag.
    const previous = out[out.length - 1];
    if (previous !== undefined && previous.startsWith("-")) out.pop();
  }
  return out;
}

export interface ProjectedRunner {
  type: "claude-code" | "codex" | "command";
  cliPath: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/** Build the concrete runner invocation for a projected agent. */
export function projectRunner(input: {
  agentId: string;
  workspace: string;
  instructions: ProjectedInstructions;
  provisioning: ProvisioningConfig;
}): ProjectedRunner {
  const harness = input.provisioning.harnesses[input.instructions.harness];
  if (!harness) {
    throw new ProjectionError(
      "unknown_harness",
      `harness '${input.instructions.harness}' is not allowlisted`,
    );
  }
  const omit = new Set<string>();
  if (input.instructions.modelApplied === null) omit.add("model");
  if (input.instructions.systemPrompt === "") omit.add("system_prompt");

  const values: PlaceholderValues = {
    model: input.instructions.modelApplied ?? "",
    system_prompt: input.instructions.systemPrompt,
    agent_id: input.agentId,
    workspace: input.workspace,
  };

  const env: Record<string, string> = {};
  for (const [key, template] of Object.entries(harness.runner.env)) {
    env[key] = fillPlaceholders(template, values);
  }

  return {
    type: harness.runner.type,
    cliPath: harness.runner.cli_path,
    args: fillArgs(harness.runner.args, values, omit),
    env,
    cwd: input.workspace,
  };
}

/**
 * The synthesized `agents[]` entry for a provisioned agent.
 *
 * Returned as a plain object rather than a parsed one on purpose: the caller
 * appends it to a clone of the operator's config and runs the **whole thing**
 * through `ConfigV2Schema`, so the projection is validated by the same schema
 * that validates hand-written YAML. Nothing here is trusted; if this function
 * produced an invalid agent, the parse would reject it.
 */
export function projectAgentBlock(input: {
  agentId: string;
  workspace: string;
  instructions: ProjectedInstructions;
  provisioning: ProvisioningConfig;
  /** The endpoint block for this agent, already built by the endpoint layer. */
  endpointBlock: Record<string, unknown>;
}): Record<string, unknown> {
  const runner = projectRunner({
    agentId: input.agentId,
    workspace: input.workspace,
    instructions: input.instructions,
    provisioning: input.provisioning,
  });
  const harness = input.provisioning.harnesses[input.instructions.harness];

  // R1.2's two blockers are satisfied structurally, not by relaxation: exactly
  // one runner and exactly one endpoint, always.
  const base = { cwd: runner.cwd, env: runner.env };
  const runnerBlock: Record<string, unknown> =
    runner.type === "command"
      ? {
          type: "command",
          cmd: [runner.cliPath, ...runner.args],
          protocol: harness.runner.protocol,
          ...base,
          // Omitted keys must stay absent rather than be present-and-undefined:
          // the agent schema is strict and distinguishes the two.
          ...(harness.runner.process_model
            ? { process_model: harness.runner.process_model }
            : {}),
          ...(harness.runner.resume_model
            ? { resume_model: harness.runner.resume_model }
            : {}),
        }
      : {
          type: runner.type,
          cli_path: runner.cliPath,
          args: runner.args,
          ...base,
          acknowledge_dangerous: harness.runner.acknowledge_dangerous,
        };

  const tools = input.provisioning.buzz_tools_default;
  const endpointId = String(input.endpointBlock.id ?? "");

  return {
    id: input.agentId,
    runner: runnerBlock,
    endpoints: [input.endpointBlock],
    tools: {
      buzz: {
        policy: tools.policy,
        allowed_commands: tools.allowed_commands,
        // Supplied from the agent's own endpoint rather than from the
        // fleet-wide default, which cannot know it (D5).
        default_endpoint_id: endpointId,
        allowed_endpoint_ids: [endpointId],
        expose_private_key_to_runner: tools.expose_private_key_to_runner,
        acknowledge_dangerous: tools.acknowledge_dangerous,
      },
    },
  };
}
