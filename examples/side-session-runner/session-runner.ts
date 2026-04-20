// Session-aware command runner that speaks the torana `claude-ndjson`
// protocol. Demonstrates how a Phase 2c CommandRunner side-session wrapper
// can use `TORANA_SESSION_ID` to distinguish main vs side-session state.
//
// On startup, torana sets `TORANA_SESSION_ID=<sessionId>` in the env for
// side-session subprocesses; the main subprocess has no such var set. This
// program stamps the session label onto each response so the difference is
// visible to callers — agent-API `ask` turns hit a side-session subprocess;
// ordinary Telegram messages hit main.

export {}; // mark as module so top-level declarations are module-scoped

const sessionId = process.env.TORANA_SESSION_ID ?? "main";

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// Initial readiness signal for the claude-ndjson parser.
emit({ type: "system", subtype: "init", session_id: sessionId });

async function main(): Promise<void> {
  let turnCount = 0;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of process.stdin as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let env: { type: string; message?: { content: string } };
      try {
        env = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (env.type !== "user") continue;
      turnCount += 1;

      const content = env.message?.content ?? "";
      const reply = `[${sessionId}#${turnCount}] echo: ${content}`;

      // Streaming text delta.
      emit({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: reply },
        },
      });

      // Terminal result.
      emit({
        type: "result",
        is_error: false,
        result: reply,
        duration_ms: 1,
        stop_reason: "end_turn",
        session_id: sessionId,
      });
    }
  }
}

void main();
