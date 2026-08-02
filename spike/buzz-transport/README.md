# Buzz transport Phase 0 spike

This throwaway client exercises the protocol boundary without changing Torana's production path. It uses the exact `nostr-tools` version pinned in `package.json` and implements only the Buzz behavior required by the implementation plan.

## Reproduce locally

```sh
cd spike/buzz-transport
bun install --frozen-lockfile
bun test
bun run typecheck
bun run manifest:check
bun run provenance:check
```

The test relay covers NIP-42 authentication, strict owner-auth-tag injection, membership discovery, `#h`-scoped mention intake, threaded replies, reconnect overlap, signature verification, exact-event replay, and relay deduplication.

## Optional hosted-relay probe

The live probe is read-only unless publishing is explicitly enabled:

```sh
BUZZ_RELAY_URL=wss://relay.example \
BUZZ_PRIVATE_KEY=nsec1... \
BUZZ_AUTH_TAG='["auth",...]' \
BUZZ_CHANNEL_ID=optional-channel-uuid \
bun run live.ts
```

Set `BUZZ_PHASE0_PUBLISH=1` only with a disposable test channel. The probe then publishes the exact same signed reply twice and records both `OK` responses.

For an empty disposable channel, use `hosted-live.ts`. It publishes one
top-level probe, replays the exact signed event, reads it back, reconnects, and
verifies local event-ID deduplication:

```sh
BUZZ_RELAY_URL=wss://relay.example \
BUZZ_PRIVATE_KEY=nsec1... \
BUZZ_AUTH_TAG='["auth",...]' \
BUZZ_CHANNEL_ID=disposable-channel-uuid \
BUZZ_PHASE0_PUBLISH=1 \
bun run hosted-live.ts
```

## Authenticated capacity probe

`measure-authenticated-capacity.ts` runs minimal real provider turns at 1, 2,
8, and 32 concurrent invocations and samples the complete local subprocess tree
for peak RSS, process count, and file descriptors:

```sh
bun run capacity:authenticated
```

Use `CAPACITY_COUNTS=1,2` or `CAPACITY_RUNNERS=claude` for a smaller validation
run. The captured Phase 0 result is in `capacity-authenticated.json`; it combines
these peaks with the production deployment's measured gateway baseline and
authoritative memory ceiling. The exact installed CLI-to-release mapping is in
`artifact-provenance.json`.

`provenance:check` downloads the pinned official release asset, verifies its
published archive checksum and bundled CLI checksum, and also compares the local
installed executable when that path exists. It therefore works in CI without an
installed Buzz app while providing the stronger byte-for-byte check on the
Phase 0 workstation.
