# Buzz CLI upgrade runbook

Use this procedure whenever Buzz Desktop offers a release newer than Torana's
pinned CLI. A Desktop update changes the local executable when `buzz` is a
symlink into `Buzz.app`; it does not change a deployed Torana image. Conversely,
rebuilding a Linux image does not update the Desktop app. Treat these as four
separate version surfaces:

1. the Desktop app and its bundled local CLI;
2. Torana's recorded source tag, commit, binary hash, and command manifest;
3. Torana's broker and installed `torana-buzz` skills; and
4. each downstream deployment image's independently built CLI and exact Torana
   package version.

Do not rotate identity keys or owner auth tags for an ordinary application
upgrade. Never print, copy into arguments, or commit either secret.

## 1. Establish release provenance

Read the official Block Buzz release and compare it with the current tag. Record
the tag, resolved commit, platform asset ID, asset size, and published SHA-256.
Do not use a floating branch or an unverified mirror.

On Apple Silicon after installing the update:

```sh
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  /Applications/Buzz.app/Contents/Info.plist
shasum -a 256 /Applications/Buzz.app/Contents/MacOS/buzz
codesign -dv --verbose=4 /Applications/Buzz.app 2>&1 \
  | rg 'Identifier=|TeamIdentifier=|CDHash='
```

Update `spike/buzz-transport/artifact-provenance.json`, then run
`bun run provenance:check`. That check downloads the recorded official archive,
verifies its digest, extracts its bundled CLI, verifies the CLI digest, and
requires the installed executable to be byte-for-byte identical when present.

## 2. Regenerate and review the command surface

Generate a candidate manifest before replacing the tracked one:

```sh
cd spike/buzz-transport
bun run manifest > /tmp/buzz-cli-manifest.json
diff -u cli-manifest.json /tmp/buzz-cli-manifest.json
```

Review every added, removed, renamed, or newly nested command. Classify reads in
`READ_ONLY_VERBS`, ordinary collaboration writes in `COLLABORATE_ADDITIONS`,
maintenance writes in `MAINTAINER_ADDITIONS`, and irreversible or
administrative actions in `DANGEROUS_BUZZ_COMMANDS`. Dangerous commands must
remain custom-only and require `acknowledge_dangerous: true`. Do not accept the
manifest merely because it was mechanically generated.

After review, replace `spike/buzz-transport/cli-manifest.json` with the candidate
and update:

- `BUZZ_CLI_PIN` in `src/broker/buzz-policy.ts`;
- the default hash and normalized default in `src/config/v2.ts`;
- policy tests, configuration docs, examples, both byte-identical skill copies,
  Phase 0 provenance evidence, changelog, and package version; and
- any current-version references found with `rg` (preserve clearly historical
  rollout evidence rather than rewriting history).

## 3. Verify and release Torana

Run the complete local gate with the updated Desktop CLI on `PATH`:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun test --timeout 15000
bun run build
bun run scripts/verify-pack.ts
bun run scripts/check-skill-parity.ts
cd spike/buzz-transport
bun test
bun run typecheck
bun run manifest:check
bun run provenance:check
git diff --check
```

Review the final diff and publish a new exact Torana version through the trusted
release workflow. Confirm the npm `rc` dist-tag resolves to that version and
install the registry tarball in a disposable directory before changing a
deployment consumer.

## 4. Update a downstream image atomically

In the deployment repository, change the Buzz source tag and resolved commit in
the dedicated CLI build stage. Build `buzz-cli` with the release's committed
`Cargo.lock`; calculate its Linux binary hash inside the image. In the same
change, pin the compatible Torana package version. Never combine a new CLI with
an older broker manifest or a new broker manifest with an older CLI.

Run repository tests, build the full image, and verify inside it:

```sh
torana version
sha256sum /usr/local/bin/buzz
cat /usr/local/share/torana/buzz-cli.sha256
torana validate --config /app/deploy/torana-config/torana.yaml
torana doctor --config /app/deploy/torana-config/torana.yaml
```

The two CLI hashes must match and doctor C024 must name the intended Buzz
version, broker manifest schema, and skill protocol.

## 5. Deploy and observe

Deploy first with the existing database schema and endpoint configuration; a
CLI-only upgrade does not authorize a migration, credential rotation, or
endpoint ownership change. Require:

- every supervisor process running;
- public and internal health checks passing;
- every enabled Buzz endpoint authenticated, connected, and subscribed;
- zero queued/running turns and zero pending/dead Buzz outbox rows;
- the non-publishing publisher probe passing when publishers are configured;
- one real owner DM or mention producing exactly one acknowledgement and one
  reply; and
- one publisher canary producing one visible event with idempotent replay.

Observe reconnect and authentication logs long enough to catch heartbeat or
membership failures. A deployment marked successful is not sufficient evidence.

## 6. Roll back safely

If the image fails before accepting new work, redeploy the prior exact
Torana-and-Buzz pair. If work was accepted, drain endpoints and reconcile
publisher/outbox state before rollback; never blindly resend an ambiguous
publication. A CLI-only release with no database migration can use a binary-only
rollback, but the CLI and Torana broker manifest must always roll back together.

Record the final Torana version, Buzz tag/commit, archive and binary hashes,
deployment ID, doctor result, canary event/turn evidence, and observation window
in the deployment runbook or release-readiness evidence.
