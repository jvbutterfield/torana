// Test fixture: print this process's argv and cwd as JSON, then exit.
//
// Used by the injection-fidelity test to prove that what the projection
// *computed* is what a spawned process actually *received* — argv boundaries
// included. A fixture that echoed a joined string would hide exactly the bug
// worth catching, where a value with a space becomes two arguments.

const payload = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
    TORANA_TEST_MARKER: process.env.TORANA_TEST_MARKER ?? null,
  },
};
process.stdout.write(`${JSON.stringify(payload)}\n`);
