// US-030 — doctor C030..C033 for Desktop-managed (provisioned) agents.
//
// Each check is exercised in every state it can reach, because the states are
// the point: a check that only ever reports "ok" on a healthy box tells an
// operator nothing on the day a harness disappears or a volume comes back
// empty.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../src/doctor.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { loadConfigFromFile } from "../../src/config/load.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "torana-doctor-prov-"));
  dbPath = join(tmpDir, "gateway.db");
  applyMigrations(dbPath);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(provisioningBlock: string): string {
  const path = join(tmpDir, "torana.yaml");
  writeFileSync(
    path,
    `
version: 2
gateway:
  port: 3000
  bind_host: 127.0.0.1
  data_dir: ${tmpDir}
  db_path: ${dbPath}
platforms:
  telegram: { enabled: false, delivery: { default_mode: polling } }
  buzz: { enabled: false }
access_control: { default_policy: deny, allowed_user_ids: [] }
sessions: { scope: conversation }
limits: {}
retention: {}
worker_tuning: {}
streaming: {}
outbox: {}
shutdown: {}
dashboard: {}
metrics: { enabled: true }
attachments: {}
agent_api: { enabled: false, tokens: [] }
${provisioningBlock}
agents:
  - id: buzzbot
    runner: { type: codex, cli_path: codex }
    endpoints:
      - id: buzzbot-buzz
        platform: buzz
        enabled: false
        community_id: primary
        relay_url: wss://relay.example
        private_key: '0000000000000000000000000000000000000000000000000000000000000001'
        owner_pubkey: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
        respond_to: owner_only
        subscribe: mentions_and_dms
`,
    { mode: 0o600 },
  );
  return path;
}

/** A harness whose binary certainly exists on any machine running this suite. */
function provisioningYaml(cliPath = "/bin/sh"): string {
  return `
provisioning:
  max_agents: 4
  delete_grace_hours: 72
  harnesses:
    claude:
      runner:
        type: claude-code
        cli_path: ${cliPath}
        args: ["--model", "{model}"]
      ceilings:
        turn_timeout_secs: 3600
        idle_timeout_secs: 86400
        max_turn_duration_secs: 3600
`;
}

async function doctor(path: string) {
  const { config, normalized } = loadConfigFromFile(path);
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ ok: true, result: { id: 1 } }),
    )) as unknown as typeof fetch;
  return runDoctor({ config, configPath: path, fetchImpl, normalized });
}

function insertAgent(
  overrides: {
    agentId?: string;
    harness?: string;
    lifecycle?: string;
    stagedAt?: string | null;
    purgeDeadline?: string | null;
  } = {},
): void {
  const {
    agentId = "canary",
    harness = "claude",
    lifecycle = "active",
    stagedAt = null,
    purgeDeadline = null,
  } = overrides;
  const db = new Database(dbPath);
  db.query(
    `INSERT INTO provisioned_agents
       (agent_id, derived_pubkey, harness, timeouts_json, instruction_version,
        lifecycle, staged_at, purge_deadline, provisioned_by)
     VALUES (?, ?, ?, '{}', 'abc123def456', ?, ?, ?, 'provisioner')`,
  ).run(agentId, `pub-${agentId}`, harness, lifecycle, stagedAt, purgeDeadline);
  db.close();
}

function makeWorkspace(agentId: string): void {
  mkdirSync(join(tmpDir, "workspaces", agentId), {
    recursive: true,
    mode: 0o700,
  });
}

function check(
  checks: Array<{ id: string; status: string; detail: string }>,
  id: string,
) {
  return checks.find((c) => c.id === id);
}

describe("doctor — provisioning not configured", () => {
  test("C030..C033 all skip", async () => {
    const result = await doctor(writeConfig(""));
    for (const id of ["C030", "C031", "C032", "C033"]) {
      expect(check(result.checks, id)?.status).toBe("skip");
      expect(check(result.checks, id)?.detail).toContain("not configured");
    }
  });
});

