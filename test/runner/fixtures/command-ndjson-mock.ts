#!/usr/bin/env bun
// A behavior-configurable mock that speaks the torana `claude-ndjson`
// protocol for CommandRunner side-session tests (Phase 2c). Usage:
//
//   bun run command-ndjson-mock.ts <mode>
//
// Modes (first CLI arg):
//
//   normal         — emit system init; for each inbound user envelope, emit
//                    a text_delta of "echo: <text>" + a result (one turn).
//   crash-on-turn  — ready, then exit 1 on first turn.
//   slow-echo      — like normal but waits 500ms before result (for busy/429
//                    tests that need to catch a session mid-turn).
//   no-ready       — never emit the system init (tests the sideStartupMs
//                    fallback that forces ready after the timeout).
//
// Env vars read:
//   TORANA_SESSION_ID — if set, stamped on the `session_id` field of init
//     and the `result` event so tests can verify side-session isolation.

export {}; // mark as module so top-level declarations are module-scoped

const mode = process.argv[2] ?? "normal";
const sessionId = process.env.TORANA_SESSION_ID ?? "main";

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main(): Promise<void> {
  if (mode !== "no-ready") {
    emit({
      type: "system",
      subtype: "init",
      session_id: sessionId,
    });
  }

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

      if (mode === "crash-on-turn" && turnCount === 1) {
        process.exit(1);
      }

      const content = env.message?.content ?? "";
      const reply = `echo[${sessionId}]: ${content}`;

      emit({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: reply },
        },
      });
      if (mode === "slow-echo") {
        await new Promise((r) => setTimeout(r, 500));
      }
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
