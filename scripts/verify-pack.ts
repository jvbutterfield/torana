// Verifies the npm tarball that would be published actually contains the
// runtime-loaded SQL files. Defends against a regression where `package.json`
// `files` is trimmed without updating this guard. Runs in CI after `bun run
// build`. See plan §14.L bug 2.

import { $ } from "bun";

interface PackEntry {
  path: string;
  size: number;
}

interface PackResult {
  files?: PackEntry[];
}

const REQUIRED = [
  // Core schema + migrations — all read at runtime by the migration dispatcher.
  "dist/db/schema.sql",
  "dist/db/migrations/0001_persona_to_bot_id.sql",
  "dist/db/migrations/0002_agent_api.sql",
  "dist/db/migrations/0003_runner_session_resume.sql",
  // Agent-API skills — `torana skills install` reads these at runtime from the
  // installed package, not from a bundle, so they have to ship as real files.
  "skills/torana-ask/SKILL.md",
  "skills/torana-send/SKILL.md",
  // Codex plugin — Codex marketplace installs pull from these paths directly.
  // The skill copies under codex-plugin/skills/ must remain byte-identical to
  // skills/ — enforced at build-time by scripts/check-skill-parity.ts.
  "codex-plugin/marketplace.json",
  "codex-plugin/skills/torana-ask/SKILL.md",
  "codex-plugin/skills/torana-send/SKILL.md",
  // Side-session runner example — referenced from docs/agent-api.md and the
  // CommandRunner section of the runner docs as the canonical integration
  // pattern for the claude-ndjson / codex-jsonl protocols.
  "examples/side-session-runner/session-runner.ts",
  "examples/side-session-runner/torana.yaml",
  "examples/side-session-runner/README.md",
];

const raw = await $`npm pack --dry-run --json`.quiet().text();
const parsed = JSON.parse(raw) as PackResult[];
const entry = parsed[0];
if (!entry || !entry.files) {
  console.error(
    "verify-pack: `npm pack --dry-run --json` returned no files array",
  );
  process.exit(1);
}

const paths = new Set(entry.files.map((f) => f.path));
const missing = REQUIRED.filter((r) => !paths.has(r));
if (missing.length > 0) {
  console.error("verify-pack: required files missing from tarball:");
  for (const m of missing) console.error(`  - ${m}`);
  console.error(
    'verify-pack: check `package.json` "files" and scripts/build.ts',
  );
  process.exit(1);
}

console.log(
  `verify-pack: tarball contains all ${REQUIRED.length} required SQL files`,
);
