# Writing a runner

> Torana does not load third-party runners from separate npm packages; runner
> plugins remain future work. This doc describes the `AgentRunner` contract for
> contributors, and the three subprocess protocols for users writing their own
> runner via `runner.type: command` — which is the supported extension point
> and needs no changes to Torana.

## The interface

```ts
interface AgentRunner {
  readonly botId: string;
  start(): Promise<void>;
  stop(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  sendTurn(
    turnId: string,
    text: string,
    attachments: Attachment[],
  ): SendTurnResult;
  reset(): Promise<void>;
  supportsReset(): boolean;
  isReady(): boolean;
  on<E>(event: E, handler: (e: Event<E>) => void): Unsubscribe;

  // Side-session API (added in v1 for the Agent API). A runner that returns
  // false from supportsSideSessions() stubs the rest — calls return typed
  // "not supported" errors.
  supportsSideSessions(): boolean;
  startSideSession(sessionId: string): Promise<void>;
  sendSideTurn(
    sessionId: string,
    turnId: string,
    text: string,
    attachments: Attachment[],
  ): SendTurnResult;
  stopSideSession(sessionId: string, graceMs?: number): Promise<void>;
  onSide<E>(
    sessionId: string,
    event: E,
    handler: (e: Event<E>) => void,
  ): Unsubscribe;
}
```

**Side-sessions** (`src/runner/types.ts` — `AgentRunner`) are the per-`session_id`
subprocess pool the Agent API uses for synchronous `ask` requests. Each
side-session is event-isolated — events dispatched to
`onSide(sessionId, ...)` never reach the main `on(...)` emitter and vice
versa. Built-ins that support them:

- `ClaudeCodeRunner` — long-lived subprocess per session with its own
  `--session-id` argv. The runner mints a UUID internally for the
  `--session-id` value because Claude CLI 2.1+ rejects non-UUIDs; the
  pool's public `session_id` is unaffected.
- `CodexRunner` — per-turn spawn using `codex exec resume <threadId>`.
- `CommandRunner` — supported for the `claude-ndjson` and `codex-jsonl`
  protocols. Each side-session runs the configured `cmd` as its own
  long-lived subprocess with `TORANA_SESSION_ID=<session_id>` in env so
  the wrapper can distinguish main-runner and side-session turns.
  `jsonl-text` has no session semantics in its envelope and throws
  `RunnerDoesNotSupportSideSessions` — use one of the other two protocols
  or implement a custom runner. See
  [`examples/side-session-runner/`](../examples/side-session-runner/) for
  a reference wrapper.

`session_id` format: `^[A-Za-z0-9_-]{1,64}$`. The pool mints ephemeral
`eph-<uuid>` ids when the caller omits one.

### `TORANA_SESSION_ID` — for external `command` runners

When a `command` runner (protocol `claude-ndjson` or `codex-jsonl`) is
spawned for a side-session, the subprocess receives
`TORANA_SESSION_ID=<session_id>` in its environment. The main-runner
subprocess does **not** have this variable set. Wrappers should branch on
its presence when main-vs-side behaviour diverges — for example, to keep
side-session state files separate, to tag logs, or to suppress any
startup side effects that should only fire for the main worker. Event
routing is per-subprocess (each side-session owns its own stdin/stdout
pair), so you don't need to demultiplex events across sessions yourself.

## Event contract

Every runner emits exactly these events:

```ts
type RunnerEvent =
  | { kind: "ready" }
  | { kind: "text_delta"; turnId; text: string }
  | { kind: "done"; turnId; stopReason?; usage?; finalText?; durationMs? }
  | { kind: "error"; turnId; message; retriable }
  | { kind: "fatal"; message; code? }
  | { kind: "rate_limit"; turnId?; retry_after_ms }
  | { kind: "status"; turnId?; phase };
```

### Ordering guarantees

1. After `start()` resolves, emit exactly one `ready` before any other event.
2. Between `sendTurn(T)` accepting and `T` terminating: only `text_delta`/`status`/`rate_limit` for `T`. No other `turnId` appears.
3. Exactly one of `done | error | fatal` terminates a turn. After `fatal` the runner is considered down.
4. `reset()` is exclusive with any in-flight turn — callers await terminal event first.

### Crashed runner

If the subprocess exits mid-turn without emitting `fatal`, torana synthesizes `fatal{code:"exit"}` and treats the in-flight turn as implicitly errored.

## Subprocess runners: `jsonl-text` protocol

The recommended path for custom runners.

**Envelopes you'll receive on stdin** (one per line):

```json
{"type":"turn","turn_id":"1","text":"hello","attachments":[{"kind":"photo","path":"/abs/path.jpg","mime_type":"image/jpeg","bytes":12345}]}
{"type":"reset"}
```

