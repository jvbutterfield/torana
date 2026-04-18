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
}
```

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
