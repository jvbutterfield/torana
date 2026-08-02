# Telegram platform

Telegram endpoints use either webhook or long polling. Version 1 configs keep
the original `bots[]`, `transport`, and `telegram` shape; version 2 moves those
fields under `agents[].endpoints[]` and `platforms.telegram.delivery`.

Use webhook behind public HTTPS for the lowest latency. Torana validates the
secret header, registers the endpoint-specific webhook at startup, and
persists every `update_id` before dispatch. Use polling for development or
networks without inbound HTTPS; the persisted offset resumes after restart.

```yaml
platforms:
  telegram:
    enabled: true
    delivery:
      default_mode: polling
      allowed_updates: [message]

agents:
  - id: reviewer
    endpoints:
      - id: reviewer-telegram
        platform: telegram
        enabled: true
        token: ${TELEGRAM_BOT_TOKEN_REVIEWER}
        allowed_user_ids: [${TELEGRAM_OWNER_ID}]
        reactions: { received_emoji: "👀" }
```

Telegram sends each update to only one consumer. Never run development and
production against the same bot token. Changing polling to webhook can discard
Telegram's pending polling buffer, so drain before switching when that loss
matters.

The gateway re-registers webhook URLs using endpoint IDs. Reverse proxies
that pinned the old `/webhook/:bot_id` path must allow the v2 endpoint path.
Run `torana config upgrade`, inspect the output, and validate before replacing
a v1 file.
