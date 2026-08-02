# Transports: Telegram and Buzz

Torana ships Telegram webhook/polling transports and an authenticated Buzz
WebSocket transport. `transport.default_mode` and `transport_override.mode`
apply only to Telegram.

## Buzz WebSocket

Buzz endpoints authenticate to the configured relay, discover accessible
channels, replay from a durable cursor, then maintain live channel and
membership subscriptions. Outbound messages, edits, deletes, and reactions
are signed before entering the durable outbox, so an uncertain retry republishes
the same event ID. Typing and presence bypass the outbox and are dropped on
failure; reconnect publishes a fresh online presence event.

Use a unique endpoint private key and set `platforms.buzz.enabled: true` plus
`agents[].endpoints[].enabled: true`. Run `torana doctor` before production to
verify the relay, owner identity, attestation, discovery, and publish policy.

The Block relay defaults to a 512 KiB WebSocket frame while Buzz message/edit
content is capped separately. Torana defaults to `max_frame_bytes: 524288` and
`message_max_bytes: 65536`, and byte-splits continuations without cutting UTF-8
characters.

Forum posts, comments, and votes use Buzz-native event kinds. Each forum root
has its own durable session, and nested comments route back to that root. Feed
mentions, needs-action events, workflow notifications, and scheduled heartbeat
prompts are disabled unless enabled under the endpoint's `triggers` settings.
Heartbeat prompts run only when the agent has no queued or running human work;
workflow prompts cannot grant or deny approvals implicitly.

## Telegram: when to use webhook or polling

## When to use what

|                       | Webhook                                   | Polling                               |
| --------------------- | ----------------------------------------- | ------------------------------------- |
| Needs public HTTPS    | **Yes**                                   | No                                    |
| Latency               | Lowest                                    | ~25s long-poll                        |
| Ideal for             | Production behind a TLS-terminating proxy | Dev, MacBook, firewalled environments |
| NAT/firewall friendly | No                                        | Yes                                   |
| Scales with bot count | Linear on webhook calls                   | Linear on poll loops                  |

## Webhook setup

Your `transport.webhook.base_url` must be reachable from Telegram's servers (public HTTPS with a valid cert). torana calls `setWebhook` for each bot at startup and handles `POST /webhook/:botId`.

```yaml
transport:
  default_mode: webhook
  allowed_updates: [message] # applies to both webhook and polling
  webhook:
    base_url: https://bots.example.com
    secret: ${TELEGRAM_WEBHOOK_SECRET} # random long string
```

**Secret rotation (zero-downtime):**

1. Update `TELEGRAM_WEBHOOK_SECRET` in your secret store.
2. Restart the gateway — it re-registers webhooks with the new secret.
3. The old secret stops working as soon as Telegram's delivery pipeline catches up.

**Stale webhook URLs:** if `getWebhookInfo` reports a URL that differs from what you're about to register, torana logs a warning and overwrites. This catches accidental collisions with other deployments sharing the same token.

## Polling setup

No public URL needed — outbound only. torana calls `deleteWebhook` at startup, then loops `getUpdates(offset, timeout=25)`. Offset is persisted to `bot_state.last_update_id` so restarts don't replay.

```yaml
transport:
  default_mode: polling
  polling:
    timeout_secs: 25 # long-poll window
    backoff_base_ms: 1000
    backoff_cap_ms: 30000
    max_updates_per_batch: 100
```

## Dev vs prod bot tokens

**Telegram delivers each update to exactly one consumer.** Running a dev gateway on your laptop _and_ a prod gateway on a server with the **same token** will race — whichever polls/webhooks first gets the update; the other sees nothing.

Solution: create a separate bot via `@BotFather` for dev:

1. `/newbot` in a chat with `@BotFather`.
2. Give it a dev name (e.g. `cato-dev-bot`).
3. Copy the token into your local `.env`.

Your prod YAML references `${TELEGRAM_BOT_TOKEN_CATO}`; your dev YAML references `${TELEGRAM_BOT_TOKEN_CATO_DEV}`. Same config shape, different token.

## Mixed mode

You can have one bot on webhook and another on polling in the same process:

```yaml
transport:
  default_mode: webhook
  webhook: { base_url: ..., secret: ... }

bots:
  - id: prod
    token: ${PROD_TOKEN}
    # inherits webhook
  - id: dev-experiment
    token: ${DEV_TOKEN}
    transport_override:
      mode: polling
```

## Mode switch on restart (polling → webhook)

Changing a bot's transport from polling to webhook **drops any updates Telegram had buffered for polling** (documented Telegram behavior of `setWebhook`). Log-level `info` — treated as an expected operator action.

If lossless switching matters, drain polling manually first: stop the gateway, call `getUpdates` with a high offset via curl, then reconfigure.
