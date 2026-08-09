// Owner-signed NIP-09 tombstones against Desktop-managed agent records (R5.1).
//
// This module is the whole verification surface of the delete pipeline, and it
// is deliberately pure: no database, no relay, no clock. Deletion is the most
// destructive operation in the feature, so the rules that decide "is this the
// owner telling us to destroy *that* agent" are written once, in one place,
// where every rejection path can be tested without standing anything up.
//
// Two numbers matter and are asserted rather than assumed. The managed-agent
// record is kind **30177**; kind **30179** is `KIND_PRIVATE_MANAGED_AGENT`
// upstream, is in the relay's `AUTHOR_ONLY_KINDS` set, and reading it instead
// would make the reconciliation report silently empty. A tombstone naming any
// other record kind is not our business and is refused.
//
// Everything that fails here deletes nothing. It is logged and surfaced in the
// advisory reconciliation report (R5.11), which is the only destination for an
// event we cannot fully account for.

import { verifyEvent, type Event } from "nostr-tools";

/** Replaceable-event kind of a Buzz managed-agent record. */
export const KIND_MANAGED_AGENT = 30177;

/**
 * `KIND_PRIVATE_MANAGED_AGENT` upstream. Recorded so the distinction is on the
 * record and so a future reader does not "fix" 30177 into this number: 30179
 * is author-only at the relay, and a report querying it would come back empty
 * for every agent while looking perfectly healthy.
 */
export const KIND_PRIVATE_MANAGED_AGENT = 30179;

/** NIP-09 deletion. */
export const KIND_DELETION = 5;

const LOWER_HEX_64 = /^[0-9a-f]{64}$/;

/** A kind:5 that is structurally a managed-agent tombstone. */
export interface AgentTombstone {
  eventId: string;
  /** The signer, which must also be the coordinate's author. */
  ownerPubkey: string;
  /** `d` tag of the record being deleted — the agent's own identity. */
  agentPubkey: string;
  coordinate: string;
  createdAt: number;
}

export type TombstoneRejection =
  | "not_an_event"
  | "invalid_signature"
  | "wrong_kind"
  | "no_a_tag"
  | "multiple_a_tags"
  | "unexpected_e_tag"
  | "malformed_coordinate"
  | "wrong_record_kind"
  | "signer_not_coordinate_author";

export type TombstoneParse =
  | { ok: true; tombstone: AgentTombstone }
  | { ok: false; reason: TombstoneRejection; detail: string };

/**
 * Decide whether an inbound relay frame is a well-formed agent tombstone.
 *
 * Strict on purpose. The upstream builder is pinned by its own test
 * (`build_agent_delete_has_single_a_tag_no_e_tag`) to emit exactly one `a` tag
 * and no `e` tag, so anything else is either a different kind of deletion — a
 * kind:5 carrying an `e` tag deletes a *message* — or something we do not
 * understand well enough to act on destructively.
 */
export function parseAgentTombstone(value: unknown): TombstoneParse {
  if (!value || typeof value !== "object") {
    return {
      ok: false,
      reason: "not_an_event",
      detail: "frame is not an object",
    };
  }
  const event = value as Event;
  if (typeof event.id !== "string" || !Array.isArray(event.tags)) {
    return {
      ok: false,
      reason: "not_an_event",
      detail: "frame is not an event",
    };
  }
  if (event.kind !== KIND_DELETION) {
    return {
      ok: false,
      reason: "wrong_kind",
      detail: `kind ${String(event.kind)} is not a NIP-09 deletion`,
    };
  }
  // Signature before structure: an unsigned event's tags are attacker-chosen,
  // and nothing about them should be trusted enough to branch on.
  let signed = false;
  try {
    signed = verifyEvent(event);
  } catch {
    signed = false;
  }
  if (!signed) {
    return {
      ok: false,
      reason: "invalid_signature",
      detail: `event ${event.id} did not verify`,
    };
  }
  if (event.tags.some((tag) => tag[0] === "e")) {
    return {
      ok: false,
      reason: "unexpected_e_tag",
      detail:
        "a kind:5 carrying an e tag deletes a message, not an agent record",
    };
  }
  const aTags = event.tags.filter((tag) => tag[0] === "a");
  if (aTags.length === 0) {
    return { ok: false, reason: "no_a_tag", detail: "no a tag" };
  }
  if (aTags.length > 1) {
    return {
      ok: false,
      reason: "multiple_a_tags",
      detail: `${aTags.length} a tags; the pinned builder emits exactly one`,
    };
  }
  const coordinate = aTags[0]![1];
  if (typeof coordinate !== "string") {
    return {
      ok: false,
      reason: "malformed_coordinate",
      detail: "a tag has no value",
    };
  }
  const parts = coordinate.split(":");
  if (parts.length !== 3) {
    return {
      ok: false,
      reason: "malformed_coordinate",
      detail: `'${coordinate}' is not kind:author:d`,
    };
  }
  const [kindPart, authorPart, dPart] = parts as [string, string, string];
  if (kindPart !== String(KIND_MANAGED_AGENT)) {
    return {
      ok: false,
      reason: "wrong_record_kind",
      detail: `record kind ${kindPart} is not ${KIND_MANAGED_AGENT}`,
    };
  }
  if (!LOWER_HEX_64.test(authorPart) || !LOWER_HEX_64.test(dPart)) {
    return {
      ok: false,
      reason: "malformed_coordinate",
      detail: "coordinate author or d tag is not lowercase 64-hex",
    };
  }
  if (event.pubkey !== authorPart) {
    // The coordinate names whose record this is. A signer who is not that
    // author is asking us to delete somebody else's agent.
    return {
      ok: false,
      reason: "signer_not_coordinate_author",
      detail: `signed by ${event.pubkey} but the coordinate belongs to ${authorPart}`,
    };
  }
  return {
    ok: true,
    tombstone: {
      eventId: event.id,
      ownerPubkey: authorPart,
      agentPubkey: dPart,
      coordinate,
      createdAt: event.created_at,
    },
  };
}

