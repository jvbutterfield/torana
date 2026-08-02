const encoder = new TextEncoder();

/** Buzz message bodies are native GitHub-flavored Markdown. */
export function renderBuzzMessage(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n");
}

export function buzzMessageBytes(markdown: string): number {
  return encoder.encode(renderBuzzMessage(markdown)).byteLength;
}

/** Split without cutting a UTF-8 code point, preferring a newline boundary. */
export function splitBuzzMessage(markdown: string, maxBytes: number): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Buzz maxBytes must be a positive integer");
  }
  const text = renderBuzzMessage(markdown);
  if (buzzMessageBytes(text) <= maxBytes) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (buzzMessageBytes(remaining) > maxBytes) {
    let used = 0;
    let boundary = 0;
    let newlineBoundary = -1;
    for (const character of remaining) {
      const bytes = encoder.encode(character).byteLength;
      if (used + bytes > maxBytes) break;
      used += bytes;
      boundary += character.length;
      if (character === "\n") newlineBoundary = boundary;
    }
    if (boundary === 0) {
      throw new Error("Buzz maxBytes is smaller than one UTF-8 code point");
    }
    const splitAt =
      newlineBoundary >= boundary / 2 ? newlineBoundary : boundary;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
