#!/usr/bin/env bun
export {}; // mark as module so top-level declarations are module-scoped

// A behavior-configurable mock that speaks the claude --output-format stream-json
// protocol. Used for ClaudeCodeRunner lifecycle tests. Modes are chosen via
// the first CLI arg:
//
//   normal           — emit system init; for each inbound user envelope, emit
//                       a content_block_delta with "echo: <text>" and a result.
//   crash-on-start   — emit nothing, exit 1 immediately.
//   crash-on-turn    — ready, then exit 1 on first turn.
//   auth-fail        — write "Error: not logged in" to stderr, exit 1.
//   stubborn         — ignore SIGTERM; must be SIGKILLed.
//   slow-start       — delay emitting system init by 400ms.
//   slow-echo        — like `normal` but waits 500ms before emitting the result.
//   replay-continue  — emit system init with current argv joined (so tests can
//                       inspect whether --continue was passed).
//   very-slow        — 2s delay before result (used for 202 timeout tests
//                       where AskBodySchema enforces min timeout_ms=1000).
//   error-turn       — ready, then on every turn emit a `result` with
//                       is_error=true so the runner emits `{kind:"error"}`.

const mode = process.argv[2] ?? "normal";

process.stdout.write("\n"); // harmless — claude sometimes warms the pipe

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main(): Promise<void> {
  if (mode === "crash-on-start") {
    process.exit(1);
  }
  if (mode === "auth-fail") {
    process.stderr.write("Error: not logged in. Run /login first.\n");
    process.exit(1);
  }
  if (mode === "stubborn") {
    // Install ignoring handlers for SIGTERM so only SIGKILL works.
    process.on("SIGTERM", () => { /* ignore */ });
    process.on("SIGINT", () => { /* ignore */ });
  }

  if (mode === "slow-start") {
    await new Promise((r) => setTimeout(r, 400));
  }

  if (mode === "replay-continue") {
    // Tag the init event with the argv so tests can see --continue presence.
    emit({
      type: "system",
      subtype: "init",
      session_id: "test",
      argv: process.argv.slice(2),
    });
  } else {
    emit({ type: "system", subtype: "init", session_id: "test" });
  }

  let inboundCount = 0;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of process.stdin as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let env: { type: string; message?: { content: string } };
      try {
        env = JSON.parse(line);
      } catch {
        continue;
      }
      if (env.type !== "user") continue;
      inboundCount += 1;

      if (mode === "crash-on-turn" && inboundCount === 1) {
        process.exit(1);
      }

      const content = env.message?.content ?? "";
      // text_delta
      emit({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: `echo: ${content}` },
        },
      });
      if (mode === "slow-echo") {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (mode === "very-slow") {
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (mode === "error-turn") {
        // Parser maps is_error=true result to a `{kind:"error"}` event.
        emit({
          type: "result",
          is_error: true,
          result: "runner refused the turn",
          duration_ms: 1,
          stop_reason: "error",
        });
        continue;
      }
      // result → emits `done`
      emit({
        type: "result",
        is_error: false,
        result: `echo: ${content}`,
        duration_ms: 1,
        stop_reason: "end_turn",
      });
    }
  }
}

void main();

// Keep the process alive while stdin is open (the for-await above suspends
// but when stdin closes, main() returns naturally and we exit).
