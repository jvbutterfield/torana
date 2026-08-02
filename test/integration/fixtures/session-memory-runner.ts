// Stateful jsonl-text fixture. Each managed session gets its own process, so
// the in-memory sentinel makes isolation and deliberate alias sharing visible
// through the full Telegram → scheduler → runner → Telegram path.

export {};

let sentinel = "unset";
process.stdout.write(JSON.stringify({ type: "ready" }) + "\n");

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

async function main(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of process.stdin as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as {
        type: string;
        turn_id?: string;
        text?: string;
      };
      if (event.type !== "turn" || !event.turn_id) continue;
      const remember = /^remember sentinel (.+)$/i.exec(event.text ?? "");
      if (remember) sentinel = remember[1]!;
      const reply = remember ? `stored: ${sentinel}` : `sentinel: ${sentinel}`;
      emit({ type: "text", turn_id: event.turn_id, text: reply });
      emit({ type: "done", turn_id: event.turn_id, final_text: reply });
    }
  }
}

void main();
