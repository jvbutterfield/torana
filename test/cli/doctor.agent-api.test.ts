// Doctor tests for Phase 7 (US-016) — C009..C014 local + R001..R003 remote.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDoctor, runRemoteDoctor } from "../../src/doctor.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { loadConfigFromFile } from "../../src/config/load.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ECHO_RUNNER = resolve(
  __dirname,
  "../integration/fixtures/test-runner.ts",
);

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-doctor-agentapi-"));
  applyMigrations(join(tmpDir, "gateway.db"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(body: string): string {
  const path = join(tmpDir, "torana.yaml");
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

function baseYaml(extra: string): string {
  return `
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
      cmd: ["bun", "${ECHO_RUNNER}"]
      protocol: jsonl-text
${extra}
`;
}

async function doctor(path: string) {
  const { config } = loadConfigFromFile(path);
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ ok: true, result: { id: 1 } }),
    )) as unknown as typeof fetch;
  return runDoctor({ config, configPath: path, fetchImpl });
}

describe("doctor — agent-api disabled", () => {
  test("all C009..C014 skip when agent_api not enabled", async () => {
    const cfg = writeConfig(baseYaml(""));
    const r = await doctor(cfg);
    for (const id of ["C009", "C010", "C011", "C012", "C013", "C014"]) {
      const c = r.checks.find((c) => c.id === id);
      expect(c?.status).toBe("skip");
    }
  });
});

describe("doctor — C009 enabled + no tokens", () => {
  test("warn when agent_api.enabled=true and tokens=[]", async () => {
    const cfg = writeConfig(
      baseYaml(`
agent_api:
  enabled: true
  tokens: []
`),
    );
    const r = await doctor(cfg);
    const c009 = r.checks.find((c) => c.id === "C009");
    expect(c009?.status).toBe("warn");
    expect(c009?.detail).toContain("no tokens");
  });

  test("ok when tokens list is non-empty", async () => {
    const cfg = writeConfig(
      baseYaml(`
agent_api:
  enabled: true
  tokens:
    - name: caller
      secret_ref: "super-secret-token-value-1234567890"
      bot_ids: ["alpha"]
      scopes: ["ask"]
`),
    );
    const r = await doctor(cfg);
    const c009 = r.checks.find((c) => c.id === "C009");
    expect(c009?.status).toBe("ok");
  });
});

describe("doctor — C011 ask scope + side-session support", () => {
  test("fail: ask scope on command runner w/ jsonl-text (no side-session support)", async () => {
    const cfg = writeConfig(
      baseYaml(`
agent_api:
  enabled: true
  tokens:
    - name: caller
      secret_ref: "super-secret-token-value-abcdefghij"
      bot_ids: ["alpha"]
      scopes: ["ask"]
`),
    );
    const r = await doctor(cfg);
    const c011 = r.checks.find((c) => c.id === "C011");
    expect(c011?.status).toBe("fail");
    expect(c011?.detail).toContain("alpha");
    // Command runner protocol is surfaced in the offender label so operators
    // can see the jsonl-text/claude-ndjson distinction.
    expect(c011?.detail).toContain("command/jsonl-text");
  });

  test("ok: ask scope on command runner w/ claude-ndjson protocol (Phase 2c)", async () => {
    const cfg = writeConfig(`
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
      cmd: ["bun", "${ECHO_RUNNER}"]
      protocol: claude-ndjson
agent_api:
  enabled: true
  tokens:
    - name: caller
      secret_ref: "super-secret-token-value-abcdefghij"
      bot_ids: ["alpha"]
      scopes: ["ask"]
`);
    const r = await doctor(cfg);
    const c011 = r.checks.find((c) => c.id === "C011");
    expect(c011?.status).toBe("ok");
  });

  test("ok: ask scope on command runner w/ codex-jsonl protocol (Phase 2c)", async () => {
    const cfg = writeConfig(`
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
      cmd: ["bun", "${ECHO_RUNNER}"]
      protocol: codex-jsonl
agent_api:
  enabled: true
  tokens:
    - name: caller
      secret_ref: "super-secret-token-value-abcdefghij"
      bot_ids: ["alpha"]
      scopes: ["ask"]
`);
    const r = await doctor(cfg);
    const c011 = r.checks.find((c) => c.id === "C011");
    expect(c011?.status).toBe("ok");
  });

  test("ok: send-only scope on command runner is fine", async () => {
    const cfg = writeConfig(
      baseYaml(`
agent_api:
  enabled: true
  tokens:
    - name: caller
      secret_ref: "super-secret-token-value-abcdefghij"
      bot_ids: ["alpha"]
      scopes: ["send"]
`),
    );
    const r = await doctor(cfg);
    const c011 = r.checks.find((c) => c.id === "C011");
    expect(c011?.status).toBe("ok");
  });

  test("ok: ask scope on claude-code runner", async () => {
    const cfg = writeConfig(`
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
      type: claude-code
      cli_path: bun
      acknowledge_dangerous: true
agent_api:
  enabled: true
  tokens:
    - name: caller
      secret_ref: "super-secret-token-value-abcdefghij"
      bot_ids: ["alpha"]
      scopes: ["ask"]
`);
    const r = await doctor(cfg);
    const c011 = r.checks.find((c) => c.id === "C011");
    expect(c011?.status).toBe("ok");
  });
});

