# Contributing

Thanks for helping make torana better.

## Dev setup

- Bun ≥ 1.3.
- `bun install`
- `bun test`
- `bun run typecheck`

## Running the gateway locally against a real bot

1. Create a dev bot via `@BotFather` (don't use your production token).
2. Put secrets in an un-committed `.env.local` file:
   ```
   TELEGRAM_BOT_TOKEN=123:ABC...
   MY_TELEGRAM_USER_ID=111222333
   ```
3. `source .env.local && bun run src/cli.ts start --config examples/echo-bot/torana.yaml`

## Iterating on the gateway while consuming it from another project (`npm link`)

```sh
# in your torana checkout
bun install
npm link

# in the consumer project
npm link torana
```

Code changes in the torana checkout are picked up on the next restart of the consumer.

## Project structure

See `src/` for the modular layout (`config/`, `transport/`, `runner/`, `core/`, `db/`). Tests live next to the code they exercise under `test/`.

## PR rules

- One topic per PR.
- Keep diffs small enough that a reviewer can hold them in their head.
- Config schema changes always come with a docs update (`docs/configuration.md`).
- Transport/protocol changes always come with a docs update (`docs/transports.md` or `docs/runners.md`).
- New behavior gets a test. Regressions get a test.
- CI must be green.

## Commit style

Short imperative subject line, body for the why. No strict format.

## Releases

Cut by the maintainer using Changesets:

```sh
bunx changeset           # describe the change
bunx changeset version   # bumps package.json + CHANGELOG
git push --follow-tags
```

The `release.yml` workflow publishes to npm with `--provenance`.

## No lifecycle scripts

torana publishes **no** `preinstall`/`postinstall`/`prepare` scripts. CI enforces this. Don't add one without discussing first — it's a supply-chain attack vector.
