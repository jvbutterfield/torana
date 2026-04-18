# echo-bot

Smoke-test for torana. Verifies end-to-end flow without touching Claude Code.

The runner is a ~20-line Bun script that echoes each incoming message back.

## Run it

```sh
# 1. Create a bot via @BotFather and grab the token.
export TELEGRAM_BOT_TOKEN=123456:ABCDEF...
export MY_TELEGRAM_USER_ID=111222333

# 2. From this directory:
torana doctor --config ./torana.yaml
torana start  --config ./torana.yaml

# 3. Message the bot. You should see "echo: <whatever you typed>" come back.
# 4. Send /reset to confirm the reset path works.
```

## What this proves

- Your Telegram bot token is valid
- Your ACL is correct (your user_id can message it)
- Polling transport is working (no webhook URL needed)
- The runner protocol (`jsonl-text`) is working
- Slash commands dispatch (`/reset`)

Once this works, swap the runner block for the real `claude-code` runner.
