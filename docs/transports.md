# Transports: webhook vs polling

torana ships two transports out of the box. Either can be chosen globally via `transport.default_mode`, and per-bot via `transport_override.mode`.

## When to use what

| | Webhook | Polling |
|---|---|---|
| Needs public HTTPS | **Yes** | No |
| Latency | Lowest | ~25s long-poll |
| Ideal for | Production behind a TLS-terminating proxy | Dev, MacBook, firewalled environments |
| NAT/firewall friendly | No | Yes |
| Scales with bot count | Linear on webhook calls | Linear on poll loops |

## Webhook setup

Your `transport.webhook.base_url` must be reachable from Telegram's servers (public HTTPS with a valid cert). torana calls `setWebhook` for each bot at startup and handles `POST /webhook/:botId`.

```yaml
transport:
  default_mode: webhook
  webhook:
    base_url: https://bots.example.com
    secret: ${TELEGRAM_WEBHOOK_SECRET}   # random long string
    allowed_updates: [message]
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
    timeout_secs: 25        # long-poll window
    backoff_base_ms: 1000
    backoff_cap_ms: 30000
    max_updates_per_batch: 100
```

## Dev vs prod bot tokens

**Telegram delivers each update to exactly one consumer.** Running a dev gateway on your laptop *and* a prod gateway on a server with the **same token** will race — whichever polls/webhooks first gets the update; the other sees nothing.

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
