// CLI tests — argument parsing, doctor, migrate --dry-run/apply, validate.
//
// These invoke the CLI via a subprocess (bun run src/cli.ts ...) so exit
// codes and stdout are captured authentically. A generated torana.yaml fixture
// is used per test; an in-memory fake Telegram serves getMe for C004.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../../src/cli.js";
import { runDoctor } from "../../src/doctor.js";
import { applyMigrations, planMigration } from "../../src/db/migrate.js";
import { loadConfigFromFile } from "../../src/config/load.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(__dirname, "../../src/cli.ts");
const ECHO_RUNNER = resolve(
  __dirname,
  "../integration/fixtures/test-runner.ts",
);

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-cli-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(name: string, body: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

const MINIMAL_CONFIG = (dataDir: string) => `
version: 1
gateway:
  port: 3000
  data_dir: ${dataDir}
  db_path: ${dataDir}/gateway.db
transport:
  default_mode: polling
access_control:
  allowed_user_ids: [111]
bots:
  - id: alpha
    token: BOTTOK:AAAAAA
    runner:
      type: command
      cmd: ["bun", "${ECHO_RUNNER}"]
      protocol: jsonl-text
`;

// --- parseArgs ---

describe("CLI parseArgs", () => {
  test("parses --config with space separator", () => {
    const a = parseArgs(["start", "--config", "/tmp/c.yaml"]);
    expect(a.subcommand).toBe("start");
    expect(a.configPath).toBe("/tmp/c.yaml");
  });

  test("parses --config= with equals separator", () => {
    const a = parseArgs(["start", "--config=/tmp/c.yaml"]);
    expect(a.configPath).toBe("/tmp/c.yaml");
  });

  test("parses short -c flag", () => {
    const a = parseArgs(["start", "-c", "/tmp/c.yaml"]);
    expect(a.configPath).toBe("/tmp/c.yaml");
  });

  test("parses --auto-migrate", () => {
    const a = parseArgs(["start", "--auto-migrate"]);
    expect(a.autoMigrate).toBe(true);
  });

  test("parses --dry-run", () => {
    const a = parseArgs(["migrate", "--dry-run"]);
    expect(a.dryRun).toBe(true);
  });

  test("parses --format json", () => {
    const a = parseArgs(["doctor", "--format", "json"]);
    expect(a.format).toBe("json");
  });

  test("parses --format=text", () => {
    const a = parseArgs(["doctor", "--format=text"]);
    expect(a.format).toBe("text");
  });

  test("rejects invalid --format value", () => {
    expect(() => parseArgs(["doctor", "--format", "yaml"])).toThrow(/format/);
  });

  test("rejects unknown flag", () => {
    expect(() => parseArgs(["start", "--nope"])).toThrow(/unknown flag/);
  });

  test("--help sets help flag", () => {
    const a = parseArgs(["--help"]);
    expect(a.help).toBe(true);
  });

  test("parses --server + --token for doctor remote mode", () => {
    const a = parseArgs([
      "doctor",
      "--server",
      "https://gw.example.com",
      "--token",
      "tok",
    ]);
    expect(a.server).toBe("https://gw.example.com");
    expect(a.token).toBe("tok");
  });

  test("parses --server=URL and --token=TOK (equals form)", () => {
    const a = parseArgs([
      "doctor",
      "--server=https://gw.example.com",
      "--token=tok",
    ]);
    expect(a.server).toBe("https://gw.example.com");
    expect(a.token).toBe("tok");
  });

  test("parses --profile", () => {
    const a = parseArgs(["doctor", "--profile", "prod"]);
    expect(a.profile).toBe("prod");
  });
});

// --- CLI invocation (subprocess) ---

async function runCli(
  args: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", ...(opts.env ?? {}) },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode: exitCode ?? 0 };
}

describe("CLI version", () => {
  test("prints version and exits 0", async () => {
    const { stdout, exitCode } = await runCli(["version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/torana \d+/);
    expect(stdout).toContain("bun");
  }, 15_000);
});

describe("CLI validate", () => {
  test("prints redacted config, exits 0 on valid yaml", async () => {
    const cfg = writeConfig("torana.yaml", MINIMAL_CONFIG(tmpDir));
    const { stdout, exitCode } = await runCli(["validate", "--config", cfg]);
    expect(exitCode).toBe(0);
    // token should be redacted in the output
    expect(stdout).not.toContain("BOTTOK:AAAAAA");
    expect(stdout).toContain("<redacted:");
  }, 15_000);

  test("exits non-zero on invalid yaml", async () => {
    const cfg = writeConfig("torana.yaml", "version: 2\n");
    const { exitCode, stderr } = await runCli(["validate", "--config", cfg]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/config/);
  }, 15_000);

  test("redacts runner.secrets values in validate output", async () => {
    // Inline secrets in runner.secrets must NEVER appear in the validate
    // output — neither the JSON config dump nor any log line. Closes the
    // rc.7 P2 finding where ANTHROPIC_API_KEY etc. leaked from runner.env.
    const FAKE_API_KEY = "sk-ant-fake-but-distinctive-redaction-target";
    const FAKE_DB_PW = "hunter2-also-distinctive";
    const cfgBody = `${MINIMAL_CONFIG(tmpDir)}
      secrets:
        ANTHROPIC_API_KEY: ${FAKE_API_KEY}
        DB_PASSWORD: ${FAKE_DB_PW}
`;
    const cfg = writeConfig("torana.yaml", cfgBody);
    const { stdout, stderr, exitCode } = await runCli([
      "validate",
      "--config",
      cfg,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain(FAKE_API_KEY);
    expect(stdout).not.toContain(FAKE_DB_PW);
    expect(stderr).not.toContain(FAKE_API_KEY);
    expect(stderr).not.toContain(FAKE_DB_PW);
    // Map structure preserved with the redacted-N-chars marker so operators
    // can still verify the keys they configured.
    expect(stdout).toContain("ANTHROPIC_API_KEY");
    expect(stdout).toContain(`<redacted:${FAKE_API_KEY.length} chars>`);
    expect(stdout).toContain(`<redacted:${FAKE_DB_PW.length} chars>`);
  }, 15_000);
});

describe("CLI migrate --dry-run", () => {
  test("prints plan as JSON without touching the DB", async () => {
    const cfg = writeConfig("torana.yaml", MINIMAL_CONFIG(tmpDir));
    const { stdout, exitCode } = await runCli([
      "migrate",
      "--config",
      cfg,
      "--dry-run",
    ]);
    expect(exitCode).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.currentVersion).toBeNull();
    expect(plan.targetVersion).toBe(3);
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].id).toBe("fresh-install");
    // DB should NOT have been created.
    expect(existsSync(join(tmpDir, "gateway.db"))).toBe(false);
  }, 15_000);

  test("on an up-to-date DB: empty plan", async () => {
    const dbPath = join(tmpDir, "gateway.db");
    applyMigrations(dbPath);
    const plan = planMigration(dbPath);
    expect(plan.steps).toHaveLength(0);
    expect(plan.currentVersion).toBe(3);
  });
});

describe("CLI migrate (apply)", () => {
  test("creates fresh DB with current schema, exits 0", async () => {
    const cfg = writeConfig("torana.yaml", MINIMAL_CONFIG(tmpDir));
    const { exitCode } = await runCli(["migrate", "--config", cfg]);
    expect(exitCode).toBe(0);

    const dbPath = join(tmpDir, "gateway.db");
    expect(existsSync(dbPath)).toBe(true);
    const plan = planMigration(dbPath);
    expect(plan.currentVersion).toBe(3);
  }, 15_000);
});

describe("CLI doctor (unit tests via runDoctor)", () => {
  test("returns ok for a well-formed config + reachable fake API", async () => {
    const cfg = writeConfig("torana.yaml", MINIMAL_CONFIG(tmpDir));
    // Bootstrap DB so C003 passes.
    const dbPath = join(tmpDir, "gateway.db");
    applyMigrations(dbPath);

    const fetchImpl = (async (url: string | URL) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { id: 42, username: "alpha_bot" },
          }),
        );
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const { config } = loadConfigFromFile(cfg);
    const result = await runDoctor({ config, configPath: cfg, fetchImpl });

    // All checks either "ok" or "skip". None should "fail".
    const failed = result.checks.filter((c) => c.status === "fail");
    expect(failed).toEqual([]);
    // C001 + C002 + C003 + C004 + C005 (bun is on PATH) + C006 skip + C007 ok + C008 skip
    const ids = result.checks.map((c) => c.id);
    expect(ids).toContain("C001");
    expect(ids).toContain("C002");
    expect(ids).toContain("C003");
    expect(ids).toContain("C004");
    expect(ids).toContain("C005");
    expect(ids).toContain("C006");
    expect(ids).toContain("C007");
    expect(ids).toContain("C008");
  });

  test("fails when runner entry binary isn't on PATH", async () => {
    const body = `
version: 1
gateway:
  port: 3000
  data_dir: ${tmpDir}
  db_path: ${tmpDir}/gateway.db
transport:
  default_mode: polling
access_control:
  allowed_user_ids: [111]
bots:
  - id: alpha
    token: BOTTOK:AAAAAA
    runner:
      type: command
      cmd: ["definitely-not-a-real-binary-xyz", "a", "b"]
      protocol: jsonl-text
`;
    const cfg = writeConfig("torana.yaml", body);
    applyMigrations(join(tmpDir, "gateway.db"));

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ ok: true, result: { id: 1 } }),
      )) as unknown as typeof fetch;

    const { config } = loadConfigFromFile(cfg);
    const result = await runDoctor({ config, configPath: cfg, fetchImpl });

    const c005 = result.checks.find((c) => c.id === "C005");
    expect(c005?.status).toBe("fail");
    expect(c005?.detail).toContain("not found in PATH");
  });

  test("C004 fails when getMe returns 401", async () => {
    const cfg = writeConfig("torana.yaml", MINIMAL_CONFIG(tmpDir));
    applyMigrations(join(tmpDir, "gateway.db"));

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 401,
          description: "Unauthorized",
        }),
        { status: 401 },
      )) as unknown as typeof fetch;

    const { config } = loadConfigFromFile(cfg);
    const result = await runDoctor({ config, configPath: cfg, fetchImpl });
    const c004 = result.checks.find((c) => c.id === "C004");
    expect(c004?.status).toBe("fail");
  });

  test("C002 fails for non-existent data_dir", async () => {
    const missing = join(tmpDir, "does-not-exist");
    const body = `
version: 1
gateway:
  port: 3000
  data_dir: ${missing}
  db_path: ${missing}/gateway.db
transport:
  default_mode: polling
access_control:
  allowed_user_ids: [111]
bots:
  - id: alpha
    token: BOTTOK:AAAAAA
    runner:
      type: command
      cmd: ["bun", "${ECHO_RUNNER}"]
      protocol: jsonl-text
`;
    const cfg = writeConfig("torana.yaml", body);
    const { config } = loadConfigFromFile(cfg);
    // doctor runs against the config's data_dir, which doesn't exist.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ ok: true, result: { id: 1 } }),
      )) as unknown as typeof fetch;
    const result = await runDoctor({ config, configPath: cfg, fetchImpl });
    const c002 = result.checks.find((c) => c.id === "C002");
    expect(c002?.status).toBe("fail");
  });

  test("C007 fails when config file mode is world-readable", async () => {
    const cfg = writeConfig("torana.yaml", MINIMAL_CONFIG(tmpDir));
    applyMigrations(join(tmpDir, "gateway.db"));
    chmodSync(cfg, 0o644); // world-readable
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ ok: true, result: { id: 1 } }),
      )) as unknown as typeof fetch;
    const { config } = loadConfigFromFile(cfg);
    const result = await runDoctor({ config, configPath: cfg, fetchImpl });
    const c007 = result.checks.find((c) => c.id === "C007");
    expect(c007?.status).toBe("fail");
    expect(c007?.detail).toContain("world-readable");
  });

  test("C006: webhook base_url reachability check", async () => {
    const body = `
version: 1
gateway:
  port: 3000
  data_dir: ${tmpDir}
  db_path: ${tmpDir}/gateway.db
transport:
  default_mode: webhook
  webhook:
    base_url: https://example.invalid
    secret: abcdef-padded-to-satisfy-min-32-chars
access_control:
  allowed_user_ids: [111]
bots:
  - id: alpha
    token: BOTTOK:AAAAAA
    runner:
      type: command
      cmd: ["bun", "${ECHO_RUNNER}"]
      protocol: jsonl-text
`;
    const cfg = writeConfig("torana.yaml", body);
    applyMigrations(join(tmpDir, "gateway.db"));
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (init?.method === "HEAD" && urlStr === "https://example.invalid") {
        return new Response("", { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { id: 1 } }));
    }) as unknown as typeof fetch;
    const { config } = loadConfigFromFile(cfg);
    const result = await runDoctor({ config, configPath: cfg, fetchImpl });
    const c006 = result.checks.find((c) => c.id === "C006");
    expect(c006?.status).toBe("ok");
  });
});

