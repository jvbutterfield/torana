// US-034 — tombstone verification and matching.
//
// This is the gate in front of the most destructive operation in the product,
// so the file is deliberately lopsided: one happy path and eighteen refusals.
// Every refusal below is a way an attacker, a bug, or a differently-versioned
// Desktop could ask Torana to destroy an agent, and each one must delete
// nothing.

import { describe, expect, test } from "bun:test";

import {
  KIND_DELETION,
  KIND_MANAGED_AGENT,
  KIND_PRIVATE_MANAGED_AGENT,
  managedAgentCoordinate,
  matchTombstone,
  parseAgentTombstone,
} from "../../src/platform/buzz/tombstone.js";
import {
  decodeSecret,
  publicKey,
  signTemplate,
} from "../../src/platform/buzz/protocol.js";

const OWNER_SECRET = decodeSecret("04".padStart(64, "0"));
const OWNER_PUBKEY = publicKey(OWNER_SECRET);
const OTHER_SECRET = decodeSecret("07".padStart(64, "0"));
const OTHER_PUBKEY = publicKey(OTHER_SECRET);
const AGENT_PUBKEY = publicKey(decodeSecret("0a".repeat(32)));

function tombstone(
  overrides: {
    secret?: Uint8Array;
    kind?: number;
    tags?: string[][];
    coordinate?: string;
  } = {},
) {
  const coordinate =
    overrides.coordinate ?? managedAgentCoordinate(OWNER_PUBKEY, AGENT_PUBKEY);
  return signTemplate(
    {
      kind: overrides.kind ?? KIND_DELETION,
      created_at: 1_786_000_000,
      content: "",
      tags: overrides.tags ?? [["a", coordinate]],
    },
    overrides.secret ?? OWNER_SECRET,
  );
}

/**
 * Round-trip through JSON, as a real relay frame does.
 *
 * `finalizeEvent` stamps a "already verified" symbol on the object it returns
 * and `verifyEvent` honours it, so a locally-built event mutated in place would
 * pass verification no matter what was changed. Nothing that reaches the
 * watcher has that symbol; neither should a forgery fixture.
 */
function overTheWire(event: unknown): Record<string, string> & {
  sig: string;
  content: string;
} {
  return JSON.parse(JSON.stringify(event));
}

