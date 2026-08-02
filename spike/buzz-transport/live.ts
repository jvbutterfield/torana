import { BuzzSpikeClient, proveReconnectAndDedup } from "./relay-client";
import { decodeSecret, parseOwnerAuthTag } from "./protocol";

const relayUrl = process.env.BUZZ_RELAY_URL;
const privateKey = process.env.BUZZ_PRIVATE_KEY;
if (!relayUrl || !privateKey) {
  throw new Error(
    "Set BUZZ_RELAY_URL and BUZZ_PRIVATE_KEY to run the live Phase 0 probe",
  );
}

const secret = decodeSecret(privateKey);
const ownerAuthTag = parseOwnerAuthTag(process.env.BUZZ_AUTH_TAG);
const client = new BuzzSpikeClient(relayUrl, secret, ownerAuthTag);
await client.connect();
const channels = await client.discoverChannels();
if (channels.length === 0)
  throw new Error("the configured identity has no discoverable channels");
const channelId = process.env.BUZZ_CHANNEL_ID ?? channels[0];
if (!channels.includes(channelId))
  throw new Error(
    `configured BUZZ_CHANNEL_ID is not in the discovered membership set: ${channelId}`,
  );
const mention = await client.receiveMention(channelId);
const reply = client.buildReply(
  channelId,
  mention,
  "Torana Phase 0 transport probe reply",
);
let publish: unknown = "skipped (set BUZZ_PHASE0_PUBLISH=1 to opt in)";
if (process.env.BUZZ_PHASE0_PUBLISH === "1") {
  const first = await client.publish(reply);
  const duplicate = await client.publish(reply);
  publish = { first, duplicate };
}
client.close();

const reconnect = await proveReconnectAndDedup({
  relayUrl,
  secret,
  ownerAuthTag,
  channelId,
});
process.stdout.write(
  `${JSON.stringify(
    {
      relayUrl,
      pubkey: client.pubkey,
      channelId,
      discoveredChannelCount: channels.length,
      mentionEventId: mention.id,
      replyEventId: reply.id,
      publish,
      reconnectDuplicateRejected: reconnect.duplicateRejected,
    },
    null,
    2,
  )}\n`,
);
