# Agent-team production template

This template shows three isolated personas with one Telegram and one Buzz
endpoint each. Replace the names and workspaces with your actual team. It
contains no credential values.

The template pins the Buzz CLI binary from Block Buzz `desktop-v0.5.4` by its
verified executable SHA-256. Pin the Torana package or container by exact
`2.0.0` version and image digest only after the release gates in
`docs/release-readiness.md` are complete; do not deploy a floating tag.

Rollout is deliberately two-level:

1. Deploy and run `torana doctor` with `platforms.buzz.enabled: false`.
2. The `operator-buzz` endpoint is already the sole endpoint marked enabled.
   Turn on the master switch to start only that canary.
3. Observe health, reconnects, queues, signed outbox delivery, and session
   isolation through the canary window.
4. Enable the remaining Buzz endpoints one at a time. Triggers remain off by
   default.

Keep every private key and auth tag in the deployment secret store. Each Buzz
endpoint requires its own private key and matching owner tag. Never copy the
contents of a local `.env` file into this YAML.
