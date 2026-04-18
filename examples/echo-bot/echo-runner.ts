// Echo runner — speaks the torana `jsonl-text` protocol.
// Reads one-line-JSON envelopes on stdin and echoes the text back on stdout.
// Exit cleanly when stdin closes.

process.stdout.write(JSON.stringify({ type: "ready" }) + "\n");

type TurnEnvelope = { type: "turn"; turn_id: string; text: string };
type ResetEnvelope = { type: "reset" };

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
      let env: TurnEnvelope | ResetEnvelope;
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
        emit({
          type: "text",
          turn_id: env.turn_id,
          text: `echo: ${env.text}`,
        });
        emit({ type: "done", turn_id: env.turn_id });
      }
    }
  }
}

void main();
