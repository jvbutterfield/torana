import { BuzzSpikeClient } from "./relay-client";
import {
  BUZZ_KINDS,
  EventDeduper,
  buildChannelMessage,
  channelFilter,
  decodeSecret,
  parseOwnerAuthTag,
} from "./protocol";

const relayUrl = process.env.BUZZ_RELAY_URL;
const privateKey = process.env.BUZZ_PRIVATE_KEY;
const channelId = process.env.BUZZ_CHANNEL_ID;

if (!relayUrl || !privateKey || !channelId) {
  throw new Error("Set BUZZ_RELAY_URL, BUZZ_PRIVATE_KEY, and BUZZ_CHANNEL_ID");
}
if (process.env.BUZZ_PHASE0_PUBLISH !== "1") {
  throw new Error("Set BUZZ_PHASE0_PUBLISH=1 for the disposable-channel probe");
}

const secret = decodeSecret(privateKey);
const ownerAuthTag = parseOwnerAuthTag(process.env.BUZZ_AUTH_TAG);
if (!ownerAuthTag) {
  throw new Error("BUZZ_AUTH_TAG is required by the hosted closed relay");
}

const createdAt = Math.floor(Date.now() / 1000);
const event = buildChannelMessage({
  channelId,
  content: `Torana Phase 0 hosted-relay probe ${new Date(createdAt * 1000).toISOString()} (safe to delete)`,
  secret,
  ownerAuthTag,
  createdAt,
});
const filter = channelFilter({
  channelId,
  kinds: [BUZZ_KINDS.streamMessageV1],
  since: createdAt - 1,
});

const firstClient = new BuzzSpikeClient(relayUrl, secret, ownerAuthTag);
await firstClient.connect();
const discoveredChannels = await firstClient.discoverChannels();
if (!discoveredChannels.includes(channelId)) {
  firstClient.close();
  throw new Error(
    "disposable channel is not in the authenticated membership set",
  );
}

const first = await firstClient.publish(event);
const duplicate = await firstClient.publish(event);
const intake = await firstClient.query([filter], `hosted-intake-${createdAt}`);
firstClient.close();

const stored = intake.find((candidate) => candidate.id === event.id);
if (!stored)
  throw new Error("published event was not returned by intake query");

const deduper = new EventDeduper();
if (!deduper.accept(stored))
  throw new Error("first intake was unexpectedly duplicate");

const secondClient = new BuzzSpikeClient(relayUrl, secret, ownerAuthTag);
await secondClient.connect();
const replay = await secondClient.query(
  [filter],
  `hosted-reconnect-${createdAt}`,
);
secondClient.close();

const replayed = replay.find((candidate) => candidate.id === event.id);
if (!replayed) throw new Error("reconnect did not replay the published event");
const reconnectDuplicateRejected = !deduper.accept(replayed);
if (!reconnectDuplicateRejected) {
  throw new Error("event-ID deduper accepted the reconnect replay");
}

process.stdout.write(
  `${JSON.stringify(
    {
      channelId,
      discoveredChannelCount: discoveredChannels.length,
      eventId: event.id,
      first,
      duplicate,
      intakeVerified: true,
      reconnectDuplicateRejected,
    },
    null,
    2,
  )}\n`,
);
