# codex-bot

End-to-end example running torana with the OpenAI Codex CLI as the agent runtime.

## Prereqs

```sh
# 1. Install the Codex CLI.
npm install -g @openai/codex

# 2. Authenticate ONE of two ways:
#    a) OAuth (browser flow):
codex login
#    b) API key (set in env, referenced by torana.yaml):
export OPENAI_API_KEY=sk-...

# 3. Telegram setup.
export TELEGRAM_BOT_TOKEN=123456:ABCDEF...
export MY_TELEGRAM_USER_ID=111222333
```

## Run it

```sh
# From this directory:
torana doctor --config ./torana.yaml
torana start  --config ./torana.yaml
```

Send the bot a message in Telegram. Codex spawns per-turn (`codex exec --json …`),
parses the JSONL events, and surfaces the assistant's reply as a single edited
message. `/reset` clears the captured `thread_id` so the next message starts a
fresh Codex session. `/status` reports runner readiness and mailbox depth.

## Things to know

- **No token-level streaming.** Codex emits state-change events, not deltas, so
  you'll see one message edit per turn (at completion) rather than the
  word-by-word streaming you get from `claude-code`. This is documented and
  intentional.
- **Image attachments only.** Photos forwarded to the bot work; documents/PDFs
  are skipped with a warning (Codex's `--image` flag accepts only images).
- **Per-bot session isolation.** If you run multiple Codex bots from the same
  gateway, point each at a distinct `CODEX_HOME` (or rely on the per-bot
  `cwd`) so OAuth/session state doesn't collide.

## Hybrid: mix Codex and Claude Code in one gateway

Add another `bots[]` entry with `runner.type: claude-code` (or `command`). The
dispatcher routes each Telegram update to its bot's runner independently —
no special configuration required. See [`docs/runners.md`](../../docs/runners.md#hybrid-configurations).
