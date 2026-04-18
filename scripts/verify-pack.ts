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

const REQUIRED = ["dist/db/schema.sql", "dist/db/migrations/0001_persona_to_bot_id.sql"];

const raw = await $`npm pack --dry-run --json`.quiet().text();
const parsed = JSON.parse(raw) as PackResult[];
const entry = parsed[0];
if (!entry || !entry.files) {
  console.error("verify-pack: `npm pack --dry-run --json` returned no files array");
  process.exit(1);
}

const paths = new Set(entry.files.map((f) => f.path));
const missing = REQUIRED.filter((r) => !paths.has(r));
if (missing.length > 0) {
  console.error("verify-pack: required files missing from tarball:");
  for (const m of missing) console.error(`  - ${m}`);
  console.error("verify-pack: check `package.json` \"files\" and scripts/build.ts");
  process.exit(1);
}

console.log(`verify-pack: tarball contains all ${REQUIRED.length} required SQL files`);
