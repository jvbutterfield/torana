import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { finalizeEvent, type Event } from "nostr-tools";

import { loadConfigFromString } from "../../src/config/load.js";
import { upgradeV1Object } from "../../src/config/v2.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { Metrics } from "../../src/metrics.js";
import { OutboxProcessor } from "../../src/outbox.js";
import { BuzzAdapter } from "../../src/platform/buzz/adapter.js";
import {
  BUZZ_KINDS,
  createOwnerAuthTag,
  decodeSecret,
  publicKey,
} from "../../src/platform/buzz/protocol.js";
import { makeTestBotConfig, makeTestConfig } from "../fixtures/bots.js";

const ENDPOINT_KEY = "41".padStart(64, "0");
const OWNER_KEY = "42".padStart(64, "0");
const ENDPOINT_SECRET = decodeSecret(ENDPOINT_KEY);
const OWNER_SECRET = decodeSecret(OWNER_KEY);
const ENDPOINT_PUBKEY = publicKey(ENDPOINT_SECRET);
const OWNER_PUBKEY = publicKey(OWNER_SECRET);
const CHANNEL = "55555555-6666-4777-8888-999999999999";
const AUTH_TAG = JSON.stringify(
  createOwnerAuthTag(OWNER_SECRET, ENDPOINT_PUBKEY, ""),
);
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "torana-buzz-p8-"));
  tempDirs.push(dir);
  const upgraded = upgradeV1Object(
    makeTestConfig([makeTestBotConfig("alpha")]),
  ) as any;
  upgraded.gateway.data_dir = dir;
  upgraded.gateway.db_path = join(dir, "gateway.db");
  upgraded.platforms.buzz.enabled = true;
  upgraded.outbox.retry_base_ms = 1;
  upgraded.agents[0].endpoints.push({
    id: "alpha-buzz",
    platform: "buzz",
    enabled: true,
    community_id: "primary",
    relay_url: "wss://relay.example",
    private_key: ENDPOINT_KEY,
    auth_tag: AUTH_TAG,
    respond_to: "anyone",
    owner_pubkey: OWNER_PUBKEY,
    subscribe: "all_channels",
    reactions: {},
    triggers: {},
    channel_overrides: { [CHANNEL]: { require_mention: false } },
  });
  const loaded = loadConfigFromString(yaml.dump(upgraded), {
    skipInterpolation: true,
  });
  applyMigrations(loaded.config.gateway.db_path!);
  const db = new GatewayDB(loaded.config.gateway.db_path!);
  db.syncNormalizedConfig(loaded.normalized);
  const endpoint = loaded.normalized.endpoints.find(
    (candidate) => candidate.id === "alpha-buzz",
  )!;
  const adapter = new BuzzAdapter(endpoint);
  adapter.setChannels(
    new Map([[CHANNEL, { id: CHANNEL, name: "media", type: "stream" }]]),
  );
  return { ...loaded, db, adapter, dir };
}

function conversation() {
  return {
    platform: "buzz" as const,
    communityId: "primary",
    endpointId: "alpha-buzz",
    channelId: CHANNEL,
    threadRootId: null,
    workflowRunId: null,
    type: "stream" as const,
  };
}

