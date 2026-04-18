# Runners

A **runner** is the process that turns incoming messages into responses. torana talks to runners through a small abstraction (`AgentRunner` in `src/runner/types.ts`) that normalizes: start/stop lifecycle, turn submission, reset, and a discriminated `RunnerEvent` stream.

Two built-in runners ship with v1:

- **`claude-code`** — wraps the Claude Code CLI.
- **`command`** — wraps any subprocess that speaks a simple line protocol.

Pick one per bot in your YAML.

## claude-code

```yaml
bots:
  - id: cato
    token: ${TELEGRAM_BOT_TOKEN_CATO}
    runner:
      type: claude-code
      cli_path: claude
      args: ["--agent", "cato"]
      cwd: /data/content
      pass_continue_flag: true
      env:
        CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}
        CLAUDE_CONFIG_DIR: /data/state/claude-config/cato
```

### What `pass_continue_flag` does

When true (default), torana appends `--continue` to `args` on every spawn *except* the first-after-`reset()`. This preserves conversation history across spawns. Disable (`false`) for one-shot runners that should start fresh every turn.

### Setting up Claude Code

1. Install the CLI: `npm install -g @anthropic-ai/claude-code`.
2. Authenticate: `claude setup-token` (generates an OAuth token).
3. Copy the token into your secret store; reference as `${CLAUDE_CODE_OAUTH_TOKEN}` in `runner.env`.
4. (Optional) Point `CLAUDE_CONFIG_DIR` to a per-bot dir so multiple bots don't collide on saved state.

### Agents file

Claude Code supports custom subagents via `.claude/agents/<name>.md` in the `cwd` you set. Point `args: ["--agent", "<name>"]` to use one.

## command

For anything that isn't Claude Code. Choose a wire protocol:

### `jsonl-text`: simple line protocol

One JSON line per turn in/out. No session resumption semantics; reset via stdin envelope.

**stdin (torana → runner):**
```json
{"type":"turn","turn_id":"1","text":"hello","attachments":[]}
{"type":"reset"}
```

**stdout (runner → torana):**
```json
{"type":"ready"}
{"type":"text","turn_id":"1","text":"streaming chunk"}
{"type":"done","turn_id":"1"}
{"type":"error","turn_id":"1","message":"...","retriable":false}
{"type":"status","turn_id":"1","phase":"thinking"}
{"type":"rate_limit","retry_after_ms":30000}
```

Lines that don't parse as JSON or don't carry a known `type` are logged at debug and dropped. Unknown fields inside known events are ignored (forward compat).

```yaml
runner:
  type: command
  protocol: jsonl-text
  cmd: ["bun", "my-runner.ts"]
  cwd: ./my-runner
  on_reset: signal       # send {"type":"reset"} on stdin
  env:
    MY_API_KEY: ${MY_API_KEY}
```

`on_reset: restart` kills + respawns the subprocess instead of sending a reset envelope — use this if your runner can't handle `{"type":"reset"}`.

### `claude-ndjson`: the Claude Code wire format

If your CLI speaks the same stream-json NDJSON format as Claude Code, set `protocol: claude-ndjson` and torana will parse it with the same translator.

## Writing your own runner

For most cases, the `command` runner + one of the built-in protocols is enough. If you need tighter integration (custom protocols, direct library calls, an in-process implementation), you'd implement the `AgentRunner` TypeScript interface — but that's not yet loadable as a plugin in v1. See [`writing-a-runner.md`](writing-a-runner.md) for the interface contract.
