# Conversation sessions

Config v2 gives every platform conversation a durable session key. The key
includes platform, community, endpoint, channel, thread root when applicable,
and workflow run, then is hashed before it reaches a provider. Identical
channel-looking values on Telegram and Buzz therefore cannot share context by
accident.

`sessions.scope` policies are:

- `conversation` (also accepted as `channel`): one context per conversation.
- `thread`: one context per thread or Buzz forum root.
- `ephemeral`: a fresh context for every turn.
- `legacy_agent`: v1 compatibility, one context for the whole agent.
- `alias:<name>`: explicit same-agent sharing declared in `sessions.aliases`.

The shared session manager enforces per-agent, global, per-token, and active
turn caps. A conversation mailbox is serial; different sessions can run up to
the configured global and per-agent limits. Queue depth is bounded separately
per conversation and agent. Provider resume state is persisted and restored
lazily after restart; context retention is independent from process idle and
hard TTLs.

Use `torana conversations list` and `torana sessions list` to inspect bindings.
Resetting a session shared by aliases requires `--confirm-shared`. `!rotate`
starts a fresh generation without silently joining unrelated conversations;
`!cancel` affects only the resolved session's active turn.