describe("Phase 8 Buzz inbound media", () => {
  test("materializes image and PDF bytes with signed same-origin reads", async () => {
    const { config, db, adapter } = setup();
    const event = normalizeWith(adapter, [
      { bytes: PNG, mime: "image/png" },
      { bytes: PDF, mime: "application/pdf" },
    ]);
    const requested: string[] = [];
    adapter.setMediaFetch((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      requested.push(url);
      expect(init?.redirect).toBe("manual");
      expect(
        new Headers(init?.headers).get("authorization")?.startsWith("Nostr "),
      ).toBe(true);
      expect(new Headers(init?.headers).get("x-auth-tag")).toBe(AUTH_TAG);
      const bytes = url.endsWith(".pdf") ? PDF : PNG;
      return new Response(bytes, {
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
      });
    }) as unknown as typeof fetch);
    const result = await adapter.materializeAttachments(event, config);
    expect(result.errors).toEqual([]);
    expect(result.attachments.map((item) => item.kind)).toEqual([
      "photo",
      "document",
    ]);
    expect(result.attachments.every((item) => existsSync(item.path))).toBe(
      true,
    );
    expect(result.attachments[0].path).not.toContain("../../");
    expect(readFileSync(result.attachments[0].path)).toEqual(Buffer.from(PNG));
    expect(readFileSync(result.attachments[1].path)).toEqual(Buffer.from(PDF));
    expect(requested).toHaveLength(2);
    const recorded = db.recordBuzzInbound({
      event,
      status: "received",
      cursorScope: `channel:${CHANNEL}:messages`,
    });
    if (recorded.kind !== "inserted") throw new Error("duplicate fixture");
    db.transitionInboundEvent(recorded.id, "received", "dispatched");
    const turnId = db.enqueueRecordedBuzzTurn(
      recorded.id,
      "alpha",
      "Inspect the attached image and PDF.",
      false,
      result.attachments.map((item) => item.path),
    );
    expect(db.getTurnAttachments(turnId!)).toEqual(
      result.attachments.map((item) => item.path),
    );
    db.close();
  });

  test("rejects foreign origins, redirects, compression, and MIME spoofing", async () => {
    const { config, db, adapter } = setup();
    let calls = 0;
    adapter.setMediaFetch((async () => {
      calls += 1;
      if (calls === 1)
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/payload" },
        });
      if (calls === 2)
        return new Response(PNG, {
          status: 200,
          headers: {
            "content-length": String(PNG.byteLength),
            "content-encoding": "gzip",
          },
        });
      return new Response(PDF, {
        status: 200,
        headers: { "content-length": String(PDF.byteLength) },
      });
    }) as unknown as typeof fetch);

    const foreign = normalizeWith(adapter, [
      {
        bytes: PNG,
        mime: "image/png",
        url: `https://169.254.169.254/media/${hash(PNG)}.png`,
      },
    ]);
    expect(
      (await adapter.materializeAttachments(foreign, config)).errors[0],
    ).toContain("not on the configured relay origin");
    expect(calls).toBe(0);

    const originalMax = config.attachments.max_bytes;
    config.attachments.max_bytes = PNG.byteLength - 1;
    const oversized = normalizeWith(adapter, [
      { bytes: PNG, mime: "image/png" },
    ]);
    expect(
      (await adapter.materializeAttachments(oversized, config)).errors[0],
    ).toContain("exceeds max_bytes");
    expect(calls).toBe(0);
    config.attachments.max_bytes = originalMax;

    const redirect = normalizeWith(adapter, [
      {
        bytes: PNG,
        mime: "image/png",
        url: `https://relay.example/media/${hash(PNG)}.png`,
      },
    ]);
    expect(
      (await adapter.materializeAttachments(redirect, config)).errors[0],
    ).toContain("redirect rejected");

    const compressed = normalizeWith(adapter, [
      {
        bytes: PNG,
        mime: "image/png",
        url: `https://relay.example/media/${hash(PNG)}.png`,
      },
    ]);
    expect(
      (await adapter.materializeAttachments(compressed, config)).errors[0],
    ).toContain("compressed media response rejected");

    const spoofed = normalizeWith(adapter, [{ bytes: PDF, mime: "image/png" }]);
    expect(
      (await adapter.materializeAttachments(spoofed, config)).errors[0],
    ).toContain("magic bytes do not match");
    db.close();
  });
});

