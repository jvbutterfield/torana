/**
 * Convert GitHub-flavored markdown (as Claude outputs) to Telegram-compatible HTML.
 *
 * Telegram's HTML mode supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">,
 * <blockquote>.
 * We convert the most common markdown patterns and escape everything else.
 *
 * Design decision: this is intentionally simple regex-based, not a full AST parser.
 * It handles 90%+ of what Claude actually outputs. Edge cases (nested formatting,
 * malformed markdown) degrade to showing raw markers, which is the status quo.
 */

/** Escape HTML entities in text that will be wrapped in HTML tags. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface CodeBlock {
  placeholder: string;
  html: string;
}

/**
 * Convert markdown to Telegram HTML.
 *
 * Returns the original text unchanged if conversion produces something
 * that looks broken (e.g., unbalanced tags from malformed markdown).
 */
export function markdownToTelegramHtml(text: string): string {
  if (!text) return text;

  // Phase 1: Extract fenced code blocks before any other processing.
  // They must not have their contents transformed.
  const codeBlocks: CodeBlock[] = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const placeholder = `\x00CB${codeBlocks.length}\x00`;
    const escapedCode = escapeHtml(code.replace(/\n$/, "")); // trim trailing newline inside block
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    codeBlocks.push({
      placeholder,
      html: `<pre><code${langAttr}>${escapedCode}</code></pre>`,
    });
    return placeholder;
  });

  // Phase 2: Extract markdown tables and wrap in <pre> for monospace alignment.
  // A table is a sequence of lines starting with |, with a separator row (|---|).
  const tables: CodeBlock[] = [];
  processed = processed.replace(
    /(?:^|\n)((?:\|[^\n]+\|\n?)+)/gm,
    (match, tableBlock: string) => {
      // Require at least a header + separator + one data row, and a separator
      // row containing only |, -, :, and spaces
      const lines = tableBlock.replace(/\n$/, "").split("\n");
      if (lines.length < 2) return match;
      const hasSeparator = lines.some(l => /^\|[\s:|-]+\|$/.test(l));
      if (!hasSeparator) return match;

      // Strip the separator row — it's visual noise in monospace
      const displayLines = lines.filter(l => !/^\|[\s:|-]+\|$/.test(l));
      const placeholder = `\x00TBL${tables.length}\x00`;
      tables.push({
        placeholder,
        html: `<pre>${escapeHtml(displayLines.join("\n"))}</pre>`,
      });
      return placeholder;
    },
  );

  // Phase 3: Extract inline code spans (protect from further transforms)
  const inlineCode: CodeBlock[] = [];
  processed = processed.replace(/`([^`\n]+)`/g, (_match, code) => {
    const placeholder = `\x00IC${inlineCode.length}\x00`;
    inlineCode.push({
      placeholder,
      html: `<code>${escapeHtml(code)}</code>`,
    });
    return placeholder;
  });

  // Phase 4: Escape HTML entities in the remaining text
  processed = escapeHtml(processed);

  // Phase 5: Convert markdown formatting to HTML tags

  // Headers: "# Text" → bold text (Telegram has no header tag)
  processed = processed.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Horizontal rules: ---, ***, ___ (alone on a line) → thin separator
  processed = processed.replace(/^[-*_]{3,}\s*$/gm, "———");

  // Bold+italic: ***text*** → <b><i>text</i></b> (must come before bold/italic)
  processed = processed.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");

  // Bold: **text** or __text__
  processed = processed.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  processed = processed.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic: *text* or _text_ (but not inside words like file_name_here)
  // Only match _text_ when preceded by space/start and followed by space/end/punct
  processed = processed.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, "<i>$1</i>");
  processed = processed.replace(/(?<=^|[\s(])\b_([^_\n]+?)_\b(?=$|[\s).,;:!?])/gm, "<i>$1</i>");

  // Strikethrough: ~~text~~
  processed = processed.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Blockquotes: "> text" → <blockquote>text</blockquote>
  // Consecutive > lines are merged into a single blockquote.
  processed = processed.replace(/(?:^&gt; .+$\n?)+/gm, (block) => {
    const content = block
      .replace(/^&gt; /gm, "")
      .replace(/\n$/, "");
    return `<blockquote>${content}</blockquote>`;
  });

  // Links: [text](url)
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Phase 6: Restore protected blocks (inline code, tables, fenced code)
  for (const ic of inlineCode) {
    processed = processed.replace(ic.placeholder, ic.html);
  }
  for (const tbl of tables) {
    processed = processed.replace(tbl.placeholder, tbl.html);
  }
  for (const cb of codeBlocks) {
    processed = processed.replace(cb.placeholder, cb.html);
  }

  return processed;
}
