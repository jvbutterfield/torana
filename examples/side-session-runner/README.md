# side-session-runner

A minimal command runner (`~60 lines Bun`) that speaks torana's
`claude-ndjson` protocol and demonstrates Phase 2c side-session
capabilities.

## What this shows

Torana's `CommandRunner` spawns a dedicated long-lived subprocess per
agent-API `session_id` when the configured protocol is `claude-ndjson` or
`codex-jsonl` (Phase 2c). Each side subprocess receives
`TORANA_SESSION_ID=<id>` in its environment; the main subprocess — the one
handling ordinary Telegram traffic — does not have this variable set.

`session-runner.ts` reads `TORANA_SESSION_ID` and stamps the session label
onto each response, so you can see which subprocess a reply came from.

## Running

```
cd examples/side-session-runner

# Required env:
#   MY_TELEGRAM_USER_ID=<your id>
#   TELEGRAM_BOT_TOKEN=<bot token>
#   AGENT_API_TOKEN=<any long-enough secret>
bun ../../src/main.ts serve ./torana.yaml
```

A Telegram message goes through the _main_ subprocess:

```
user: hi
bot:  [main#1] echo: hi
```

An agent-API `ask` call with `session_id: "demo"` hits a _side-session_
subprocess — separate process, separate turn counter, separate state:

```
$ curl -X POST http://localhost:3000/v1/bots/echo/ask \
    -H "authorization: Bearer $AGENT_API_TOKEN" \
    -H "content-type: application/json" \
    -d '{"text": "hello", "session_id": "demo"}'
{
  "ok": true,
  "text": "[demo#1] echo: hello",
  ...
}
```

## Protocol compatibility

| protocol        | side sessions?                              |
| --------------- | ------------------------------------------- |
| `claude-ndjson` | yes                                         |
| `codex-jsonl`   | yes                                         |
| `jsonl-text`    | no (doctor C011 will flag ask-scope tokens) |

If you try to give an `ask`-scope agent-API token to a `jsonl-text`
command runner, `torana doctor` fails C011. Switch the protocol to
`claude-ndjson` (or `codex-jsonl`) — the envelope shape changes, so the
wrapper needs to emit the events the chosen parser expects.