describe("parseAgentTombstone accepts the pinned upstream shape", () => {
  test("an owner-signed kind:5 with exactly one a tag and no e tag", () => {
    const parsed = parseAgentTombstone(tombstone());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tombstone).toMatchObject({
      ownerPubkey: OWNER_PUBKEY,
      agentPubkey: AGENT_PUBKEY,
      coordinate: `${KIND_MANAGED_AGENT}:${OWNER_PUBKEY}:${AGENT_PUBKEY}`,
    });
  });

  test("a relay hint in the third a-tag position is ignored, not refused", () => {
    const parsed = parseAgentTombstone(
      tombstone({
        tags: [
          [
            "a",
            managedAgentCoordinate(OWNER_PUBKEY, AGENT_PUBKEY),
            "wss://relay.example",
          ],
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  test("the record kind is 30177, and 30179 is a different thing entirely", () => {
    // Guards the one number in this feature that fails silently when wrong:
    // 30179 is author-only at the relay, so reading it would make every report
    // look empty rather than broken.
    expect(KIND_MANAGED_AGENT).toBe(30177);
    expect(KIND_PRIVATE_MANAGED_AGENT).toBe(30179);
  });
});

describe("parseAgentTombstone refuses everything else", () => {
  test("a non-object frame", () => {
    expect(parseAgentTombstone("not an event")).toMatchObject({
      ok: false,
      reason: "not_an_event",
    });
    expect(parseAgentTombstone(null)).toMatchObject({
      ok: false,
      reason: "not_an_event",
    });
  });

  test("an object that is not shaped like an event", () => {
    expect(parseAgentTombstone({ kind: 5 })).toMatchObject({
      ok: false,
      reason: "not_an_event",
    });
  });

  test("a kind that is not 5", () => {
    expect(parseAgentTombstone(tombstone({ kind: 9 }))).toMatchObject({
      ok: false,
      reason: "wrong_kind",
    });
  });

  test("a wrongly-signed event, even with a perfect coordinate", () => {
    const event = overTheWire(tombstone());
    event.sig = `${event.sig.slice(0, -1)}${event.sig.endsWith("a") ? "b" : "a"}`;
    expect(parseAgentTombstone(event)).toMatchObject({
      ok: false,
      reason: "invalid_signature",
    });
  });

  test("an event whose id does not match its content", () => {
    const event = overTheWire(tombstone());
    event.content = "rewritten after signing";
    expect(parseAgentTombstone(event)).toMatchObject({
      ok: false,
      reason: "invalid_signature",
    });
  });

  test("a kind:5 carrying an e tag — that deletes a message, not an agent", () => {
    const parsed = parseAgentTombstone(
      tombstone({
        tags: [
          ["a", managedAgentCoordinate(OWNER_PUBKEY, AGENT_PUBKEY)],
          ["e", "f".repeat(64)],
        ],
      }),
    );
    expect(parsed).toMatchObject({ ok: false, reason: "unexpected_e_tag" });
  });

  test("no a tag at all", () => {
    expect(parseAgentTombstone(tombstone({ tags: [] }))).toMatchObject({
      ok: false,
      reason: "no_a_tag",
    });
  });

  test("more than one a tag — the pinned builder emits exactly one", () => {
    const parsed = parseAgentTombstone(
      tombstone({
        tags: [
          ["a", managedAgentCoordinate(OWNER_PUBKEY, AGENT_PUBKEY)],
          ["a", managedAgentCoordinate(OWNER_PUBKEY, OTHER_PUBKEY)],
        ],
      }),
    );
    expect(parsed).toMatchObject({ ok: false, reason: "multiple_a_tags" });
  });

  test("an a tag with no value", () => {
    expect(parseAgentTombstone(tombstone({ tags: [["a"]] }))).toMatchObject({
      ok: false,
      reason: "malformed_coordinate",
    });
  });

  test("a coordinate that is not kind:author:d", () => {
    expect(
      parseAgentTombstone(tombstone({ coordinate: `${KIND_MANAGED_AGENT}:x` })),
    ).toMatchObject({ ok: false, reason: "malformed_coordinate" });
  });

  test("a coordinate naming the private managed-agent kind", () => {
    expect(
      parseAgentTombstone(
        tombstone({
          coordinate: `${KIND_PRIVATE_MANAGED_AGENT}:${OWNER_PUBKEY}:${AGENT_PUBKEY}`,
        }),
      ),
    ).toMatchObject({ ok: false, reason: "wrong_record_kind" });
  });

  test("a coordinate whose d tag is not lowercase 64-hex", () => {
    expect(
      parseAgentTombstone(
        tombstone({
          coordinate: `${KIND_MANAGED_AGENT}:${OWNER_PUBKEY}:${AGENT_PUBKEY.toUpperCase()}`,
        }),
      ),
    ).toMatchObject({ ok: false, reason: "malformed_coordinate" });
  });

  test("a signer who is not the coordinate's author", () => {
    // Someone else's key, naming our owner's coordinate. Signature verifies
    // perfectly; the event is still not the owner's word.
    const parsed = parseAgentTombstone(tombstone({ secret: OTHER_SECRET }));
    expect(parsed).toMatchObject({
      ok: false,
      reason: "signer_not_coordinate_author",
    });
  });
});

const provisioned = (
  overrides: Partial<{
    agentId: string;
    ownerPubkey: string | null;
    lifecycle: string;
  }> = {},
) =>
  new Map([
    [
      AGENT_PUBKEY,
      {
        agentId: overrides.agentId ?? "canary",
        ownerPubkey:
          overrides.ownerPubkey === undefined
            ? OWNER_PUBKEY
            : overrides.ownerPubkey,
        lifecycle: overrides.lifecycle ?? "active",
      },
    ],
  ]);

function verified() {
  const parsed = parseAgentTombstone(tombstone());
  if (!parsed.ok) throw new Error("fixture should parse");
  return parsed.tombstone;
}

describe("matchTombstone", () => {
  test("stages the one agent holding that identity", () => {
    expect(
      matchTombstone(verified(), {
        yamlPubkeys: new Set(),
        provisionedByPubkey: provisioned(),
      }),
    ).toEqual({ kind: "stage", agentId: "canary" });
  });

  test("a YAML identity is never stageable, even if a row also claims it", () => {
    // YAML precedence is checked first on purpose: the refusal has to name the
    // real reason, and a config-declared agent must never be destroyable by
    // anything arriving over a relay.
    expect(
      matchTombstone(verified(), {
        yamlPubkeys: new Set([AGENT_PUBKEY]),
        provisionedByPubkey: provisioned(),
      }),
    ).toMatchObject({ kind: "ignore", reason: "yaml_identity" });
  });

  test("an unmatched pubkey deletes nothing", () => {
    expect(
      matchTombstone(verified(), {
        yamlPubkeys: new Set(),
        provisionedByPubkey: new Map(),
      }),
    ).toMatchObject({ kind: "ignore", reason: "unmatched_pubkey" });
  });

  test("a tombstone from the wrong owner deletes nothing", () => {
    expect(
      matchTombstone(verified(), {
        yamlPubkeys: new Set(),
        provisionedByPubkey: provisioned({ ownerPubkey: OTHER_PUBKEY }),
      }),
    ).toMatchObject({ kind: "ignore", reason: "owner_mismatch" });
  });

  test("an agent with no recorded owner is not stageable", () => {
    expect(
      matchTombstone(verified(), {
        yamlPubkeys: new Set(),
        provisionedByPubkey: provisioned({ ownerPubkey: null }),
      }),
    ).toMatchObject({ kind: "ignore", reason: "no_owner" });
  });

  test("a redelivered tombstone for a staged agent is a no-op, not a re-stage", () => {
    // Backfill overlap guarantees redelivery. Re-staging would push the purge
    // deadline out on every reconnect, so the grace window would never end.
    expect(
      matchTombstone(verified(), {
        yamlPubkeys: new Set(),
        provisionedByPubkey: provisioned({ lifecycle: "staged_delete" }),
      }),
    ).toEqual({ kind: "already_staged", agentId: "canary" });
  });
});