**Events you emit on stdout** (one per line):

```json
{"type":"ready"}
{"type":"text","turn_id":"1","text":"streaming chunk"}
{"type":"done","turn_id":"1","stop_reason":"end_turn","usage":{"input_tokens":100,"output_tokens":200},"final_text":"the whole response"}
{"type":"error","turn_id":"1","message":"something went wrong","retriable":false}
{"type":"status","turn_id":"1","phase":"thinking"}
{"type":"rate_limit","turn_id":"1","retry_after_ms":30000}
```

Extra fields inside known events are ignored (forward compat). Lines that don't parse as JSON are logged at debug and dropped.

Send one `{"type":"ready"}` on startup. On receipt of `{"type":"reset"}` (only if `on_reset: signal` in config), re-emit `{"type":"ready"}` once session state is wiped. If your process can't handle reset in-process, set `on_reset: restart` and torana will kill + respawn.

## Subprocess runners: `claude-ndjson` protocol

The wire format the Claude Code CLI itself speaks with
`--input-format stream-json --output-format stream-json`. Use it when your agent
already emits Claude-compatible NDJSON, or when you want side-session support
without implementing your own envelope.

**On stdin**, one JSON object per line — a user message, not a turn envelope.
There is no `turn_id`; the subprocess handles one turn at a time and Torana
correlates by ordering. `content` is a plain string:

```json
{ "type": "user", "message": { "role": "user", "content": "hello" } }
```

Attachments are appended to that string, one per line, as
`[Attached file: /abs/path.jpg]` — the absolute path, not the bytes.

**On stdout**, the CLI's own event stream. Torana reads exactly these:

```json
{"type":"system","subtype":"init"}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"chunk"}}}
{"type":"result","result":"the whole response","stop_reason":"end_turn","duration_ms":1234}
```

`system` with `subtype: "init"` is the readiness signal — it becomes `ready`.
`stream_event` carrying a `content_block_delta` with a `text_delta` becomes
`text_delta`; mid-turn `assistant` events are ignored because `stream_event` is
authoritative. `result` terminates the turn: `is_error: true` produces `error`
(with `result` as the message), otherwise `done` carrying `stop_reason`,
`usage`, `duration_ms`, and `result` as the final text. Unrecognized event
types are ignored, so a newer CLI emitting extra events stays compatible.

Side-sessions are supported: each runs as its own subprocess with
`TORANA_SESSION_ID` set.

## Subprocess runners: `codex-jsonl` protocol

For wrappers around the OpenAI Codex CLI (`codex exec --json`). Torana sends
the same envelope as `jsonl-text` on stdin — Codex itself does not accept
stdin envelopes, so the wrapper is responsible for multiplexing turns:

```json
{ "type": "turn", "turn_id": "1", "text": "hello", "attachments": [] }
```

On stdout, Torana parses the Codex JSONL event stream:

```json
{"type":"thread.started","thread_id":"…"}
{"type":"item.completed","item":{"type":"agent_message","text":"the whole response"}}
{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":200}}
```

**Codex emits state changes, not token-level deltas.** The assistant reply
arrives whole in `item.completed` with `item.type == "agent_message"`, which
becomes a single `text_delta`, and `turn.completed` then produces `done` with
`stop_reason: "end_turn"`. Streaming edits still work, but as one large edit per
turn rather than incremental ones — worth knowing before you tune
`streaming.edit_interval_ms` for a Codex-backed bot. `turn.failed` becomes
`error`. `thread.started` carries the resume id, validated before use. Unknown
event shapes are dropped at debug level for forward compatibility.

Side-sessions are supported. Use this protocol — or `claude-ndjson` — rather
than `jsonl-text` if your runner needs to serve Agent API `ask` requests;
`jsonl-text` has no session semantics in its envelope and throws
`RunnerDoesNotSupportSideSessions`.

## Choosing a protocol

|                                 | `jsonl-text`                  | `claude-ndjson`                | `codex-jsonl`          |
| ------------------------------- | ----------------------------- | ------------------------------ | ---------------------- |
| Simplest to implement           | **yes**                       | no                             | no                     |
| Side-sessions (Agent API `ask`) | no                            | **yes**                        | **yes**                |
| `on_reset: signal`              | **yes**                       | no (use `restart`)             | no (use `restart`)     |
| Best when                       | writing a runner from scratch | you already emit Claude NDJSON | wrapping the Codex CLI |

## See also

- `src/runner/types.ts` — the interface
- `src/runner/protocols/jsonl-text.ts` — the parser + encoder
- `src/runner/command.ts` — the subprocess wrapper
- `examples/echo-bot/echo-runner.ts` — a ~30-line reference implementation
