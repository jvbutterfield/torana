#!/usr/bin/env bun
// A behavior-configurable mock that speaks the torana `codex-jsonl`
// protocol AS A LONG-LIVED PROCESS — the CommandRunner shape, not the
// CodexRunner per-turn shape. Reads jsonl-text envelopes on stdin
// (matching current CommandRunner's codex-jsonl encode path) and emits
// codex-jsonl events on stdout.
//
// Modes (first CLI arg):
//   normal    — emit a synthetic {type:"ready"} on start; for each inbound
//               turn, emit thread.started (per-turn synthetic), turn.started,
//               item.completed (agent_message), turn.completed.
//   slow-echo — like normal but waits 500ms before turn.completed.
//   crash-on-turn — ready, then exit 1 on first turn.
//
// Env vars read:
//   TORANA_SESSION_ID — stamped into the agent_message text so tests can
//     verify that events flow only to the right side-session emitter.

export {}; // mark as module so top-level declarations are module-scoped

const mode = process.argv[2] ?? "normal";
const sessionId = process.env.TORANA_SESSION_ID ?? "main";

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main(): Promise<void> {
  // Synthetic ready for long-lived codex-jsonl wrappers (see
  // createCodexJsonlParser: `{type:"ready"}` emits kind:"ready").
  emit({ type: "ready" });

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
      let env: {
        type: string;
        turn_id?: string;
        text?: string;
        attachments?: Array<{ path: string }>;
      };
      try {
        env = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (env.type !== "turn") continue;
      turnCount += 1;

      if (mode === "crash-on-turn" && turnCount === 1) {
        process.exit(1);
      }

      const text = env.text ?? "";
      // Surface attachment paths in the reply so tests can assert that the
      // outbound envelope's `attachments` field made it through the wire.
      // Shape matches the claude-ndjson inline convention so tests reading
      // either protocol see the same "[Attached file: …]" tag.
      const attachTag = env.attachments?.length
        ? env.attachments
            .map((a) => `[Attached file: ${a.path}]`)
            .join(" ")
        : "";
      const reply = attachTag
        ? `echo[${sessionId}]: ${text} ${attachTag}`
        : `echo[${sessionId}]: ${text}`;

      emit({ type: "thread.started", thread_id: `tid-${sessionId}-${turnCount}` });
      emit({ type: "turn.started" });
      emit({
        type: "item.completed",
        item: { id: "msg1", type: "agent_message", text: reply },
      });
      if (mode === "slow-echo") {
        await new Promise((r) => setTimeout(r, 500));
      }
      emit({
        type: "turn.completed",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
  }
}

void main();
