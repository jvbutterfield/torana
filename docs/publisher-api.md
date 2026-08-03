# Outbound publishers

Torana config v2 supports outbound-only service principals under `publishers`.
They are separate from `agents`: a publisher has no runner, commands, inbound
message subscription, scheduler slot, or conversation session.

```yaml
publishers:
  - id: dev-team
    enabled: false
    endpoint:
      id: dev-team-buzz
      platform: buzz
      community_id: primary
      relay_url: ${BUZZ_RELAY_URL}
      private_key: ${BUZZ_PRIVATE_KEY_DEV_TEAM}
      auth_tag: ${BUZZ_AUTH_TAG_DEV_TEAM}
      owner_pubkey: ${BUZZ_OWNER_PUBKEY}
      expected_pubkey: 4d66facf35826891790efa742e0e915a906fed1d39e860e8c8ff9c8001ef6911
    destination:
      external_conversation_id: 4109b9b8-c553-4d29-98f5-403d8419ac18

publisher_api:
  enabled: true
  max_body_bytes: 73728
  max_content_bytes: 65536
  idempotency_retention_ms: 1209600000
  max_pending_per_publisher: 500
  max_retained_per_publisher: 2000
  max_retained_bytes_per_publisher: 268435456
  rate_per_minute_per_publisher: 60
  burst_per_publisher: 10
  tokens:
    - name: dev-team-notifier
      secret_ref: ${TORANA_PUBLISH_TOKEN_DEV_TEAM}
      publisher_ids: [dev-team]
      scopes: [publish, status]
```

Configuration validation derives the Buzz public key and compares it to
`expected_pubkey`, verifies the owner authorization tag for message kind 9,
and rejects unknown publisher fields. Live destination membership is checked
by the outbound-only relay supervisor before a new publication is accepted.

Before enabling a publisher, probe its disabled endpoint without opening
publish intake:

```sh
torana doctor --config /path/to/torana.yaml --publisher-probe dev-team
```

The probe transiently authenticates with the configured publisher identity,
requires the exact configured destination in live channel membership, and
then disconnects. Config loading verifies the full derived public-key pin and
owner authorization first. The probe never publishes a message.

## HTTP contract

`POST /v1/publishers/:publisher_id/messages` requires a publisher bearer and
an `Idempotency-Key` matching `[A-Za-z0-9_-]{16,128}`. The strict JSON body is:

```json
{ "content": "Build complete", "source": "worker-terminal", "severity": "info" }
```

Torana responds `202` only after the signed Buzz event, outbox row, and
publication record commit atomically. Reusing the same key and canonical body
returns the same identifiers with `replayed: true`; changed content returns
`409 idempotency_conflict`.

`POST /v1/publishers/:publisher_id/messages/status` accepts
`{"idempotency_key":"..."}`. The response contains identifiers, bounded
status, safe error class, and timestamps. It never contains message content or
signed event bytes.

## CLI

Message content is never accepted as a positional command argument:

```sh
printf '%s' 'Build complete' | torana publish dev-team \
  --server http://127.0.0.1:3000 \
  --source worker-terminal \
  --severity info \
  --idempotency-key build-terminal-0001

torana publish status dev-team \
  --server http://127.0.0.1:3000 \
  --idempotency-key build-terminal-0001
```

Set `TORANA_PUBLISH_TOKEN_FILE` to a root-controlled secret file (preferred)
or `TORANA_PUBLISH_TOKEN` in the dispatcher environment. There is deliberately
no raw token flag. Keep these routes on the loopback listener or an internal
network boundary; do not expose them through the public gateway proxy.

Stable command exits are `0` success, `2` usage/validation, `3` auth, `4` not
found, `5` server/unavailable, and `7` rate/capacity.