describe("doctor — C013 TTL invariants (defence-in-depth)", () => {
  test("ok when TTL invariants hold", async () => {
    const cfg = writeConfig(
      baseYaml(`
agent_api:
  enabled: true
  tokens:
    - name: caller
      secret_ref: "super-secret-token-value-abcdefghij"
      bot_ids: ["alpha"]
      scopes: ["send"]
  side_sessions:
    idle_ttl_ms: 3600000
    hard_ttl_ms: 86400000
    max_per_bot: 4
    max_global: 8
`),
    );
    const r = await doctor(cfg);
    const c013 = r.checks.find((c) => c.id === "C013");
    expect(c013?.status).toBe("ok");
  });
});

describe("doctor — C014 deployment notice", () => {
  test("warn when enabled with tokens, reminding about network controls", async () => {
    const cfg = writeConfig(
      baseYaml(`
agent_api:
  enabled: true
  tokens:
    - name: caller
      secret_ref: "super-secret-token-value-abcdefghij"
      bot_ids: ["alpha"]
      scopes: ["send"]
`),
    );
    const r = await doctor(cfg);
    const c014 = r.checks.find((c) => c.id === "C014");
    expect(c014?.status).toBe("warn");
    expect(c014?.detail).toMatch(/TLS|firewall|reverse proxy/);
  });
});

// --- Remote doctor (R001..R003) ---

describe("remote doctor — R001..R003", () => {
  test("R001 ok + R002 ok with non-empty bot list + R003 skip on http://", async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/v1/health")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (u.endsWith("/v1/bots")) {
        return new Response(
          JSON.stringify({
            bots: [
              {
                bot_id: "alpha",
                runner_type: "claude-code",
                supports_side_sessions: true,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const r = await runRemoteDoctor({
      server: "http://gateway.invalid",
      token: "tok",
      fetchImpl,
    });
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c] as const));
    expect(byId.R001.status).toBe("ok");
    expect(byId.R002.status).toBe("ok");
    expect(byId.R002.detail).toContain("1 bot");
    expect(byId.R003.status).toBe("skip");
  });

  test("R001 fail when /v1/health returns 503", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/v1/health"))
        return new Response("nope", { status: 503 });
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await runRemoteDoctor({
      server: "http://gateway.invalid",
      token: "tok",
      fetchImpl,
    });
    const r001 = r.checks.find((c) => c.id === "R001");
    expect(r001?.status).toBe("fail");
    expect(r001?.detail).toContain("503");
  });

  test("R002 fail when token returns 401", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/v1/health")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (u.endsWith("/v1/bots")) {
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
        });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const r = await runRemoteDoctor({
      server: "http://gateway.invalid",
      token: "bad",
      fetchImpl,
    });
    const r002 = r.checks.find((c) => c.id === "R002");
    expect(r002?.status).toBe("fail");
    expect(r002?.detail).toContain("401");
  });

  test("R002 warn when token authorizes zero bots", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/v1/health")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (u.endsWith("/v1/bots")) {
        return new Response(JSON.stringify({ bots: [] }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const r = await runRemoteDoctor({
      server: "http://gateway.invalid",
      token: "scoped-to-nothing",
      fetchImpl,
    });
    const r002 = r.checks.find((c) => c.id === "R002");
    expect(r002?.status).toBe("warn");
    expect(r002?.detail).toContain("empty");
  });

  test("R003 ok on https:// when TLS handshake succeeds", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, bots: [] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const r = await runRemoteDoctor({
      server: "https://gateway.invalid",
      token: "tok",
      fetchImpl,
    });
    const r003 = r.checks.find((c) => c.id === "R003");
    expect(r003?.status).toBe("ok");
  });

  test("R003 fail on https:// when fetch throws", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) {
        // R001 probe — succeed
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (call === 2) {
        // R002 probe — succeed so we reach R003
        return new Response(JSON.stringify({ bots: [{}] }), { status: 200 });
      }
      // R003 re-probe — throw
      throw new Error("self-signed certificate");
    }) as unknown as typeof fetch;
    const r = await runRemoteDoctor({
      server: "https://gateway.invalid",
      token: "tok",
      fetchImpl,
    });
    const r003 = r.checks.find((c) => c.id === "R003");
    expect(r003?.status).toBe("fail");
    expect(r003?.detail).toContain("self-signed");
  });

  test("R001 fail when the request times out", async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        // Hang until aborted
        (init?.signal as AbortSignal | undefined)?.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
        );
      });
    }) as unknown as typeof fetch;
    const r = await runRemoteDoctor({
      server: "http://gateway.invalid",
      token: "tok",
      timeoutMs: 50,
      fetchImpl,
    });
    const r001 = r.checks.find((c) => c.id === "R001");
    expect(r001?.status).toBe("fail");
  });
});

