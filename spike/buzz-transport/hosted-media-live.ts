import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/schema.js";
import {
  buildImetaTag,
  downloadBuzzAttachments,
  uploadBuzzFiles,
} from "../../src/platform/buzz/media.js";
import type { InboundEvent } from "../../src/platform/types.js";
import { BuzzSpikeClient } from "./relay-client.js";
import {
  BUZZ_KINDS,
  channelFilter,
  decodeSecret,
  parseOwnerAuthTag,
  signTemplate,
} from "./protocol.js";

const relayUrl = process.env.BUZZ_RELAY_URL;
const privateKey = process.env.BUZZ_PRIVATE_KEY;
const channelId = process.env.BUZZ_CHANNEL_ID;

if (!relayUrl || !privateKey || !channelId) {
  throw new Error("Set BUZZ_RELAY_URL, BUZZ_PRIVATE_KEY, and BUZZ_CHANNEL_ID");
}
if (process.env.BUZZ_PHASE8_PUBLISH !== "1") {
  throw new Error("Set BUZZ_PHASE8_PUBLISH=1 for the hosted media probe");
}

const ownerAuthTag = parseOwnerAuthTag(process.env.BUZZ_AUTH_TAG);
if (!ownerAuthTag) {
  throw new Error("BUZZ_AUTH_TAG is required by the hosted closed relay");
}

const secret = decodeSecret(privateKey);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const pdf = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
);
const dataDir = await mkdtemp(join(tmpdir(), "torana-buzz-hosted-media-"));
const imagePath = join(dataDir, "phase8.png");
const pdfPath = join(dataDir, "phase8.pdf");
let client: BuzzSpikeClient | null = null;

try {
  await writeFile(imagePath, png, { mode: 0o600 });
  await writeFile(pdfPath, pdf, { mode: 0o600 });
  const descriptors = await uploadBuzzFiles({
    files: [
      {
        kind: "photo",
        path: imagePath,
        mime_type: "image/png",
        bytes: png.byteLength,
      },
      {
        kind: "document",
        path: pdfPath,
        mime_type: "application/pdf",
        bytes: pdf.byteLength,
      },
    ],
    maxBytes: 2 * 1024 * 1024,
    relayUrl,
    privateKey,
    authTag: process.env.BUZZ_AUTH_TAG ?? null,
  });

  const createdAt = Math.floor(Date.now() / 1000);
  const event = signTemplate(
    {
      kind: BUZZ_KINDS.streamMessageV1,
      created_at: createdAt,
      content: `Torana Phase 8 hosted media probe ${new Date(createdAt * 1000).toISOString()}`,
      tags: [
        ["h", channelId],
        ...descriptors.map((descriptor) => buildImetaTag(descriptor)),
      ],
    },
    secret,
    ownerAuthTag,
  );

  client = new BuzzSpikeClient(relayUrl, secret, ownerAuthTag);
  await client.connect();
  const discoveredChannels = await client.discoverChannels();
  if (!discoveredChannels.includes(channelId)) {
    throw new Error("configured channel is not in the membership set");
  }

  const first = await client.publish(event);
  const retry = await client.publish(event);
  const intake = await client.query(
    [
      channelFilter({
        channelId,
        kinds: [BUZZ_KINDS.streamMessageV1],
        since: createdAt - 1,
      }),
    ],
    `hosted-media-${createdAt}`,
  );
  const stored = intake.find((candidate) => candidate.id === event.id);
  if (!stored) throw new Error("published media event was not returned");

  const inbound: InboundEvent = {
    platform: "buzz",
    endpointId: "hosted-live",
    agentId: "hosted-live",
    communityId: "hosted-live",
    conversation: null,
    externalEventId: stored.id,
    externalMessageId: stored.id,
    targetExternalEventId: null,
    workflowRunId: null,
    sender: {
      id: stored.pubkey,
      kind: "agent",
      displayName: null,
      username: null,
      raw: stored.pubkey,
    },
    kind: "message",
    text: stored.content,
    markdown: true,
    replyTo: null,
    rootEventId: null,
    mentions: [],
    attachments: stored.tags
      .filter((tag) => tag[0] === "imeta")
      .map((tag, index) => ({
        externalId: descriptors[index]?.sha256 ?? `imeta-${index}`,
        kind: descriptors[index]?.type.startsWith("image/")
          ? "image"
          : "document",
        mimeType: descriptors[index]?.type ?? null,
        originalFilename: null,
        sizeBytes: descriptors[index]?.size ?? null,
        raw: tag,
      })),
    occurredAt: stored.created_at,
    receivedSeq: 0,
    raw: stored,
  };
  const config = {
    gateway: { data_dir: dataDir },
    attachments: {
      max_per_turn: 2,
      max_bytes: 2 * 1024 * 1024,
      disk_usage_cap_bytes: 8 * 1024 * 1024,
    },
  } as Config;
  const downloaded = await downloadBuzzAttachments({
    event: inbound,
    config,
    relayUrl,
    privateKey,
    authTag: process.env.BUZZ_AUTH_TAG ?? null,
  });
  if (downloaded.errors.length > 0) {
    throw new Error(downloaded.errors.join("; "));
  }
  if (downloaded.attachments.length !== descriptors.length) {
    throw new Error("not all hosted media attachments were materialized");
  }
  for (const [index, attachment] of downloaded.attachments.entries()) {
    const bytes = await readFile(attachment.path);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== descriptors[index]?.sha256) {
      throw new Error(`downloaded attachment ${index + 1} hash mismatch`);
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        channelId,
        discoveredChannelCount: discoveredChannels.length,
        eventId: event.id,
        first,
        retry,
        signedEventReused: true,
        uploaded: descriptors.map(({ sha256, size, type }) => ({
          sha256,
          size,
          type,
        })),
        downloadedAndVerified: downloaded.attachments.length,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  client?.close();
  await rm(dataDir, { recursive: true, force: true });
}
