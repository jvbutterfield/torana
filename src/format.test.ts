import { describe, test, expect } from "bun:test";
import { markdownToTelegramHtml } from "./format.js";

describe("markdownToTelegramHtml", () => {
  test("returns empty string for empty input", () => {
    expect(markdownToTelegramHtml("")).toBe("");
  });

  test("passes plain text through with HTML escaping", () => {
    expect(markdownToTelegramHtml("hello world")).toBe("hello world");
    expect(markdownToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  test("converts bold **text**", () => {
    expect(markdownToTelegramHtml("this is **bold** text")).toBe("this is <b>bold</b> text");
  });

  test("converts bold __text__", () => {
    expect(markdownToTelegramHtml("this is __bold__ text")).toBe("this is <b>bold</b> text");
  });

  test("converts italic *text*", () => {
    expect(markdownToTelegramHtml("this is *italic* text")).toBe("this is <i>italic</i> text");
  });

  test("converts strikethrough ~~text~~", () => {
    expect(markdownToTelegramHtml("this is ~~deleted~~ text")).toBe("this is <s>deleted</s> text");
  });

  test("converts inline code", () => {
    expect(markdownToTelegramHtml("use `git status` here")).toBe("use <code>git status</code> here");
  });

  test("converts fenced code blocks", () => {
    const input = "before\n```python\nprint('hi')\n```\nafter";
    const expected = "before\n<pre><code class=\"language-python\">print('hi')</code></pre>\nafter";
    expect(markdownToTelegramHtml(input)).toBe(expected);
  });

  test("converts fenced code blocks without language", () => {
    const input = "```\nsome code\n```";
    const expected = "<pre><code>some code</code></pre>";
    expect(markdownToTelegramHtml(input)).toBe(expected);
  });

  test("escapes HTML inside code blocks", () => {
    const input = "```\n<div>test</div>\n```";
    const expected = "<pre><code>&lt;div&gt;test&lt;/div&gt;</code></pre>";
    expect(markdownToTelegramHtml(input)).toBe(expected);
  });

  test("converts headers to bold", () => {
    expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
    expect(markdownToTelegramHtml("## Subtitle")).toBe("<b>Subtitle</b>");
    expect(markdownToTelegramHtml("### H3")).toBe("<b>H3</b>");
  });

  test("converts links", () => {
    expect(markdownToTelegramHtml("[click here](https://example.com)"))
      .toBe('<a href="https://example.com">click here</a>');
  });

  test("handles mixed formatting", () => {
    const input = "**Root Cause:** The `config.json` file was *missing* a required field.";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("<b>Root Cause:</b>");
    expect(result).toContain("<code>config.json</code>");
    expect(result).toContain("<i>missing</i>");
  });

  test("does not transform underscores inside words", () => {
    // file_name_here should NOT become file<i>name</i>here
    const result = markdownToTelegramHtml("check file_name_here.txt");
    expect(result).not.toContain("<i>");
    expect(result).toContain("file_name_here.txt");
  });

  test("handles bold+italic nested (**_text_**)", () => {
    // Bold wrapping italic — common in Claude output
    const result = markdownToTelegramHtml("**important** point");
    expect(result).toBe("<b>important</b> point");
  });

  test("converts markdown tables to pre blocks", () => {
    const input = [
      "| Name | Status |",
      "| --- | --- |",
      "| Cato | ready |",
      "| Harper | busy |",
    ].join("\n");
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("<pre>");
    expect(result).toContain("| Name | Status |");
    expect(result).toContain("| Cato | ready |");
    // Separator row should be stripped
    expect(result).not.toContain("| --- | --- |");
  });

  test("escapes HTML inside tables", () => {
    const input = [
      "| Col |",
      "| --- |",
      "| <b>test</b> |",
    ].join("\n");
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("&lt;b&gt;test&lt;/b&gt;");
  });

  test("does not treat random pipe lines as tables (no separator)", () => {
    const input = "| just a pipe | not a table |";
    const result = markdownToTelegramHtml(input);
    expect(result).not.toContain("<pre>");
  });

  test("preserves text around tables", () => {
    const input = "Before\n| A | B |\n| - | - |\n| 1 | 2 |\nAfter";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("Before");
    expect(result).toContain("After");
    expect(result).toContain("<pre>");
  });

  test("converts ***bold italic***", () => {
    expect(markdownToTelegramHtml("this is ***important*** stuff"))
      .toBe("this is <b><i>important</i></b> stuff");
  });

  test("converts blockquotes", () => {
    const result = markdownToTelegramHtml("> This is a quote");
    expect(result).toBe("<blockquote>This is a quote</blockquote>");
  });

  test("merges consecutive blockquote lines", () => {
    const input = "> Line one\n> Line two\n> Line three";
    const result = markdownToTelegramHtml(input);
    expect(result).toBe("<blockquote>Line one\nLine two\nLine three</blockquote>");
  });

  test("blockquote with surrounding text", () => {
    const input = "Before\n> Quoted text\nAfter";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("Before");
    expect(result).toContain("<blockquote>Quoted text</blockquote>");
    expect(result).toContain("After");
  });

  test("converts horizontal rules to separator", () => {
    expect(markdownToTelegramHtml("above\n---\nbelow")).toBe("above\n———\nbelow");
    expect(markdownToTelegramHtml("above\n***\nbelow")).toBe("above\n———\nbelow");
    expect(markdownToTelegramHtml("above\n___\nbelow")).toBe("above\n———\nbelow");
  });
});