// --- Subprocess round-trip: `torana doctor --server` against a live server.
//
// Mocks a minimal /v1/health + /v1/bots HTTP surface with Bun.serve, then
// spawns the real CLI binary. Catches bugs in argv parsing, credential
// resolution, JSON output formatting, and the integration between the CLI
// dispatcher and `runRemoteDoctor` that unit tests can't see.

describe("subprocess: torana doctor --server URL --token TOK", () => {
  const CLI_ENTRY = resolve(__dirname, "../../src/cli.ts");

  async function runCli(
    args: string[],
    env: Record<string, string> = {},
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

  async function mockGateway(opts: {
    health: Response | (() => Response);
    bots: Response | ((req: Request) => Response);
  }): Promise<{ url: string; stop: () => void }> {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/v1/health") {
          return typeof opts.health === "function"
            ? opts.health()
            : opts.health.clone();
        }
        if (u.pathname === "/v1/bots") {
          return typeof opts.bots === "function"
            ? opts.bots(req)
            : opts.bots.clone();
        }
        return new Response("not found", { status: 404 });
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}`,
      stop: () => server.stop(true),
    };
  }

  test("happy path: both R001 and R002 succeed; exit 0; text output", async () => {
    const gw = await mockGateway({
      health: new Response(
        JSON.stringify({
          ok: true,
          version: "test",
          agent_api_enabled: true,
          uptime_secs: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      bots: new Response(
        JSON.stringify({
          bots: [
            {
              bot_id: "alpha",
              runner_type: "claude-code",
              supports_side_sessions: true,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });
    try {
      const { stdout, exitCode } = await runCli([
        "doctor",
        "--server",
        gw.url,
        "--token",
        "tok",
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("[ ok ] R001");
      expect(stdout).toContain("[ ok ] R002");
      // http:// so R003 skips.
      expect(stdout).toContain("[skip] R003");
      // R002 detail includes the bot count so a typo in the bots-list
      // filter would be caught here end-to-end.
      expect(stdout).toContain("1 bot");
    } finally {
      gw.stop();
    }
  }, 15_000);

  test("R001 fail: exit 1; stdout still includes R002/R003 attempts", async () => {
    const gw = await mockGateway({
      health: new Response("nope", { status: 503 }),
      bots: new Response(JSON.stringify({ bots: [] }), { status: 200 }),
    });
    try {
      const { stdout, exitCode } = await runCli([
        "doctor",
        "--server",
        gw.url,
        "--token",
        "tok",
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain("[fail] R001");
      expect(stdout).toMatch(/R001.*503/);
    } finally {
      gw.stop();
    }
  }, 15_000);

  test("env vars TORANA_SERVER + TORANA_TOKEN stand in for flags", async () => {
    const gw = await mockGateway({
      health: new Response(JSON.stringify({ ok: true }), { status: 200 }),
      bots: new Response(JSON.stringify({ bots: [{ bot_id: "x" }] }), {
        status: 200,
      }),
    });
    try {
      const { stdout, exitCode } = await runCli(["doctor"], {
        TORANA_SERVER: gw.url,
        TORANA_TOKEN: "tok",
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("[ ok ] R001");
      expect(stdout).toContain("[ ok ] R002");
    } finally {
      gw.stop();
    }
  }, 15_000);

  test("--format json emits a parseable JSON body with all three R-check ids", async () => {
    const gw = await mockGateway({
      health: new Response(JSON.stringify({ ok: true }), { status: 200 }),
      bots: new Response(JSON.stringify({ bots: [{ bot_id: "x" }] }), {
        status: 200,
      }),
    });
    try {
      const { stdout, exitCode } = await runCli([
        "doctor",
        "--server",
        gw.url,
        "--token",
        "tok",
        "--format",
        "json",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      const ids = (parsed.checks as Array<{ id: string }>).map((c) => c.id);
      expect(ids).toContain("R001");
      expect(ids).toContain("R002");
      expect(ids).toContain("R003");
    } finally {
      gw.stop();
    }
  }, 15_000);

  test("R002 received 401: token rejection is visible in stderr output", async () => {
    const gw = await mockGateway({
      health: new Response(JSON.stringify({ ok: true }), { status: 200 }),
      bots: new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
      }),
    });
    try {
      const { stdout, exitCode } = await runCli([
        "doctor",
        "--server",
        gw.url,
        "--token",
        "wrong",
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain("[ ok ] R001");
      expect(stdout).toContain("[fail] R002");
      expect(stdout).toMatch(/R002.*401/);
    } finally {
      gw.stop();
    }
  }, 15_000);
});
