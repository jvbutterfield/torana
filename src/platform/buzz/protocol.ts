import {
  finalizeEvent,
  getPublicKey,
  nip19,
  verifyEvent,
  type Event,
  type EventTemplate,
  type Filter,
} from "nostr-tools";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const BUZZ_KINDS = Object.freeze({
  deletion: 5,
  reaction: 7,
  streamMessageV1: 9,
  fileMetadata: 1063,
  nativeDelete: 9005,
  presence: 20001,
  typing: 20002,
  auth: 22242,
  groupMetadata: 39000,
  groupMembers: 39002,
  streamMessageV2: 40002,
  streamEdit: 40003,
  streamDiff: 40008,
  canvas: 40100,
  memberAdded: 44100,
  memberRemoved: 44101,
  forumPost: 45001,
  forumVote: 45002,
  forumComment: 45003,
  workflowTriggered: 46001,
  workflowStepStarted: 46002,
  workflowStepCompleted: 46003,
  workflowStepFailed: 46004,
  workflowCompleted: 46005,
  workflowFailed: 46006,
  workflowCancelled: 46007,
  workflowApprovalRequested: 46010,
  workflowApprovalGranted: 46011,
  workflowApprovalDenied: 46012,
  workflowTrigger: 46020,
  approvalGrant: 46030,
  approvalDeny: 46031,
});

export interface BuzzChannelMetadata {
  id: string;
  name: string | null;
  type: "stream" | "forum" | "dm" | "workflow";
}

export const DEFAULT_MESSAGE_KINDS = [
  BUZZ_KINDS.streamMessageV1,
  BUZZ_KINDS.streamMessageV2,
] as const;

export const DEFAULT_MUTATION_KINDS = [
  BUZZ_KINDS.streamEdit,
  BUZZ_KINDS.deletion,
  BUZZ_KINDS.nativeDelete,
] as const;

export type OwnerAuthTag = ["auth", string, string, string];

const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const LOWER_HEX_128 = /^[0-9a-f]{128}$/;

export function normalizePubkey(input: string): string {
  const value = input.trim().toLowerCase();
  if (LOWER_HEX_64.test(value)) return value;
  if (value.startsWith("npub1")) {
    const decoded = nip19.decode(value);
    if (decoded.type !== "npub") throw new Error("value is not an npub");
    return decoded.data;
  }
  throw new Error("pubkey must be lowercase 64-character hex or npub");
}

export function decodeSecret(input: string): Uint8Array {
  const value = input.trim();
  if (LOWER_HEX_64.test(value)) return Uint8Array.fromHex(value);
  if (value.startsWith("nsec1")) {
    const decoded = nip19.decode(value);
    if (decoded.type !== "nsec") throw new Error("value is not an nsec");
    return decoded.data;
  }
  throw new Error("private key must be lowercase 64-character hex or nsec");
}

export function publicKey(secret: Uint8Array): string {
  return getPublicKey(secret);
}

export function parseOwnerAuthTag(
  raw: string | undefined,
): OwnerAuthTag | undefined {
  if (raw === undefined || raw === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("auth tag must be JSON");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((part) => typeof part !== "string") ||
    value[0] !== "auth" ||
    !LOWER_HEX_64.test(value[1]) ||
    !validOwnerConditions(value[2]) ||
    !LOWER_HEX_128.test(value[3])
  ) {
    throw new Error("auth tag must be a strict lowercase NIP-OA auth tag");
  }
  return value as OwnerAuthTag;
}

function validOwnerConditions(conditions: string): boolean {
  if (conditions === "") return true;
  return conditions.split("&").every((clause) => {
    const match = clause.match(
      /^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/,
    );
    if (!match) return false;
    const value = Number(match[2]);
    return (
      Number.isSafeInteger(value) &&
      value <= (match[1] === "kind=" ? 65_535 : 4_294_967_295)
    );
  });
}

export function verifyOwnerAuthTag(
  tag: OwnerAuthTag,
  agentPubkey: string,
): boolean {
  if (
    !LOWER_HEX_64.test(agentPubkey) ||
    tag[1] === agentPubkey ||
    !validOwnerConditions(tag[2])
  ) {
    return false;
  }
  const message = sha256(
    new TextEncoder().encode(`nostr:agent-auth:${agentPubkey}:${tag[2]}`),
  );
  return schnorr.verify(
    Uint8Array.fromHex(tag[3]),
    message,
    Uint8Array.fromHex(tag[1]),
  );
}

