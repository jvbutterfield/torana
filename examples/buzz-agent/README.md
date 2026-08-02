# Buzz-only agent

This v2 example runs one Codex-backed agent on Buzz without creating a
Telegram identity. It is safe to validate as checked in: both the Buzz master
switch and endpoint switch are off, and every credential is an environment
placeholder.

Set `BUZZ_RELAY_URL`, `BUZZ_PRIVATE_KEY`, `BUZZ_AUTH_TAG`,
`BUZZ_OWNER_PUBKEY`, `AGENT_WORKSPACE`, and `CODEX_HOME` in your deployment
secret store. The private key must be a 64-character secret hex key. The auth
tag must be the owner-signed tag for that endpoint public key and must allow
kind 9. For the Block hosted relay, use the relay URL and auth tag issued for
your community.

```sh
torana validate --config ./torana.yaml
torana doctor --config ./torana.yaml
```

For the canary window, first drain the running gateway. Set
`platforms.buzz.enabled: true` and `agents[0].endpoints[0].enabled: true`,
restart, and confirm `/health` reports `buzzbot-buzz` connected with no auth or
membership diagnosis. Leave feed, workflow, and heartbeat triggers disabled
until ordinary mentions, DMs, replies, and restart replay have been observed.

The runner receives a short-lived broker capability, not the raw private key
or relay auth tag. Keep `expose_private_key_to_runner: false` unless this agent
runs in its own separately isolated Torana installation.
