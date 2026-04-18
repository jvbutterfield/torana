// Minimal jsonl-text runner used by integration tests. Echoes text back
// and terminates the turn with a `done`. Small, zero-dependency, identical
// semantics to examples/echo-bot/echo-runner.ts but kept separate so the
// tests don't depend on the example's contents.

export {}; // mark as module so top-level declarations don't collide across files

process.stdout.write(JSON.stringify({ type: "ready" }) + "\n");

type TurnIn = { type: "turn"; turn_id: string; text: string; attachments?: unknown[] };
type ResetIn = { type: "reset" };

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of process.stdin as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let env: TurnIn | ResetIn;
      try {
        env = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (env.type === "reset") {
        emit({ type: "ready" });
        continue;
      }
      if (env.type === "turn") {
        const reply = `echo: ${env.text}`;
        emit({ type: "text", turn_id: env.turn_id, text: reply });
        emit({ type: "done", turn_id: env.turn_id, final_text: reply });
      }
    }
  }
}

void main();