export function createOwnerAuthTag(
  ownerSecret: Uint8Array,
  agentPubkey: string,
  conditions: string,
): OwnerAuthTag {
  if (!LOWER_HEX_64.test(agentPubkey) || !validOwnerConditions(conditions)) {
    throw new Error("invalid NIP-OA inputs");
  }
  const ownerPubkey = getPublicKey(ownerSecret);
  if (ownerPubkey === agentPubkey) {
    throw new Error("owner and endpoint pubkeys must differ");
  }
  const message = sha256(
    new TextEncoder().encode(`nostr:agent-auth:${agentPubkey}:${conditions}`),
  );
  return [
    "auth",
    ownerPubkey,
    conditions,
    schnorr.sign(message, ownerSecret).toHex(),
  ];
}

export function ownerAuthTagAllowsEvent(
  tag: OwnerAuthTag,
  event: Pick<Event, "kind" | "created_at">,
): boolean {
  if (tag[2] === "") return true;
  return tag[2].split("&").every((clause) => {
    if (clause.startsWith("kind="))
      return event.kind === Number(clause.slice(5));
    if (clause.startsWith("created_at<"))
      return event.created_at < Number(clause.slice("created_at<".length));
    if (clause.startsWith("created_at>"))
      return event.created_at > Number(clause.slice("created_at>".length));
    return false;
  });
}

export function signTemplate(
  template: EventTemplate,
  secret: Uint8Array,
  ownerAuthTag?: OwnerAuthTag,
): Event {
  if (template.tags.some((tag) => tag[0] === "auth")) {
    throw new Error("callers may not supply auth tags");
  }
  const tags = ownerAuthTag ? [...template.tags, ownerAuthTag] : template.tags;
  const event = finalizeEvent({ ...template, tags }, secret);
  if (!verifyEvent(event))
    throw new Error("locally signed event did not verify");
  return event;
}

export function buildAuthEvent(args: {
  relayUrl: string;
  challenge: string;
  secret: Uint8Array;
  ownerAuthTag?: OwnerAuthTag;
  createdAt?: number;
}): Event {
  return signTemplate(
    {
      kind: BUZZ_KINDS.auth,
      created_at: args.createdAt ?? Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["relay", args.relayUrl],
        ["challenge", args.challenge],
      ],
    },
    args.secret,
    args.ownerAuthTag,
  );
}

export function channelFilter(args: {
  channelId: string;
  pubkey?: string;
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
}): Filter {
  return {
    ...(args.kinds ? { kinds: args.kinds } : {}),
    "#h": [args.channelId],
    ...(args.pubkey ? { "#p": [args.pubkey] } : {}),
    ...(args.since === undefined ? {} : { since: args.since }),
    ...(args.until === undefined ? {} : { until: args.until }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  };
}

export function membershipFilter(pubkey: string, since?: number): Filter {
  return {
    kinds: [BUZZ_KINDS.memberAdded, BUZZ_KINDS.memberRemoved],
    "#p": [pubkey],
    ...(since === undefined ? {} : { since }),
  };
}

export function discoveryFilters(pubkey: string): Filter[] {
  return [{ kinds: [BUZZ_KINDS.groupMembers], "#p": [pubkey] }];
}

export function channelMetadataFilter(channelIds: string[]): Filter {
  return { kinds: [BUZZ_KINDS.groupMetadata], "#d": channelIds };
}

export function parseChannelMetadata(
  events: readonly Event[],
): Map<string, BuzzChannelMetadata> {
  const result = new Map<string, BuzzChannelMetadata>();
  for (const event of events) {
    if (event.kind !== BUZZ_KINDS.groupMetadata) continue;
    const id = firstTag(event, "d");
    if (!id) continue;
    const explicit = firstTag(event, "t");
    const hidden = event.tags.some((tag) => tag[0] === "hidden");
    const type =
      explicit === "dm" || hidden
        ? "dm"
        : explicit === "forum"
          ? "forum"
          : explicit === "workflow"
            ? "workflow"
            : "stream";
    result.set(id, { id, name: firstTag(event, "name") ?? null, type });
  }
  return result;
}

export function discoverChannelIds(events: Event[]): string[] {
  return [
    ...new Set(
      events.flatMap((event) =>
        event.tags
          .filter((tag) => tag[0] === "d" && typeof tag[1] === "string")
          .map((tag) => tag[1]!),
      ),
    ),
  ].sort();
}

export function isValidInboundEvent(value: unknown): value is Event {
  if (!value || typeof value !== "object") return false;
  try {
    return verifyEvent(value as Event);
  } catch {
    return false;
  }
}

export function firstTag(event: Event, name: string): string | null {
  return event.tags.find((tag) => tag[0] === name)?.[1] ?? null;
}

export function allTags(event: Event, name: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === name && typeof tag[1] === "string")
    .map((tag) => tag[1]!);
}
