// Doc-shape guards for Phase 7 (US-017). None of these open sockets or
// parse complex structures — they just make sure the docs we ship satisfy
// the invariants the plan calls out:
//
//   1. The "Agent-to-agent messaging" non-goal has been removed from shipped
//      docs (grep-check — plan §9.3).
//   2. docs/agent-api.md exists and hits the major topic headings.
//   3. docs/cli.md exists and documents the new doctor flags.
//   4. The CHANGELOG has an Unreleased section mentioning the Agent API.
//   5. README advertises the new docs + agent-api commands.
//
// These tests intentionally fail loud when docs drift — if you rewrite a
// section, update the expected heading list here.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DURATION_BUCKETS_MS } from "../../src/metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "../..");
const DOCS = resolve(REPO, "docs");
const README = resolve(REPO, "README.md");
const CHANGELOG = resolve(REPO, "CHANGELOG.md");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Files that get published / are user-facing. Excludes the PRD/impl/progress
 * trackers under `tasks/`, node_modules, dist, data dirs, and test files
 * (some of which reference the removed non-goal in test comments).
 */
function shippedMarkdownFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > 4) return;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      if (entry === "node_modules" || entry === "dist" || entry === "data") continue;
      if (entry === "tasks") continue;
      if (entry === "test") continue;
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  walk(REPO, 0);
  return out;
}

