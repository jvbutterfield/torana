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

The Rust CLI golden test runs when `buzz` is installed on `PATH` and is skipped
on generic CI runners. The protocol and cryptographic tests remain mandatory;
`provenance:check` verifies the pinned release artifact without requiring an
installed Buzz app.

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

`hosted-media-live.ts` completes the Phase 8 hosted-relay gate. It uploads a
small PNG and PDF, publishes their native `imeta` descriptors, retries the exact
same signed event, downloads both files with signed Blossom authorization,
and verifies their sizes, MIME types, and hashes. It removes its local temporary
files but leaves the published probe and its content-addressed blobs referenced:

```sh
BUZZ_RELAY_URL=wss://relay.example \
BUZZ_PRIVATE_KEY=nsec1... \
BUZZ_AUTH_TAG='["auth",...]' \
BUZZ_CHANNEL_ID=disposable-channel-uuid \
BUZZ_PHASE8_PUBLISH=1 \
bun run hosted-media-live.ts
```

## Authenticated capacity probe

`measure-authenticated-capacity.ts` runs minimal real provider turns at 1, 2,
8, and 32 concurrent invocations and samples the complete local subprocess tree
for peak RSS, process count, and file descriptors:

```sh
bun run capacity:authenticated
```

Use `CAPACITY_COUNTS=1,2` or `CAPACITY_RUNNERS=claude` for a smaller validation
run. The captured Phase 0 result is in `capacity-authenticated.json`, along with
the formula for turning these peaks into session caps. Combine it with your own
deployment's memory ceiling and observed gateway baseline — the shipped defaults
were sized for a specific deployment and are not a universal recommendation. The
exact installed CLI-to-release mapping is in `artifact-provenance.json`.

`provenance:check` downloads the pinned official release asset, verifies its
published archive checksum and bundled CLI checksum, and also compares the local
installed executable when that path exists. It therefore works in CI without an
installed Buzz app while providing the stronger byte-for-byte check on the
Phase 0 workstation.
