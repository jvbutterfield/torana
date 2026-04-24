// Output formatter for agent-api subcommands.
//
// Two formats:
//   - human (default): pretty plain text, designed for interactive use.
//     Each subcommand owns its own template — there's no per-row schema
//     here, since human output is short enough to format inline.
//   - json (--json): the raw API response body, pretty-printed with 2-
//     space indent + trailing newline. Stable for scripting.
//
// Subcommands return a `Rendered` and the CLI runner emits it. Tests can
// snapshot the rendered structure without mocking process.stdout.

export interface Rendered {
  /** Lines to write to stdout, joined with `\n` then a trailing `\n`. */
  stdout: string[];
  /** Lines to write to stderr (warnings, hints). Joined the same way. */
  stderr: string[];
  /** Exit code to terminate with. */
  exitCode: number;
}

export function renderJson(value: unknown, exitCode: number): Rendered {
  return {
    stdout: [JSON.stringify(value, null, 2)],
    stderr: [],
    exitCode,
  };
}

export function renderText(
  lines: string[],
  exitCode: number,
  stderr: string[] = [],
): Rendered {
  return { stdout: lines, stderr, exitCode };
}

/** Pad a string to `n` chars (right). */
export function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/**
 * Format a list of rows as a fixed-width table. Header is bold-ish (just
 * underlined with dashes — terminals without ANSI render fine).
 */
export function formatTable(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const out: string[] = [];
  out.push(header.map((h, i) => padRight(h, widths[i]!)).join("  "));
  out.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) {
    out.push(r.map((c, i) => padRight(c, widths[i]!)).join("  "));
  }
  return out;
}

/**
 * Emit a `Rendered` to the runtime. Returns the chosen exit code so the
 * caller can `process.exit(code)`.
 */
export function emit(r: Rendered): number {
  for (const line of r.stdout) process.stdout.write(line + "\n");
  for (const line of r.stderr) process.stderr.write(line + "\n");
  return r.exitCode;
}