describe("docs — grep guard: agent-to-agent non-goal removed", () => {
  test(`no shipped markdown file contains "Agent-to-agent messaging"`, () => {
    const offenders: string[] = [];
    for (const path of shippedMarkdownFiles()) {
      const body = read(path);
      if (body.includes("Agent-to-agent messaging")) {
        offenders.push(path.slice(REPO.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("docs/agent-api.md", () => {
  const path = join(DOCS, "agent-api.md");
  test("exists and is non-trivial (>=1500 words)", () => {
    const body = read(path);
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    expect(wordCount).toBeGreaterThanOrEqual(1500);
  });

  test("covers all the required topic headings", () => {
    const body = read(path);
    const required = [
      "# Agent API",
      "## Enable it",
      "## Architecture",
      "## Authentication",
      "## Endpoints",
      "### `POST /v1/bots/:bot_id/ask`",
      "### `POST /v1/bots/:bot_id/inject`",
      "### `GET /v1/turns/:turn_id`",
      "### `GET /v1/bots`",
      "### `GET /v1/health`",
      "## Rate-limit and concurrency model",
      "## Observability",
      "## Security model",
      "## CLI",
    ];
    for (const h of required) {
      expect(body).toContain(h);
    }
  });

  test("documents every Prometheus metric shipped in Phase 7", () => {
    const body = read(path);
    const metrics = [
      "torana_agent_api_requests_total",
      "torana_agent_api_inject_idempotent_replays_total",
      "torana_agent_api_side_sessions_started_total",
      "torana_agent_api_side_session_evictions_total",
      "torana_agent_api_side_session_capacity_rejected_total",
      "torana_agent_api_ask_orphan_resolutions_total",
      "torana_agent_api_side_sessions_live",
      "torana_agent_api_request_duration_ms",
      "torana_agent_api_side_session_acquire_duration_ms",
    ];
    for (const m of metrics) {
      expect(body).toContain(m);
    }
  });

  test("documents the session_id sharing caveat", () => {
    const body = read(path);
    expect(body).toMatch(/session.?id sharing|session_id.*sharing/i);
  });

  test("documented histogram bucket list matches DURATION_BUCKETS_MS at runtime", () => {
    // Guards against buckets drifting silently between code + docs.
    // The doc renders the sequence as a comma-separated list; this test
    // extracts it and compares to the exported constant.
    const body = read(path);
    const sentence = body.match(/Bucket sequence.*?:\s*`([^`]+)`/);
    expect(sentence).not.toBeNull();
    const docBuckets = sentence![1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s.replace(/_/g, "")));
    expect(docBuckets).toEqual([...DURATION_BUCKETS_MS]);
  });

  test("documents the orphan-resolutions counter added with the orphan-listener wiring", () => {
    const body = read(path);
    expect(body).toContain("torana_agent_api_ask_orphan_resolutions_total");
    expect(body).toMatch(/outcome.*done.*error.*fatal.*backstop|done.*error.*fatal.*backstop/);
  });
});

describe("docs/cli.md", () => {
  const path = join(DOCS, "cli.md");
  test("exists and covers both command surfaces", () => {
    const body = read(path);
    expect(body).toContain("# CLI reference");
    expect(body).toContain("## Gateway commands");
    expect(body).toContain("## Agent-API client commands");
    expect(body).toContain("### `torana ask`");
    expect(body).toContain("### `torana inject`");
    expect(body).toContain("### `torana turns get`");
    expect(body).toContain("### `torana bots list`");
  });

  test("documents the new doctor remote-mode flags", () => {
    const body = read(path);
    expect(body).toContain("--server");
    expect(body).toContain("--token");
    expect(body).toContain("--profile");
    expect(body).toContain("R001");
    expect(body).toContain("R002");
    expect(body).toContain("R003");
  });

  test("exit-code taxonomy matches ExitCode constants", () => {
    const body = read(path);
    expect(body).toMatch(/\|\s*`0`\s*\|/);
    expect(body).toMatch(/\|\s*`6`\s*\|\s*Timeout/);
    expect(body).toMatch(/\|\s*`7`\s*\|\s*Capacity/);
  });
});

describe("docs/security.md — Agent API section", () => {
  test("has an Agent API auth subsection", () => {
    const body = read(join(DOCS, "security.md"));
    expect(body).toContain("## Agent API auth");
    expect(body).toContain("SHA-256");
    expect(body).toContain("timingSafeEqual");
  });
});

describe("docs/configuration.md — agent_api block", () => {
  test("documents the agent_api config block", () => {
    const body = read(join(DOCS, "configuration.md"));
    expect(body).toContain("### `agent_api`");
    expect(body).toContain("secret_ref");
    expect(body).toContain("side_sessions");
    expect(body).toContain("idempotency_retention_ms");
  });
});

describe("docs/runners.md + writing-a-runner.md — side-session notes", () => {
  test("runners.md calls out side-session support per runner", () => {
    const body = read(join(DOCS, "runners.md"));
    expect(body).toContain("Side-sessions");
    expect(body).toMatch(/claude-code.*yes|yes.*claude-code/i);
    expect(body).toMatch(/codex.*yes|yes.*codex/i);
    expect(body).toMatch(/command.*no|no.*command/i);
  });

  test("writing-a-runner.md documents the side-session interface addition", () => {
    const body = read(join(DOCS, "writing-a-runner.md"));
    expect(body).toContain("supportsSideSessions");
    expect(body).toContain("startSideSession");
    expect(body).toContain("sendSideTurn");
    expect(body).toContain("stopSideSession");
    expect(body).toContain("onSide");
  });
});

describe("README.md — Agent API section", () => {
  test("advertises the Agent API feature", () => {
    const body = read(README);
    expect(body).toContain("## Agent API");
  });

  test("lists the new docs", () => {
    const body = read(README);
    expect(body).toContain("docs/agent-api.md");
    expect(body).toContain("docs/cli.md");
  });

  test("architecture mermaid diagram references the Agent API node", () => {
    const body = read(README);
    expect(body).toContain("Agent API");
    expect(body).toContain("/v1/bots/:id/ask");
  });
});

describe("CHANGELOG.md — Unreleased entry", () => {
  test("has an Unreleased section that mentions the Agent API", () => {
    const body = read(CHANGELOG);
    const unreleasedIdx = body.indexOf("## [Unreleased]");
    expect(unreleasedIdx).toBeGreaterThanOrEqual(0);
    // The Unreleased section should mention Agent API before the next
    // version heading (## [1.0.0-rc.X]).
    const nextVersion = body.indexOf("\n## [1.", unreleasedIdx);
    const slice = nextVersion > 0 ? body.slice(unreleasedIdx, nextVersion) : body.slice(unreleasedIdx);
    expect(slice).toContain("Agent API");
    expect(slice).toContain("side-session");
  });
});