/** The agent identities a tombstone may be matched against. */
export interface TombstoneMatchContext {
  /**
   * Buzz identities declared in `torana.yaml`. A tombstone naming one of these
   * is ignored, logged, and reported — a YAML agent is never stageable by a
   * relay event, full stop (R5.11). Checked before the provisioned lookup so
   * the refusal names the real reason rather than "unmatched".
   */
  yamlPubkeys: ReadonlySet<string>;
  /** Provisioned agents by `derived_pubkey`. */
  provisionedByPubkey: ReadonlyMap<
    string,
    { agentId: string; ownerPubkey: string | null; lifecycle: string }
  >;
}

export type TombstoneMatch =
  | { kind: "stage"; agentId: string }
  /** Matched, but the agent is already staged; nothing left to do. */
  | { kind: "already_staged"; agentId: string }
  | {
      kind: "ignore";
      reason:
        | "yaml_identity"
        | "unmatched_pubkey"
        | "owner_mismatch"
        | "no_owner";
      detail: string;
      agentId: string | null;
    };

/**
 * Match a verified tombstone to exactly one provisioned agent (R5.2).
 *
 * The owner check is the second half of verification and cannot be folded into
 * `parseAgentTombstone`: the parse proves the signer owns the *coordinate*, and
 * this proves the coordinate's owner is the same key that authorizes
 * `!shutdown` for the agent's endpoint. Without both, anyone able to publish a
 * self-consistent coordinate could name another operator's agent pubkey.
 */
export function matchTombstone(
  tombstone: AgentTombstone,
  context: TombstoneMatchContext,
): TombstoneMatch {
  if (context.yamlPubkeys.has(tombstone.agentPubkey)) {
    return {
      kind: "ignore",
      reason: "yaml_identity",
      agentId: null,
      detail:
        `tombstone names a YAML-declared identity (${tombstone.agentPubkey}); ` +
        `agents declared in torana.yaml are never deletable by a relay event`,
    };
  }
  const agent = context.provisionedByPubkey.get(tombstone.agentPubkey);
  if (!agent) {
    return {
      kind: "ignore",
      reason: "unmatched_pubkey",
      agentId: null,
      detail: `no provisioned agent has derived_pubkey ${tombstone.agentPubkey}`,
    };
  }
  if (agent.ownerPubkey === null) {
    // Create refuses an ownerless agent, so this means the endpoint row was
    // written before that gate existed or out of band. Never stageable.
    return {
      kind: "ignore",
      reason: "no_owner",
      agentId: agent.agentId,
      detail: `agent '${agent.agentId}' has no owner_pubkey recorded`,
    };
  }
  if (agent.ownerPubkey !== tombstone.ownerPubkey) {
    return {
      kind: "ignore",
      reason: "owner_mismatch",
      agentId: agent.agentId,
      detail:
        `tombstone signed by ${tombstone.ownerPubkey} but agent '${agent.agentId}' ` +
        `is owned by ${agent.ownerPubkey}`,
    };
  }
  if (agent.lifecycle === "staged_delete") {
    return { kind: "already_staged", agentId: agent.agentId };
  }
  return { kind: "stage", agentId: agent.agentId };
}

/** The `a`-tag coordinate for one agent's managed-agent record. */
export function managedAgentCoordinate(
  ownerPubkey: string,
  agentPubkey: string,
): string {
  return `${KIND_MANAGED_AGENT}:${ownerPubkey}:${agentPubkey}`;
}
