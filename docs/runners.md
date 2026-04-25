# Runners

A **runner** is the process that turns incoming messages into responses. torana talks to runners through a small abstraction (`AgentRunner` in `src/runner/types.ts`) that normalizes: start/stop lifecycle, turn submission, reset, and a discriminated `RunnerEvent` stream.

Three built-in runners ship with v1:

- **`claude-code`** — wraps the Claude Code CLI. Side-sessions: **yes**.
- **`codex`** — wraps the OpenAI Codex CLI. Side-sessions: **yes**
  (per-turn `codex exec resume`).
- **`command`** — wraps any subprocess that speaks a simple line protocol.
  Side-sessions: **no** in v1 (capability descriptors land in Phase 2c).

Side-sessions are a distinct subprocess-per-(bot, session_id) pool that the
[Agent API](agent-api.md) uses for synchronous `ask` requests. An `ask`
against a runner that doesn't support them returns
`501 runner_does_not_support_side_sessions`. `send` works against every
runner.

Pick one per bot in your YAML. Different bots in the same gateway can use different runners — see [Hybrid configurations](#hybrid-configurations) below.

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
      acknowledge_dangerous: true # REQUIRED — see below
      env:
        CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}
        CLAUDE_CONFIG_DIR: /data/state/claude-config/cato
```

### `acknowledge_dangerous` is required

The runner always passes `--dangerously-skip-permissions` to the Claude CLI
(the CLI's interactive permission prompt cannot be answered over the NDJSON
protocol torana speaks, so it has to be turned off). That means **every
turn runs unsandboxed** and inherits host-level file + command access in the
runner's `cwd`: a leaked Agent API token, a malicious tool output, or a
prompt injection reaching the runner is equivalent to letting that actor
shell into the container.

Set `acknowledge_dangerous: true` to confirm you have understood this and
that the bot is running inside a container, VM, or otherwise hardened
environment where the blast radius is acceptable. The config loader
refuses to start a claude-code bot without this flag.

Matches the Codex `approval_mode: yolo` acknowledgement pattern.

### What `pass_continue_flag` does

When true (default), torana appends `--continue` to `args` on every spawn _except_ the first-after-`reset()` — including the first spawn after a gateway restart, so the on-disk Claude session resumes seamlessly across reboots. Disable (`false`) for one-shot runners that should start fresh every turn.

### Setting up Claude Code

1. Install the CLI: `npm install -g @anthropic-ai/claude-code`.
2. Authenticate: `claude setup-token` (generates an OAuth token).
3. Copy the token into your secret store; reference as `${CLAUDE_CODE_OAUTH_TOKEN}` in `runner.env`.
4. (Optional) Point `CLAUDE_CONFIG_DIR` to a per-bot dir so multiple bots don't collide on saved state.

### Agents file

Claude Code supports custom subagents via `.claude/agents/<name>.md` in the `cwd` you set. Point `args: ["--agent", "<name>"]` to use one.

## codex

Wraps `codex exec --json …` for the OpenAI Codex CLI.

```yaml
bots:
  - id: cody
    token: ${TELEGRAM_BOT_TOKEN_CODY}
    runner:
      type: codex
      cli_path: codex
      args: ["--profile", "torana"] # optional user extras (e.g. --profile, -c key=value)
      cwd: /data/projects/cody
      pass_resume_flag: true
      approval_mode: full-auto
      sandbox: workspace-write
      model: gpt-5
      env:
        OPENAI_API_KEY: ${OPENAI_API_KEY}
        CODEX_HOME: /data/state/codex/cody
```

### One-shot per turn

Codex is **one-shot per turn**: each `sendTurn()` spawns a fresh `codex exec` (or `codex exec resume <thread_id>` for follow-ups), pipes the user text on stdin, parses the JSONL events on stdout, and exits. There is no long-lived stdin envelope loop like Claude Code.

### What `pass_resume_flag` does

When true (default), the runner captures the `thread_id` from each turn's `thread.started` event and passes `resume <thread_id>` on the next turn. The captured id is also persisted in `worker_state.codex_thread_id` so the first turn after a gateway restart resumes the same thread instead of starting fresh. `reset()` clears the captured thread id (in memory and in the DB) so the next turn starts a new session. Set false for one-shot runners that should always start fresh.

### Approval mode and sandbox

| `approval_mode`       | Maps to                                      | Behavior                                                                                                                                                                            |
| --------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full-auto` (default) | `--full-auto`                                | On-request approvals + workspace-write sandbox. Recommended for unattended bots.                                                                                                    |
| `untrusted`           | `-c approval_policy=untrusted`               | Approval required for untrusted commands.                                                                                                                                           |
| `on-request`          | `-c approval_policy=on-request`              | Codex asks before potentially-impactful actions.                                                                                                                                    |
| `never`               | `-c approval_policy=never`                   | Codex never asks (still respects sandbox).                                                                                                                                          |
| `yolo`                | `--dangerously-bypass-approvals-and-sandbox` | **Bypasses everything.** Requires `acknowledge_dangerous: true` in config and emits a startup warning. Only use inside an externally hardened environment (container, isolated VM). |

