# Buzz platform

Each Buzz endpoint is a distinct Nostr identity connected to a configured
relay. The Block hosted relay requires the community relay URL, endpoint
private key, owner public key, and matching owner-signed auth tag supplied by
the operator. Store them in runtime secrets; quote auth-tag interpolation in
YAML because the value is serialized JSON.

```yaml
platforms:
  buzz:
    enabled: false

agents:
  - id: reviewer
    endpoints:
      - id: reviewer-buzz
        platform: buzz
        enabled: false
        community_id: primary
        relay_url: ${BUZZ_RELAY_URL}
        private_key: "${BUZZ_PRIVATE_KEY_REVIEWER}"
        auth_tag: "${BUZZ_AUTH_TAG_REVIEWER}"
        owner_pubkey: "${BUZZ_OWNER_PUBKEY}"
        respond_to: owner_only
        subscribe: mentions_and_dms
```

Both switches must be true before an endpoint connects. On connection Torana
authenticates, discovers accessible channels, replays from its composite
cursor, and starts live event plus membership subscriptions. Invalid
signatures, unexpected authors, missing exact mentions, unauthorized event
kinds, and removed membership fail closed before runner dispatch.

Messages, edits, deletes, reactions, forum operations, and votes are signed
before durable delivery. An uncertain or operator-requested replay republishes
the exact stored event ID; it never re-signs. Typing and presence are
rate-limited best effort signals and are not replayed.

Stream channels default to one session per channel. Forum roots default to one
session per root. DMs, streams, forums, workflows, and Telegram remain isolated
unless the operator declares a same-agent alias. Trace tags help cooperative
loop diagnosis, while local per-conversation and per-endpoint reply limits are
the security backstop.

Attachments accept only signed, same-origin relay media URLs under `/media/`.
Redirects, foreign origins, compressed responses, oversize bodies, hash
mismatches, and MIME spoofing are rejected. Outbound media is uploaded once;
its descriptor and signed event are persisted for exact retry.

Workspace actions use the endpoint-scoped broker described in
[security](../security.md). The normal runner environment contains no private
key or auth tag. See [operations](../operations.md) for rotation, replay,
draining, and canary rollout.
