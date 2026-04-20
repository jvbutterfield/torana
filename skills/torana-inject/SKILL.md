---
name: torana-inject
description: |
  Use when an external event (calendar trigger, monitoring alert, upstream
  agent) needs to be reported to the Telegram user, AND the receiving bot
  must see the material so it can answer follow-up questions. Trigger
  phrases: "send prep to", "notify <bot> about", "push to <user>'s chat".
allow_implicit_invocation: true
---

# torana-inject

Push a system-injected message into a user's bot chat. Torana delivers the
text (and any attachments) via Telegram **and** records it in the bot's
turn history so follow-up user messages have full context.

## When to use

- You're an upstream agent that wants to surface information to a user
  through a specific bot: standup summaries, calendar prep, monitoring
  alerts, status updates.
- The user may reply — the injected material must be visible to the bot
  so it can answer coherently.
- One-way notifications where replies matter. For fire-and-forget with no
  context retention, use a plain Telegram sendMessage integration.

## When NOT to use

- You want another agent's **opinion** (Q&A only, not delivered to a
  user). Use `torana-ask`.
- The user hasn't started a conversation with the bot yet. torana refuses
  injects until the chat is open (error code `user_not_opened_bot`).

## Quick reference

```bash
torana inject --source <label> --user-id <id> <bot_id> "<text>"
torana inject --source <label> --chat-id <id> <bot_id> "<text>"
torana inject --source <label> --user-id 12345 --file ./report.pdf reviewer "weekly report"
```

## Prerequisites

- Same as `torana-ask` — `torana` on PATH, creds via env or profile.
- The target user must have opened the bot at least once.
- `--source` is **required** and must match `[a-z0-9_-]{1,64}` (it shows
  up in the marker prefix the bot sees: `[system-injected from "<source>"]`).
- Pick `--user-id` **or** `--chat-id`, never both. `--user-id` resolves
  to the (user, bot) chat.

## Common patterns

### 1. Push a status update

```bash
torana inject --source ops-standup --user-id 12345 reviewer \
  "All CI green. Ship it."
```

### 2. Inject with an attachment

```bash
torana inject --source calendar --user-id 12345 \
  --file ./morning-brief.pdf scheduler "Your 9am prep."
```

### 3. Pipe a freshly-generated file

```bash
pg_dump --schema-only db | \
  torana inject --source ops-audit --user-id 12345 \
  --file @- dba "Today's schema snapshot."
```

### 4. Idempotent retry

Omit `--idempotency-key` — torana auto-generates one and prints it to
stderr as `# auto-generated idempotency-key: <uuid>`. Grep that line and
reuse the same key when retrying; the server replays the first outcome
rather than double-delivering.

## Marker convention

The bot sees the injected text wrapped as:

```
[system-injected from "<source>"]
<the text you sent>
[/system-injected]
```

When responding to the user, do NOT repeat the marker text back — treat
it as private context. Reply in-character, referencing the facts inside
the marker block without quoting it verbatim.

## Error handling

Exit codes:

| Code | Meaning |
|---:|---|
| 0 | Queued — `turn_id` on stdout. Poll with `torana turns get`. |
| 2 | Bad usage (missing flag, bad source label). **Do not retry.** |
| 3 | Auth or authz failed (token, bot, chat, user). **Do not retry.** |
| 4 | Not found (bot). **Do not retry.** |
| 5 | Server error. Retry with backoff + same idempotency key. |
| 7 | Capacity / busy. Retry after 1–10 s. |

## Security

- Never echo `TORANA_TOKEN` into the injected text.
- Don't inject untrusted content verbatim — torana does not sanitize
  markdown in the payload, and the marker prefix is user-visible.

## Codex-specific callout

The first time Codex runs `torana inject` under the default
`workspace-write` + `on-request` sandbox, you'll see an approval prompt.
Approve it once and subsequent calls run without prompting in the same
session. For zero prompts:

```toml
# ~/.codex/config.toml — auto-approve torana commands
[commands."torana"]
approval_mode = "never"
```