`sandbox` maps to `--sandbox` and accepts `read-only`, `workspace-write` (default), or `danger-full-access`. Skipped when `approval_mode: yolo` or on resume turns (the original session's sandbox is inherited; `codex exec resume` doesn't accept `--sandbox`).

The runner always passes `--skip-git-repo-check` because bot data dirs aren't typically git repos and Codex refuses to run outside one by default.

### Streaming

Codex's `--json` event stream emits **state-change events**, not token-level deltas. The assistant message arrives whole inside `item.completed { item: { type: "agent_message", text } }`, so torana renders **one streaming edit per turn at completion** rather than incremental edits. This is an accepted limitation — the per-bot log file at `${data_dir}/logs/<bot_id>.log` retains the full event stream for debugging.

### Attachments

Codex's `--image` flag accepts only image files. Non-image attachments (documents, PDFs) are **skipped with a warning** rather than passed through. Photos forwarded by users in Telegram work as expected.

### Setting up the Codex CLI

1. Install: `npm install -g @openai/codex`.
2. Authenticate one of two ways:
   - **API key (simplest):** set `OPENAI_API_KEY` in `runner.env`. Works without `HOME`.
   - **OAuth:** `codex login` (browser flow), persists in `~/.codex/`. **You must pass `HOME` (or `CODEX_HOME` pointing at the auth dir) in `runner.env`** — `runner.env` is the _complete_ environment for the subprocess, so without `HOME` codex can't find its auth files even though they exist on disk. Use a per-bot `CODEX_HOME` if you run multiple Codex bots so OAuth state doesn't collide.
3. (Optional) Configure profiles in `~/.codex/config.toml` and reference them with `args: ["--profile", "<name>"]`.

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
  on_reset: signal # send {"type":"reset"} on stdin
  env:
    MY_API_KEY: ${MY_API_KEY}
```

`on_reset: restart` kills + respawns the subprocess instead of sending a reset envelope — use this if your runner can't handle `{"type":"reset"}`.

### `claude-ndjson`: the Claude Code wire format

If your CLI speaks the same stream-json NDJSON format as Claude Code, set `protocol: claude-ndjson` and torana will parse it with the same translator.

### `codex-jsonl`: the Codex `exec --json` wire format

If your wrapper subprocess emits Codex-style state-change events (`thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`, `turn.failed`, `error`), set `protocol: codex-jsonl`. Stdin envelopes use the same shape as `jsonl-text` (the Codex CLI itself doesn't take stdin envelopes — wrappers multiplex turns themselves).

Long-lived `codex-jsonl` wrappers can emit a synthetic `{"type":"ready"}` line on startup so torana promotes the runner to ready before the first turn.

## Inlined secrets: `runner.secrets`

`runner.env` values are **not** auto-redacted — they land in `torana validate` output and any log line that echoes resolved config in cleartext. Two ways to keep secrets out of those:

1. **Preferred:** keep secrets out of YAML entirely with `${VAR}` indirection. The literal value lives only in your secret store / process env.

2. **Fallback:** when env-var indirection isn't feasible (committed config, CI), use the sibling `runner.secrets` map. Same shape as `runner.env` (string→string, merged into the spawn env on top of `env`), but every value is registered with the log redactor at config load and printed as `<redacted:N chars>` in `torana validate`.

```yaml
runner:
  type: claude-code
  env:
    CLAUDE_CONFIG_DIR: /data/state/claude-config/cato   # not sensitive
  secrets:
    ANTHROPIC_API_KEY: sk-ant-XXXXXXXXXXXXXXXXXXXXX     # masked in logs + validate
```

Setting the same key in both `env` and `secrets` is rejected at load time — pick one. Values shorter than 6 characters are not added to the redactor (they would cause pathological substring matches in unrelated log text); use `${VAR}` indirection in `env` for short tokens that absolutely must be redacted.

## Hybrid configurations

Different bots in the same gateway can use different runners. The dispatcher routes each Telegram update to its bot's runner independently. Example: one Claude Code bot for code review and one Codex bot for prose drafting:

```yaml
bots:
  - id: reviewer
    token: ${TELEGRAM_BOT_TOKEN_REVIEWER}
    runner:
      type: claude-code
      env:
        CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}

  - id: drafter
    token: ${TELEGRAM_BOT_TOKEN_DRAFTER}
    runner:
      type: codex
      approval_mode: full-auto
      sandbox: workspace-write
      env:
        OPENAI_API_KEY: ${OPENAI_API_KEY}
```

No special configuration is required — pick the runner per bot.

## Writing your own runner

For most cases, the `command` runner + one of the built-in protocols is enough. If you need tighter integration (custom protocols, direct library calls, an in-process implementation), you'd implement the `AgentRunner` TypeScript interface — but that's not yet loadable as a plugin in v1. See [`writing-a-runner.md`](writing-a-runner.md) for the interface contract.
