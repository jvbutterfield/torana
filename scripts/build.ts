// Build script: bundle src/cli.ts and copy runtime-loaded SQL files into dist/.
//
// The bundler (bun build) emits a single dist/cli.js. Migration/schema SQL is
// read at runtime via fs, so it must be copied alongside the bundle and listed
// in package.json "files". Previously this step did not exist — rc.1 shipped
// without any .sql and `torana start --auto-migrate` failed on first boot.
// See plan §14.L bug 2.

import { $ } from "bun";
import {
  mkdirSync,
  readdirSync,
  copyFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { syncSkills, checkParity } from "./check-skill-parity.js";

const repoRoot = new URL("..", import.meta.url).pathname;
const srcDb = join(repoRoot, "src", "db");
const distRoot = join(repoRoot, "dist");
const distDb = join(distRoot, "db");
const distMigrations = join(distDb, "migrations");

// 1. Clean prior output. Keeps a stale file from surviving a rename upstream.
if (existsSync(distRoot)) {
  rmSync(distRoot, { recursive: true, force: true });
}

// 2. Bundle.
await $`bun build src/cli.ts --target=bun --outdir=dist --external bun:sqlite`.cwd(
  repoRoot,
);

// 3. Copy schema + migrations. Mirror the src/db/ layout so both candidates in
//    migrate.ts (source-relative + bundle-relative) resolve cleanly.
mkdirSync(distMigrations, { recursive: true });
copyFileSync(join(srcDb, "schema.sql"), join(distDb, "schema.sql"));

const migrationFiles = readdirSync(srcDb + "/migrations").filter((f) =>
  f.endsWith(".sql"),
);
if (migrationFiles.length === 0) {
  console.error("build: no migration .sql files found in src/db/migrations/");
  process.exit(1);
}
for (const f of migrationFiles) {
  copyFileSync(join(srcDb, "migrations", f), join(distMigrations, f));
}

// 4. Post-copy sanity: every target exists and is non-empty. If this fires it
//    means the runtime migration dispatcher will throw "not found" on first
//    boot for anyone installing the tarball.
const verifyTargets = [
  join(distDb, "schema.sql"),
  ...migrationFiles.map((f) => join(distMigrations, f)),
];
for (const t of verifyTargets) {
  if (!existsSync(t) || statSync(t).size === 0) {
    console.error(`build: post-copy check failed — ${t} missing or empty`);
    process.exit(1);
  }
}

// 5. Sync skill parity (codex-plugin/skills/*/SKILL.md ← skills/*/SKILL.md)
//    and verify — fail hard if parity is broken after the copy (catches
//    readonly-fs weirdness on CI).
syncSkills(repoRoot);
const parity = checkParity(repoRoot);
if (!parity.ok) {
  console.error("build: skill parity check failed after syncSkills");
  for (const e of parity.entries) {
    if (e.drift) console.error(`  ${e.skill}: ${e.drift}`);
  }
  process.exit(1);
}

console.log(
  `build: bundled dist/cli.js + copied schema.sql and ${migrationFiles.length} migration(s) to dist/db/ + synced ${parity.entries.length} skills`,
);
