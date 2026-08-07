# Buzz platform

Each Buzz endpoint is a distinct Nostr identity connected to a configured
relay. The Block hosted relay requires the community relay URL, endpoint
private key, owner public key, and matching owner-signed auth tag supplied by
the operator. Store them in runtime secrets; quote auth-tag interpolation in
YAML because the value is serialized JSON.

## Getting Buzz credentials

Four values per endpoint. Two you generate, one you already have, one your
community gives you.

**1. The relay URL** (`relay_url`) comes from your community. For the Block
hosted relay it is the `wss://…` endpoint issued for that community.

**2. The endpoint identity** (`private_key`) is a fresh Nostr keypair — one per
endpoint, never shared between them:

```sh
torana buzz keygen
```

That prints a `private_key`, its derived `public_key`, and the `nsec`/`npub`
forms. It writes nothing to disk. Put the secret straight into your secret
manager; you will not be shown it again.

**3. The owner identity** (`owner_pubkey`) is the human or team account that
vouches for the endpoint — normally the identity you already use in Buzz
Desktop. You need its _public_ key for the config, and its _secret_ key once,
to sign step 4.

**4. The owner attestation** (`auth_tag`) is a NIP-OA tag: the owner signing
"this endpoint identity may act on my behalf, under these conditions." Mint it
with the endpoint's public key from step 2:

```sh
export BUZZ_OWNER_PRIVATE_KEY='nsec1…'      # or 64-hex
torana buzz auth-tag --agent-pubkey <endpoint-public-key>
```

The owner secret is read from the environment rather than a flag, so it stays
out of `argv` and shell history. The default condition is `kind=9` — ordinary
messages — which is what a conversational endpoint needs; pass `--conditions`
to widen or narrow it. Both commands take `--format json` for scripting.

Wire the four values in as environment references:

```yaml
relay_url: ${BUZZ_RELAY_URL}
private_key: "${BUZZ_PRIVATE_KEY_REVIEWER}" # step 2
auth_tag: "${BUZZ_AUTH_TAG_REVIEWER}" # step 4 — quote it, it is JSON
owner_pubkey: "${BUZZ_OWNER_PUBKEY}" # step 3
```

Then check it before starting anything:

```sh
torana validate --config torana.yaml
```

Torana derives the public key from `private_key` and refuses to start unless it
matches what the auth tag attests, so a mismatched pair fails at config load
rather than at the relay. `403 relay_membership_required` at connect time means
the identity reached the relay but its attestation was missing, wrong, or
didn't permit the event kind.

Rotation is the same four steps with a new keypair; see
[operations](../operations.md#buzz-key-and-auth-rotation).

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
the exact stored event ID; it never re-signs. Typing and conversation-driven
presence are rate-limited best-effort signals and are not replayed.

The endpoint's owner can stop it from Buzz Desktop: a stream message whose
trimmed content is exactly `!shutdown` and which mentions the endpoint, signed
by `owner_pubkey`, drains in-flight turns, publishes presence `offline`, and
disables the endpoint durably. Nobody else can, on any `respond_to` setting,
and a message that merely contains `!shutdown` is an ordinary prompt. Opt out
with `owner_shutdown: disabled`.

The endpoint stays down across restarts, but a provider deploy revives it —
including the automatic redeploy Buzz Desktop 0.5.6 performs when it loads
community UI, which Torana cannot distinguish from an owner pressing "Start".
See [operations](../operations.md#owner-shutdown-remote-agent-stop).

The supervisor's own presence heartbeat is not best-effort in the same sense:
it is the only thing a Buzz client reads to decide whether the agent is online,
and the relay expires presence 180 s after the last accepted publish. That
refresh is therefore exempt from `limits.presence_min_interval_ms`, and a run
of failed refreshes marks the endpoint unhealthy with `presence_stale` before
the TTL can lapse. See
[configuration](../configuration.md#presence-heartbeats-and-the-relays-ttl).

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
key or auth tag. Conversation turns receive a session-scoped capability
automatically; Agent API `ask` turns receive one only when their token sets
`buzz_tools: true` (see [agent-api](../agent-api.md)). See [operations](../operations.md) for rotation, replay,
draining, and canary rollout.
