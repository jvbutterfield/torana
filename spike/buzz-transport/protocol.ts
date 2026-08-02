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
  auth: 22242,
  presence: 20001,
  typing: 20002,
  workflowDefinition: 30620,
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

export type OwnerAuthTag = ["auth", string, string, string];

const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const LOWER_HEX_128 = /^[0-9a-f]{128}$/;

export function decodeSecret(input: string): Uint8Array {
  if (LOWER_HEX_64.test(input)) return Uint8Array.fromHex(input);
  if (input.startsWith("nsec1")) {
    const decoded = nip19.decode(input);
    if (decoded.type !== "nsec")
      throw new Error("BUZZ_PRIVATE_KEY is not an nsec");
    return decoded.data;
  }
  throw new Error(
    "BUZZ_PRIVATE_KEY must be lowercase 64-character hex or nsec",
  );
}

export function parseOwnerAuthTag(
  raw: string | undefined,
): OwnerAuthTag | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value: unknown = JSON.parse(raw);
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((part) => typeof part !== "string") ||
    value[0] !== "auth" ||
    !LOWER_HEX_64.test(value[1]) ||
    !validOwnerConditions(value[2]) ||
    !LOWER_HEX_128.test(value[3])
  ) {
    throw new Error("BUZZ_AUTH_TAG must be a strict lowercase NIP-OA auth tag");
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

export function createOwnerAuthTag(
  ownerSecret: Uint8Array,
  agentPubkey: string,
  conditions: string,
): OwnerAuthTag {
  if (!LOWER_HEX_64.test(agentPubkey) || !validOwnerConditions(conditions))
    throw new Error("invalid NIP-OA inputs");
  const ownerPubkey = getPublicKey(ownerSecret);
  if (ownerPubkey === agentPubkey)
    throw new Error("owner and agent pubkeys must differ");
  const message = sha256(
    new TextEncoder().encode(`nostr:agent-auth:${agentPubkey}:${conditions}`),
  );
  const signature = schnorr.sign(message, ownerSecret).toHex();
  return ["auth", ownerPubkey, conditions, signature];
}

export function verifyOwnerAuthTag(
  tag: OwnerAuthTag,
  agentPubkey: string,
): boolean {
  if (
    !LOWER_HEX_64.test(agentPubkey) ||
    tag[1] === agentPubkey ||
    !validOwnerConditions(tag[2])
  )
    return false;
  const message = sha256(
    new TextEncoder().encode(`nostr:agent-auth:${agentPubkey}:${tag[2]}`),
  );
  return schnorr.verify(
    Uint8Array.fromHex(tag[3]),
    message,
    Uint8Array.fromHex(tag[1]),
  );
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
  const authCount = template.tags.filter((tag) => tag[0] === "auth").length;
  if (authCount !== 0) throw new Error("callers may not supply auth tags");
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

export function buildThreadedReply(args: {
  channelId: string;
  content: string;
  replyTo: string;
  rootId?: string;
  mentionPubkey?: string;
  secret: Uint8Array;
  ownerAuthTag?: OwnerAuthTag;
  createdAt?: number;
}): Event {
  const rootId = args.rootId ?? args.replyTo;
  const tags: string[][] = [["h", args.channelId]];
  if (rootId === args.replyTo) tags.push(["e", rootId, "", "reply"]);
  else {
    tags.push(["e", rootId, "", "root"]);
    tags.push(["e", args.replyTo, "", "reply"]);
  }
  if (args.mentionPubkey) tags.push(["p", args.mentionPubkey]);
  return signTemplate(
    {
      kind: BUZZ_KINDS.streamMessageV1,
      created_at: args.createdAt ?? Math.floor(Date.now() / 1000),
      content: args.content,
      tags,
    },
    args.secret,
    args.ownerAuthTag,
  );
}

export function buildChannelMessage(args: {
  channelId: string;
  content: string;
  secret: Uint8Array;
  ownerAuthTag?: OwnerAuthTag;
  createdAt?: number;
}): Event {
  return signTemplate(
    {
      kind: BUZZ_KINDS.streamMessageV1,
      created_at: args.createdAt ?? Math.floor(Date.now() / 1000),
      content: args.content,
      tags: [["h", args.channelId]],
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
}): Filter {
  return {
    ...(args.kinds ? { kinds: args.kinds } : {}),
    "#h": [args.channelId],
    ...(args.pubkey ? { "#p": [args.pubkey] } : {}),
    ...(args.since === undefined ? {} : { since: args.since }),
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

export function discoverChannelIds(events: Event[]): string[] {
  return [
    ...new Set(
      events.flatMap((event) =>
        event.tags.filter((tag) => tag[0] === "d").map((tag) => tag[1]),
      ),
    ),
  ].sort();
}

export function isValidInboundEvent(event: Event): boolean {
  return verifyEvent(event);
}

export class EventDeduper {
  readonly #ids = new Set<string>();

  accept(event: Pick<Event, "id">): boolean {
    if (this.#ids.has(event.id)) return false;
    this.#ids.add(event.id);
    return true;
  }

  get size(): number {
    return this.#ids.size;
  }
}

export function publicKey(secret: Uint8Array): string {
  return getPublicKey(secret);
}
