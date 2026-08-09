// US-035 — every relative link in the documentation resolves.
//
// Anchors rot silently. A `#section` that no longer exists still renders as a
// working link and lands the reader at the top of the page, so nothing ever
// complains — which is exactly why an operator following a rotation runbook
// ends up on the wrong page at the wrong moment. This walks every markdown
// file we ship and checks both halves: the file exists, and the fragment
// matches a heading in it.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

/** Markdown files whose links are checked. */
function markdownFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        found.push(full);
      }
    }
  };
  walk(join(ROOT, "docs"));
  walk(join(ROOT, "src", "provider"));
  for (const top of ["README.md", "CONTRIBUTING.md", "SECURITY.md"]) {
    if (existsSync(join(ROOT, top))) found.push(join(ROOT, top));
  }
  return found.sort();
}

/**
 * GitHub's heading-slug rules, near enough for our own headings: lowercase,
 * drop anything that is not a letter, digit, space, or hyphen, then hyphenate
 * the spaces. Inline code fences and emphasis markers vanish, which is why
 * `### \`provisioning\`` becomes `#provisioning`.
 */
function slugFor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]+/g, "")
    .replace(/ +/g, "-");
}

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#{1,6} +(.*)$/.exec(line);
    if (!match) continue;
    const slug = slugFor(match[1]!);
    // Duplicate headings get `-1`, `-2`, … suffixes on GitHub. Registering a
    // couple of them keeps a legitimate link to a repeated heading passing.
    if (!slugs.has(slug)) {
      slugs.add(slug);
    } else {
      for (let n = 1; n < 10; n += 1) {
        if (!slugs.has(`${slug}-${n}`)) {
          slugs.add(`${slug}-${n}`);
          break;
        }
      }
    }
  }
  return slugs;
}

interface Link {
  source: string;
  target: string;
  raw: string;
}

function linksIn(file: string): Link[] {
  const markdown = readFileSync(file, "utf8");
  const links: Link[] = [];
  // Strip fenced blocks so example URLs in shell snippets are not checked.
  const prose = markdown.replace(/```[\s\S]*?```/g, "");
  for (const match of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1]!.trim();
    if (
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("mailto:")
    ) {
      continue;
    }
    links.push({ source: file, target, raw: match[0]! });
  }
  return links;
}

const files = markdownFiles();
const slugCache = new Map<string, Set<string>>();

function slugsOf(file: string): Set<string> {
  const cached = slugCache.get(file);
  if (cached) return cached;
  const computed = headingSlugs(readFileSync(file, "utf8"));
  slugCache.set(file, computed);
  return computed;
}

describe("documentation links", () => {
  test("there is documentation to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  test("every relative link points at something that exists", () => {
    // Directories count: several docs link at `examples/<name>/` to mean "go
    // read that whole directory", which renders fine on GitHub.
    const broken: string[] = [];
    for (const file of files) {
      for (const link of linksIn(file)) {
        const [path] = link.target.split("#");
        if (!path) continue; // same-page anchor
        const resolved = resolve(dirname(file), path);
        if (!existsSync(resolved)) {
          broken.push(`${relative(ROOT, file)} → ${link.target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("a link into a directory carries no anchor", () => {
    // An anchor on a directory link silently goes nowhere — there is no page
    // for the fragment to resolve against.
    const bad: string[] = [];
    for (const file of files) {
      for (const link of linksIn(file)) {
        const [path, fragment] = link.target.split("#");
        if (!path || !fragment) continue;
        const resolved = resolve(dirname(file), path);
        if (existsSync(resolved) && statSync(resolved).isDirectory()) {
          bad.push(`${relative(ROOT, file)} → ${link.target}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("every anchor matches a heading in its target file", () => {
    const broken: string[] = [];
    for (const file of files) {
      for (const link of linksIn(file)) {
        const [path, fragment] = link.target.split("#");
        if (!fragment) continue;
        const target = path ? resolve(dirname(file), path) : file;
        if (!existsSync(target) || statSync(target).isDirectory()) continue;
        if (!slugsOf(target).has(fragment)) {
          broken.push(`${relative(ROOT, file)} → ${link.target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("the sections an operator is sent to under pressure exist by name", () => {
    // Pinned individually because these are followed mid-rotation or with a
    // deletion staged, and because a rename that silently breaks them would
    // otherwise only be caught if some other doc happened to link to them.
    const required: Record<string, string[]> = {
      "docs/operations.md": [
        "rotating-torana_provisioning_secrets_key",
        "rotating-the-endpointsadmin-token",
        "provisioning-audit-retention",
        "staged-deletion-alerts",
        "one-time-setup-for-desktop-managed-agents",
      ],
      "docs/configuration.md": ["provisioning", "desktop-managed-agents"],
      "docs/platforms/buzz.md": [
        "desktop-managed-agents",
        "deleting-is-staged-never-immediate",
      ],
    };
    const missing: string[] = [];
    for (const [file, anchors] of Object.entries(required)) {
      const slugs = slugsOf(join(ROOT, file));
      for (const anchor of anchors) {
        if (!slugs.has(anchor)) missing.push(`${file}#${anchor}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
