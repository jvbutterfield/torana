# Writing a runner

> v1 does not load third-party runners from separate npm packages — runner plugins are §10 future work. This doc describes the `AgentRunner` contract for contributors and for users writing subprocess runners via the `command` type.

## The interface

```ts
interface AgentRunner {
  readonly botId: string;
  start(): Promise<void>;
  stop(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  sendTurn(turnId: string, text: string, attachments: Attachment[]): SendTurnResult;
  reset(): Promise<void>;
  supportsReset(): boolean;
  isReady(): boolean;
  on<E>(event: E, handler: (e: Event<E>) => void): Unsubscribe;

  // Side-session API (added in v1 for the Agent API). A runner that returns
  // false from supportsSideSessions() stubs the rest — calls return typed
  // "not supported" errors.
  supportsSideSessions(): boolean;
  startSideSession(sessionId: string): Promise<void>;
  sendSideTurn(sessionId: string, turnId: string, text: string, attachments: Attachment[]): SendTurnResult;
  stopSideSession(sessionId: string, graceMs?: number): Promise<void>;
  onSide<E>(sessionId: string, event: E, handler: (e: Event<E>) => void): Unsubscribe;
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
  | { kind: "done";  turnId; stopReason?; usage?; finalText?; durationMs? }
  | { kind: "error"; turnId; message; retriable }
  | { kind: "fatal"; message; code? }
  | { kind: "rate_limit"; turnId?; retry_after_ms }
  | { kind: "status"; turnId?; phase }
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

Identical to what the Claude Code CLI emits with `--output-format stream-json`. Use this if you have a Claude-compatible agent.

## See also

- `src/runner/types.ts` — the interface
- `src/runner/protocols/jsonl-text.ts` — the parser + encoder
- `src/runner/command.ts` — the subprocess wrapper
- `examples/echo-bot/echo-runner.ts` — a ~30-line reference implementation