describe("CLI doctor (subprocess)", () => {
  test("--format json returns machine-readable output", async () => {
    const cfg = writeConfig("torana.yaml", MINIMAL_CONFIG(tmpDir));
    applyMigrations(join(tmpDir, "gateway.db"));
    // getMe call will fail on the real api.telegram.org with this fake token,
    // so we expect a non-zero exit. What we're testing here is the JSON shape.
    const { stdout } = await runCli([
      "doctor",
      "--config",
      cfg,
      "--format",
      "json",
    ]);
    // stdout should be valid JSON (even on failure).
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks[0].id).toBe("C001");
  }, 20_000);

  test("exits non-zero when any check fails", async () => {
    const cfg = writeConfig("torana.yaml", MINIMAL_CONFIG(tmpDir));
    applyMigrations(join(tmpDir, "gateway.db"));
    const { exitCode } = await runCli(["doctor", "--config", cfg]);
    // The getMe call will fail for the fake bot token → exit 1.
    expect(exitCode).not.toBe(0);
  }, 20_000);

  test("--profile with an empty profile store exits 2", async () => {
    // Override XDG_CONFIG_HOME to an empty tmpdir so we don't touch the
    // developer's real ~/.config/torana during `bun test`. Phase 6b's
    // doctor path should report 'profile not found' cleanly.
    const xdg = mkdtempSync(join(tmpdir(), "torana-cli-empty-xdg-"));
    try {
      const { exitCode, stderr } = await runCli(
        ["doctor", "--profile", "prod"],
        { env: { XDG_CONFIG_HOME: xdg } },
      );
      expect(exitCode).toBe(2);
      expect(stderr).toMatch(
        /profile 'prod' not found|no profile store available/,
      );
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  }, 15_000);

  test("--server without --token exits 2", async () => {
    const { exitCode, stderr } = await runCli([
      "doctor",
      "--server",
      "http://127.0.0.1:0",
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("token");
  }, 15_000);
});
