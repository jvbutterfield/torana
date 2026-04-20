// §12.4: two gateways on different ports + two CLI profiles. Verify
// that `torana bots list --profile A` hits gateway A and `--profile B`
// hits gateway B — the full CLI → profile-store → HTTP round-trip.
//
// This is the "you can actually run multiple torana deployments and
// your CLI picks the right one" smoke test. It complements
// test/cli/dispatch.profile.test.ts, which covers profile precedence
// against a single gateway.
//
// Real claude runners are configured on both bots to honor the E2E
// spirit, but the assertion itself (`bots list` → 200 + list of bot
// ids) only exercises `/v1/bots`, so we never actually spawn a model
// turn — keeping this test cheap despite being E2E-gated.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  e2eEnabled,
  inheritedEnv,
  mkToken,
  startE2E,
  type E2EHarness,
} from "./_harness.js";
import type { BotConfig } from "../../../src/config/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(__dirname, "../../../src/cli.ts");

const describeOrSkip = e2eEnabled() ? describe : describe.skip;

let hA: E2EHarness | null = null;
let hB: E2EHarness | null = null;
let xdgDir: string | null = null;

afterEach(async () => {
  if (hA) await hA.close();
  if (hB) await hB.close();
  hA = null;
  hB = null;
  if (xdgDir) rmSync(xdgDir, { recursive: true, force: true });
  xdgDir = null;
});

function claudeBot(id: string): BotConfig {
  return {
    id,
    token: `e2e-cli-remote-bot-token-${id}:ffffffffffffffffffffffff`,
    commands: [],
    reactions: { received_emoji: "👀" },
    runner: {
      type: "claude-code",
      cli_path: process.env.CLAUDE_CLI_PATH ?? "claude",
      args: [],
      // Full inherited env — the runner's main process warms on
      // startup even though this test never spawns a turn, and
      // claude's auth needs more than HOME + PATH. See ask-claude
      // for the same rationale.
      env: inheritedEnv(),
      pass_continue_flag: false,
    },
  };
}

function writeProfileToml(
  profiles: Record<string, { server: string; token: string }>,
  defaultName: string,
): string {
  xdgDir = mkdtempSync(join(tmpdir(), "torana-e2e-xdg-"));
  mkdirSync(join(xdgDir, "torana"), { recursive: true });
  const path = join(xdgDir, "torana", "config.toml");
  const lines: string[] = [`default = "${defaultName}"`, ""];
  for (const [name, p] of Object.entries(profiles)) {
    lines.push(`[profile.${name}]`);
    lines.push(`server = "${p.server}"`);
    lines.push(`token = "${p.token}"`);
    lines.push("");
  }
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
  return xdgDir;
}

async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode: exitCode ?? 0 };
}

describeOrSkip("§12.4 cli-remote — two gateways, two profiles, CLI routing", () => {
  test("torana bots list --profile <name> routes to the profile's server", async () => {
    const secretA = "e2e-cli-remote-A-secret-abcdef12";
    const secretB = "e2e-cli-remote-B-secret-abcdef12";

    hA = await startE2E({
      botConfig: claudeBot("alpha-A"),
      tokens: [mkToken("a", secretA, { bot_ids: ["alpha-A"], scopes: ["ask"] })],
    });
    hB = await startE2E({
      botConfig: claudeBot("beta-B"),
      tokens: [mkToken("b", secretB, { bot_ids: ["beta-B"], scopes: ["ask"] })],
    });

    const xdg = writeProfileToml(
      {
        prodA: { server: hA.base, token: secretA },
        prodB: { server: hB.base, token: secretB },
      },
      "prodA",
    );

    // --profile prodA → hA's bot_ids
    const resA = await runCli(
      ["bots", "list", "--profile", "prodA", "--json"],
      { XDG_CONFIG_HOME: xdg },
    );
    expect(resA.exitCode).toBe(0);
    const bodyA = JSON.parse(resA.stdout);
    expect(Array.isArray(bodyA.bots)).toBe(true);
    expect(bodyA.bots.map((b: { bot_id: string }) => b.bot_id)).toEqual([
      "alpha-A",
    ]);

    // --profile prodB → hB's bot_ids
    const resB = await runCli(
      ["bots", "list", "--profile", "prodB", "--json"],
      { XDG_CONFIG_HOME: xdg },
    );
    expect(resB.exitCode).toBe(0);
    const bodyB = JSON.parse(resB.stdout);
    expect(bodyB.bots.map((b: { bot_id: string }) => b.bot_id)).toEqual([
      "beta-B",
    ]);
  }, 60_000);

  test("default profile routes to the right server when no --profile is given", async () => {
    const secretA = "e2e-cli-default-A-secret-abcdef";
    const secretB = "e2e-cli-default-B-secret-abcdef";

    hA = await startE2E({
      botConfig: claudeBot("alpha-A"),
      tokens: [mkToken("a", secretA, { bot_ids: ["alpha-A"], scopes: ["ask"] })],
    });
    hB = await startE2E({
      botConfig: claudeBot("beta-B"),
      tokens: [mkToken("b", secretB, { bot_ids: ["beta-B"], scopes: ["ask"] })],
    });

    const xdg = writeProfileToml(
      {
        prodA: { server: hA.base, token: secretA },
        prodB: { server: hB.base, token: secretB },
      },
      "prodB", // B is default.
    );

    const res = await runCli(["bots", "list", "--json"], {
      XDG_CONFIG_HOME: xdg,
    });
    expect(res.exitCode).toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.bots.map((b: { bot_id: string }) => b.bot_id)).toEqual([
      "beta-B",
    ]);
  }, 60_000);

  test("--profile bogus exits 2 with a helpful message; does not hit either server", async () => {
    const secretA = "e2e-cli-bogus-secret-abcdef1234";
    hA = await startE2E({
      botConfig: claudeBot("alpha-A"),
      tokens: [mkToken("a", secretA, { bot_ids: ["alpha-A"], scopes: ["ask"] })],
    });
    const xdg = writeProfileToml(
      {
        prodA: { server: hA.base, token: secretA },
      },
      "prodA",
    );

    const res = await runCli(
      ["bots", "list", "--profile", "does-not-exist", "--json"],
      { XDG_CONFIG_HOME: xdg },
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr + res.stdout).toMatch(/does-not-exist|profile/i);
  }, 60_000);
});