describe("doctor — C030 harness binaries", () => {
  test("ok when every allowlisted harness resolves", async () => {
    const result = await doctor(writeConfig(provisioningYaml("/bin/sh")));
    const c030 = check(result.checks, "C030");
    expect(c030?.status).toBe("ok");
    expect(c030?.detail).toContain("1 allowlisted harness");
  });

  test("fails, naming the harness, when the binary is absent", async () => {
    const missing = join(tmpDir, "definitely-not-here");
    const result = await doctor(writeConfig(provisioningYaml(missing)));
    const c030 = check(result.checks, "C030");
    expect(c030?.status).toBe("fail");
    expect(c030?.detail).toContain("claude");
    expect(c030?.detail).toContain("not found");
  });

  test("fails when the harness path is a directory rather than a file", async () => {
    const result = await doctor(writeConfig(provisioningYaml(tmpDir)));
    const c030 = check(result.checks, "C030");
    expect(c030?.status).toBe("fail");
    expect(c030?.detail).toContain("not a file");
  });
});

describe("doctor — C031 provisioned agent rows", () => {
  test("skips when no agents are provisioned (C004 precedent)", async () => {
    const result = await doctor(writeConfig(provisioningYaml()));
    const c031 = check(result.checks, "C031");
    expect(c031?.status).toBe("skip");
    expect(c031?.detail).toContain("no provisioned agents");
  });

  test("ok when the harness is allowlisted and the workspace exists", async () => {
    insertAgent();
    makeWorkspace("canary");
    const result = await doctor(writeConfig(provisioningYaml()));
    expect(check(result.checks, "C031")?.status).toBe("ok");
  });

  test("fails when the workspace directory is gone", async () => {
    // A restored volume that lost `workspaces/` leaves rows pointing at
    // nothing; the agent would start with an empty working directory.
    insertAgent();
    const result = await doctor(writeConfig(provisioningYaml()));
    const c031 = check(result.checks, "C031");
    expect(c031?.status).toBe("fail");
    expect(c031?.detail).toContain("workspace missing");
  });

  test("fails when the row's harness is no longer allowlisted", async () => {
    insertAgent({ harness: "goose" });
    makeWorkspace("canary");
    const result = await doctor(writeConfig(provisioningYaml()));
    const c031 = check(result.checks, "C031");
    expect(c031?.status).toBe("fail");
    expect(c031?.detail).toContain("no longer allowlisted");
  });
});

describe("doctor — C032 tombstone cursors", () => {
  test("skips when no cursor has been recorded", async () => {
    const result = await doctor(writeConfig(provisioningYaml()));
    expect(check(result.checks, "C032")?.status).toBe("skip");
  });

  test("ok for a cursor at a sane time", async () => {
    const db = new Database(dbPath);
    db.query(
      "INSERT INTO buzz_tombstone_cursors (relay_url, last_created_at) VALUES (?, ?)",
    ).run("wss://relay.example", Math.floor(Date.now() / 1000) - 60);
    db.close();
    const result = await doctor(writeConfig(provisioningYaml()));
    expect(check(result.checks, "C032")?.status).toBe("ok");
  });

  test("warns on a cursor ahead of the local clock", async () => {
    // A future cursor silently narrows every backfill window, so a missed
    // tombstone would never be recovered.
    const db = new Database(dbPath);
    db.query(
      "INSERT INTO buzz_tombstone_cursors (relay_url, last_created_at) VALUES (?, ?)",
    ).run("wss://relay.example", Math.floor(Date.now() / 1000) + 86_400);
    db.close();
    const result = await doctor(writeConfig(provisioningYaml()));
    const c032 = check(result.checks, "C032");
    expect(c032?.status).toBe("warn");
    expect(c032?.detail).toContain("ahead of the local clock");
  });
});

describe("doctor — C033 staged deletions", () => {
  test("ok when nothing is staged", async () => {
    insertAgent();
    makeWorkspace("canary");
    const result = await doctor(writeConfig(provisioningYaml()));
    expect(check(result.checks, "C033")?.status).toBe("ok");
  });

  test("warns and names the deadline while a deletion is staged", async () => {
    insertAgent({
      lifecycle: "staged_delete",
      stagedAt: "2026-08-08T00:00:00Z",
      purgeDeadline: "2026-08-11T00:00:00Z",
    });
    makeWorkspace("canary");
    const result = await doctor(writeConfig(provisioningYaml()));
    const c033 = check(result.checks, "C033");
    expect(c033?.status).toBe("warn");
    expect(c033?.detail).toContain("canary@2026-08-11T00:00:00Z");
  });
});