describe("Phase 8 Buzz outbound media", () => {
  test("uploads once, persists imeta plus the signed event, and reuses both on retry", async () => {
    const { config, normalized, db, adapter, dir } = setup();
    const file = join(dir, "outbound.png");
    writeFileSync(file, PNG);
    let uploads = 0;
    adapter.setMediaFetch((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe("https://relay.example/upload");
      expect(init?.method).toBe("PUT");
      expect(init?.redirect).toBe("manual");
      uploads += 1;
      return Response.json({
        url: `https://relay.example/media/${hash(PNG)}.png`,
        sha256: hash(PNG),
        size: PNG.byteLength,
        type: "image/png",
        uploaded: 1,
      });
    }) as unknown as typeof fetch);
    const published: Event[] = [];
    adapter.setPublisher(async (signed) => {
      published.push(signed);
      return published.length === 1
        ? { ok: false, retriable: true, description: "ack lost" }
        : { ok: true, externalMessageId: signed.id };
    });
    const metrics = new Metrics(config);
    const outbox = new OutboxProcessor(
      config,
      db,
      new Map([["alpha-buzz", adapter]]),
      metrics,
      null,
      { normalized },
    );
    const id = outbox.queueOperation(null, "alpha", conversation(), {
      kind: "send",
      text: "See attachment",
      files: [
        {
          kind: "photo",
          path: file,
          mime_type: "image/png",
          bytes: PNG.byteLength,
        },
      ],
    });
    expect(
      db._unsafeQuery("SELECT signed_event_id FROM outbox WHERE id=?").get(id),
    ).toEqual({ signed_event_id: null });
    await outbox.drain(1000);
    const stored = db
      ._unsafeQuery(
        "SELECT status, signed_event_id, signed_payload_json FROM outbox WHERE id=?",
      )
      .get(id) as {
      status: string;
      signed_event_id: string;
      signed_payload_json: string;
    };
    const signed = JSON.parse(stored.signed_payload_json) as Event;
    expect(stored.status).toBe("sent");
    expect(stored.signed_event_id).toBe(signed.id);
    expect(signed.tags).toContainEqual([
      "imeta",
      `url https://relay.example/media/${hash(PNG)}.png`,
      "m image/png",
      `x ${hash(PNG)}`,
      `size ${PNG.byteLength}`,
    ]);
    expect(uploads).toBe(1);
    expect(published).toHaveLength(2);
    expect(published[0].id).toBe(published[1].id);
    db.close();
  });

  test("keeps media-thread comments on the forum root", async () => {
    const { config, db, adapter, dir } = setup();
    const file = join(dir, "comment.pdf");
    writeFileSync(file, PDF);
    adapter.setMediaFetch((async () =>
      Response.json({
        url: `https://relay.example/media/${hash(PDF)}.pdf`,
        sha256: hash(PDF),
        size: PDF.byteLength,
        type: "application/pdf",
        uploaded: 1,
      })) as unknown as typeof fetch);
    const prepared = await adapter.prepareOutboundAsync(
      { ...conversation(), threadRootId: "a".repeat(64), type: "forum" },
      {
        kind: "forum_comment",
        rootEventId: "a".repeat(64),
        replyTo: "b".repeat(64),
        text: "Document attached",
        files: [
          {
            kind: "document",
            path: file,
            mime_type: "application/pdf",
            bytes: PDF.byteLength,
          },
        ],
      },
      config,
    );
    const signed = JSON.parse(prepared.signedPayloadJson!) as Event;
    expect(signed.kind).toBe(BUZZ_KINDS.forumComment);
    expect(signed.tags).toContainEqual(["e", "a".repeat(64), "", "root"]);
    expect(signed.tags).toContainEqual(["e", "b".repeat(64), "", "reply"]);
    expect(signed.tags.some((tag) => tag[0] === "imeta")).toBe(true);
    db.close();
  });
});

function normalizeWith(
  adapter: BuzzAdapter,
  entries: Array<{ bytes: Uint8Array; mime: string; url?: string }>,
) {
  const raw = finalizeEvent(
    {
      kind: BUZZ_KINDS.streamMessageV1,
      content: "Please inspect these files.",
      tags: [
        ["h", CHANNEL],
        ...entries.map(({ bytes, mime, url }) => [
          "imeta",
          `url ${url ?? `https://relay.example/media/${hash(bytes)}.${mime === "application/pdf" ? "pdf" : "png"}`}`,
          `m ${mime}`,
          `x ${hash(bytes)}`,
          `size ${bytes.byteLength}`,
          "filename user/../../name.bin",
        ]),
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    OWNER_SECRET,
  );
  const normalized = adapter.normalizeInbound(raw);
  if (!normalized) throw new Error("fixture did not normalize");
  return normalized;
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
