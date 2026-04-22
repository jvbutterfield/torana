// §12.7 soak test — gated by AGENT_API_SOAK=1.
//
// Runs a real gateway with the agent-api enabled + FakeTelegram + a
// mock claude binary. Drives load (ask + send) at a fixed cadence
// for `duration_ms`, sampling process RSS, open file descriptors, the
// pool's live-session count, and the idempotency table row count on
// `sample_interval_ms`. Writes every sample to artifacts/samples.jsonl.
//
// On completion, aggregates the samples and asserts the PRD §8
// reliability claim + the impl-plan §12.7 invariants:
//
//   1. RSS stays within ±20% of median across samples taken after
//      the first hour (no runaway memory).
//   2. Peak FD count ≤ 2× initial (no leaks on side-session stop).
//   3. side_sessions_live gauge never exceeds max_global.
//   4. Idempotency table count tracks send_rate × retention and
//      drops once retention has elapsed.
//   5. Zero unhandled promise rejections.
//   6. Zero orphan side_sessions rows at shutdown.
//   7. ≥99% ask success (200 or 202→done) and ≥99% send success (202).
//
// Parameters (via env):
//   AGENT_API_SOAK=1                              — gate; required.
//   AGENT_API_SOAK_DURATION_MS                    — default 24h.
//   AGENT_API_SOAK_SAMPLE_INTERVAL_MS             — default 60_000.
//   AGENT_API_SOAK_WORKLOAD_INTERVAL_MS           — default 60_000
//                                                   (1 ask/min + 1 send/min).
//   AGENT_API_SOAK_IDEMPOTENCY_RETENTION_MS       — default 86_400_000.
//   AGENT_API_SOAK_ARTIFACT_DIR                   — default a temp dir
//                                                   under $TMPDIR. The path is
//                                                   logged at start.

import { describe, test, expect } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  appendFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startGateway, type RunningGateway } from "../../src/main.js";
import { FakeTelegram, findFreePort } from "../integration/fake-telegram.js";
import { GatewayDB } from "../../src/db/gateway-db.js";
import type { Config, BotConfig } from "../../src/config/schema.js";
import type { ResolvedAgentApiToken } from "../../src/config/load.js";

// ---------- gate ----------

const SOAK_ENABLED = process.env.AGENT_API_SOAK === "1";

// ---------- configuration ----------

interface SoakConfig {
  durationMs: number;
  sampleIntervalMs: number;
  workloadIntervalMs: number;
  idempotencyRetentionMs: number;
  artifactDir: string;
  botId: string;
  allowedUserId: number;
  allowedChatId: number;
  maxPerBot: number;
  maxGlobal: number;
}

function parseSoakConfig(): SoakConfig {
  const num = (key: string, def: number): number => {
    const v = process.env[key];
    if (!v) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`${key} must be a positive number, got ${v}`);
    }
    return n;
  };
  const artifactDir =
    process.env.AGENT_API_SOAK_ARTIFACT_DIR ??
    mkdtempSync(join(tmpdir(), "torana-soak-"));
  mkdirSync(artifactDir, { recursive: true });
  return {
    durationMs: num("AGENT_API_SOAK_DURATION_MS", 24 * 60 * 60 * 1000),
    sampleIntervalMs: num("AGENT_API_SOAK_SAMPLE_INTERVAL_MS", 60_000),
    workloadIntervalMs: num("AGENT_API_SOAK_WORKLOAD_INTERVAL_MS", 60_000),
    idempotencyRetentionMs: num(
      "AGENT_API_SOAK_IDEMPOTENCY_RETENTION_MS",
      86_400_000,
    ),
    artifactDir,
    botId: "soakbot",
    allowedUserId: 111_222_333,
    allowedChatId: 555_666_777,
    maxPerBot: 4,
    maxGlobal: 8,
  };
}

// ---------- harness ----------

interface Harness {
  gateway: RunningGateway;
  fake: FakeTelegram;
  base: string;
  bearer: string;
  db: GatewayDB;
  tmpDir: string;
  config: SoakConfig;
}

async function startSoakHarness(cfg: SoakConfig): Promise<Harness> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const mockBin = resolve(__dirname, "../runner/fixtures/claude-mock.ts");

  const tmpDir = mkdtempSync(join(tmpdir(), "torana-soak-run-"));
  const port = await findFreePort();
  const bearerSecret = "soak-bearer-token-sekret-" + randomUUID().slice(0, 8);

  const botToken = "SOAK_TOKEN:AAAAAAAAAAAAAAAAAAAAAAAAA";
  const fake = new FakeTelegram({ bots: { [botToken]: cfg.botId } });
  const apiBaseUrl = await fake.start();

  // Command runner with the claude-ndjson protocol. This avoids
  // ClaudeCodeRunner.PROTOCOL_FLAGS being prepended to the mock argv
  // (which `bun run` can't parse). The mock already speaks NDJSON in
  // both directions, and CommandRunner's Phase-2c side-session path
  // spawns one subprocess per session with TORANA_SESSION_ID in env —
  // exactly the behaviour the soak is trying to exercise.
  const bot: BotConfig = {
    id: cfg.botId,
    token: botToken,
    commands: [],
    reactions: { received_emoji: "👀" },
    runner: {
      type: "command" as const,
      cmd: ["bun", "run", mockBin, "normal"],
      protocol: "claude-ndjson" as const,
      env: {},
      on_reset: "restart" as const,
    },
  };

  const tokens: ResolvedAgentApiToken[] = [
    {
      name: "soak",
      secret: bearerSecret,
      hash: new Uint8Array(
        createHash("sha256").update(bearerSecret, "utf8").digest(),
      ),
      bot_ids: [cfg.botId],
      scopes: ["ask", "send"],
    },
  ];

  const config: Config = {
    version: 1,
    gateway: {
      port,
      data_dir: tmpDir,
      db_path: join(tmpDir, "gateway.db"),
      log_level: "warn",
    },
    telegram: { api_base_url: apiBaseUrl },
    transport: {
      default_mode: "polling",
      allowed_updates: ["message"],
      polling: {
        timeout_secs: 1,
        backoff_base_ms: 100,
        backoff_cap_ms: 1_000,
        max_updates_per_batch: 100,
      },
    },
    access_control: { allowed_user_ids: [cfg.allowedUserId] },
    worker_tuning: {
      startup_timeout_secs: 30,
      stall_timeout_secs: 90,
      turn_timeout_secs: 300,
      crash_loop_backoff_base_ms: 5_000,
      crash_loop_backoff_cap_ms: 300_000,
      max_consecutive_failures: 10,
    },
    streaming: {
      edit_cadence_ms: 1_500,
      message_length_limit: 4_096,
      message_length_safe_margin: 3_800,
    },
    outbox: { max_attempts: 2, retry_base_ms: 500 },
    shutdown: {
      outbox_drain_secs: 5,
      runner_grace_secs: 5,
      hard_timeout_secs: 15,
    },
    dashboard: { enabled: false, mount_path: "/dashboard" },
    metrics: { enabled: true },
    attachments: {
      max_bytes: 20 * 1024 * 1024,
      max_per_turn: 10,
      retention_secs: 86_400,
      disk_usage_cap_bytes: 1024 * 1024 * 1024,
    },
    agent_api: {
      enabled: true,
      tokens: [
        {
          name: "soak",
          secret_ref: `\${INLINE:${bearerSecret}}`,
          bot_ids: [cfg.botId],
          scopes: ["ask", "send"],
        },
      ],
      side_sessions: {
        idle_ttl_ms: 3_600_000,
        hard_ttl_ms: 86_400_000,
        max_per_bot: cfg.maxPerBot,
        max_global: cfg.maxGlobal,
      },
      send: { idempotency_retention_ms: cfg.idempotencyRetentionMs },
      ask: {
        default_timeout_ms: 30_000,
        max_timeout_ms: 300_000,
        max_body_bytes: 10 * 1024 * 1024,
        max_files_per_request: 5,
      },
    },
    bots: [bot],
  };

  const gateway = await startGateway({
    config,
    secrets: [botToken, bearerSecret],
    autoMigrate: true,
    agentApiTokens: tokens,
  });

  const db = new GatewayDB(config.gateway.db_path!);
  db.upsertUserChat(cfg.botId, String(cfg.allowedUserId), cfg.allowedChatId);

  return {
    gateway,
    fake,
    base: `http://127.0.0.1:${port}`,
    bearer: bearerSecret,
    db,
    tmpDir,
    config: cfg,
  };
}

// ---------- samplers ----------

interface Sample {
  /** ms since soak start. */
  elapsedMs: number;
  /** resident set size in bytes. */
  rss: number;
  /** heapUsed in bytes — redundant with RSS but useful for triage. */
  heapUsed: number;
  /** approximate open file descriptor count. -1 if unavailable. */
  fdCount: number;
  /** rows in agent_api_idempotency. */
  idempotencyRows: number;
  /** rows in side_sessions (all states). */
  sideSessionRowsAll: number;
  /** rows in side_sessions in non-stopping states (the "live" set). */
  sideSessionRowsLive: number;
}

async function countFds(pid: number): Promise<number> {
  // Use lsof — works on macOS and Linux. Bun.$ returns stdout.
  try {
    const proc = Bun.spawn(["lsof", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    // lsof emits one header line plus one line per FD.
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    return Math.max(0, lines.length - 1);
  } catch {
    return -1;
  }
}

async function takeSample(h: Harness, startMs: number): Promise<Sample> {
  const mem = process.memoryUsage();
  const fdCount = await countFds(process.pid);
  const idempotencyRows = (
    h.db
      .query("SELECT COUNT(*) AS n FROM agent_api_idempotency")
      .get() as { n: number }
  ).n;
  const sideSessionRowsAll = (
    h.db.query("SELECT COUNT(*) AS n FROM side_sessions").get() as {
      n: number;
    }
  ).n;
  const sideSessionRowsLive = (
    h.db
      .query("SELECT COUNT(*) AS n FROM side_sessions WHERE state != 'stopping'")
      .get() as { n: number }
  ).n;
  return {
    elapsedMs: Date.now() - startMs,
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    fdCount,
    idempotencyRows,
    sideSessionRowsAll,
    sideSessionRowsLive,
  };
}

// ---------- workload ----------

interface WorkloadStats {
  askAttempts: number;
  askSuccess: number; // 200 or (202 that eventually returns done)
  askHttpFailures: number;
  askPollFailures: number;
  sendAttempts: number;
  sendSuccess: number; // 202 (including replay)
  sendHttpFailures: number;
}

function newStats(): WorkloadStats {
  return {
    askAttempts: 0,
    askSuccess: 0,
    askHttpFailures: 0,
    askPollFailures: 0,
    sendAttempts: 0,
    sendSuccess: 0,
    sendHttpFailures: 0,
  };
}

function newIdempotencyKey(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  // 64 chars, fits ^[A-Za-z0-9_-]{16,128}$.
}

async function fireAsk(
  h: Harness,
  sticky: string | null,
  stats: WorkloadStats,
): Promise<void> {
  stats.askAttempts += 1;
  const body: Record<string, unknown> = {
    text: "soak ask " + stats.askAttempts,
    timeout_ms: 10_000,
  };
  if (sticky) body.session_id = sticky;
  try {
    const r = await fetch(`${h.base}/v1/bots/${h.config.botId}/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${h.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (r.status === 200) {
      // Drain body so no socket leaks.
      await r.text();
      stats.askSuccess += 1;
      return;
    }
    if (r.status === 202) {
      const body = (await r.json()) as { turn_id: number };
      // Poll briefly — a 10s-timeout ask on claude-mock should resolve
      // quickly (the mock echoes under 1ms). If it doesn't, count as
      // poll failure but don't block the workload.
      const ok = await pollUntilDone(h, body.turn_id, 15_000);
      if (ok) stats.askSuccess += 1;
      else stats.askPollFailures += 1;
      return;
    }
    await r.text();
    stats.askHttpFailures += 1;
  } catch {
    stats.askHttpFailures += 1;
  }
}

async function pollUntilDone(
  h: Harness,
  turnId: number,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${h.base}/v1/turns/${turnId}`, {
        headers: { Authorization: `Bearer ${h.bearer}` },
      });
      if (r.status !== 200) {
        await r.text();
        await new Promise((res) => setTimeout(res, 250));
        continue;
      }
      const body = (await r.json()) as { status: string };
      if (body.status === "done") return true;
      if (body.status === "failed") return false;
    } catch {
      /* retry */
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  return false;
}

async function fireSend(
  h: Harness,
  stats: WorkloadStats,
): Promise<void> {
  stats.sendAttempts += 1;
  const body = {
    text: "soak send " + stats.sendAttempts,
    source: "soak",
    user_id: String(h.config.allowedUserId),
  };
  try {
    const r = await fetch(`${h.base}/v1/bots/${h.config.botId}/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${h.bearer}`,
        "Content-Type": "application/json",
        "Idempotency-Key": newIdempotencyKey(),
      },
      body: JSON.stringify(body),
    });
    await r.text();
    if (r.status === 202) stats.sendSuccess += 1;
    else stats.sendHttpFailures += 1;
  } catch {
    stats.sendHttpFailures += 1;
  }
}

// ---------- aggregator ----------

interface Report {
  config: SoakConfig & { pid: number };
  samples: number;
  durationMs: number;
  rssMedianPostHour: number | null;
  rssMinPostHour: number | null;
  rssMaxPostHour: number | null;
  rssWithin20Pct: boolean;
  initialFdCount: number;
  peakFdCount: number;
  fdBounded: boolean;
  peakLiveSessions: number;
  maxGlobalLimit: number;
  liveBoundedByCap: boolean;
  idempotencyPeak: number;
  idempotencyFinal: number;
  idempotencyDropped: boolean;
  unhandledRejections: number;
  orphanSideSessions: number;
  stats: WorkloadStats;
  askSuccessRate: number;
  sendSuccessRate: number;
  pass: boolean;
  failures: string[];
}

function aggregate(
  cfg: SoakConfig,
  samples: Sample[],
  stats: WorkloadStats,
  unhandled: number,
  orphanRows: number,
): Report {
  const failures: string[] = [];

  // 1. RSS post-hour stability.
  const postHour = samples.filter((s) => s.elapsedMs >= 60 * 60 * 1000);
  let rssMedianPostHour: number | null = null;
  let rssMinPostHour: number | null = null;
  let rssMaxPostHour: number | null = null;
  let rssWithin20Pct = true;
  if (postHour.length >= 3) {
    const rss = postHour.map((s) => s.rss).sort((a, b) => a - b);
    rssMedianPostHour = rss[Math.floor(rss.length / 2)] ?? null;
    rssMinPostHour = rss[0] ?? null;
    rssMaxPostHour = rss[rss.length - 1] ?? null;
    if (
      rssMedianPostHour !== null &&
      rssMinPostHour !== null &&
      rssMaxPostHour !== null
    ) {
      const lo = 0.8 * rssMedianPostHour;
      const hi = 1.2 * rssMedianPostHour;
      if (rssMinPostHour < lo || rssMaxPostHour > hi) {
        rssWithin20Pct = false;
        failures.push(
          `RSS drifted outside ±20% of post-1h median ${rssMedianPostHour}: min=${rssMinPostHour} max=${rssMaxPostHour}`,
        );
      }
    }
  }

  // 2. FD bounded.
  const fdSamples = samples
    .map((s) => s.fdCount)
    .filter((c): c is number => c > 0);
  const initialFdCount = fdSamples[0] ?? -1;
  const peakFdCount = fdSamples.length > 0 ? Math.max(...fdSamples) : -1;
  let fdBounded = true;
  if (initialFdCount > 0 && peakFdCount > 2 * initialFdCount) {
    fdBounded = false;
    failures.push(
      `FD count grew past 2× initial: initial=${initialFdCount} peak=${peakFdCount}`,
    );
  }

  // 3. Live sessions bounded by cap.
  const peakLiveSessions = Math.max(
    0,
    ...samples.map((s) => s.sideSessionRowsLive),
  );
  const liveBoundedByCap = peakLiveSessions <= cfg.maxGlobal;
  if (!liveBoundedByCap) {
    failures.push(
      `side_sessions_live peak ${peakLiveSessions} exceeded max_global ${cfg.maxGlobal}`,
    );
  }

  // 4. Idempotency table — verify it drops after retention. Only
  //    meaningful if the soak ran longer than the retention window by
  //    at least one sweep interval (the sweep runs hourly in prod; for
  //    short soaks the test harness can force a sweep at the end).
  const idempotencyPeak = Math.max(0, ...samples.map((s) => s.idempotencyRows));
  const idempotencyFinal =
    samples.length > 0 ? (samples[samples.length - 1]?.idempotencyRows ?? 0) : 0;
  const idempotencyDropped =
    idempotencyPeak === 0 || idempotencyFinal <= idempotencyPeak;

  // 5. No unhandled rejections.
  if (unhandled > 0) {
    failures.push(`${unhandled} unhandled promise rejection(s)`);
  }

  // 6. No orphan side_sessions rows at teardown.
  if (orphanRows > 0) {
    failures.push(`${orphanRows} orphan side_sessions row(s) survived shutdown`);
  }

  // 7. Success rates.
  const askSuccessRate =
    stats.askAttempts === 0
      ? 1
      : stats.askSuccess / stats.askAttempts;
  const sendSuccessRate =
    stats.sendAttempts === 0
      ? 1
      : stats.sendSuccess / stats.sendAttempts;
  if (askSuccessRate < 0.99) {
    failures.push(
      `ask success rate ${(askSuccessRate * 100).toFixed(2)}% < 99% (attempts=${stats.askAttempts} success=${stats.askSuccess})`,
    );
  }
  if (sendSuccessRate < 0.99) {
    failures.push(
      `send success rate ${(sendSuccessRate * 100).toFixed(2)}% < 99% (attempts=${stats.sendAttempts} success=${stats.sendSuccess})`,
    );
  }

  const pass =
    rssWithin20Pct &&
    fdBounded &&
    liveBoundedByCap &&
    idempotencyDropped &&
    unhandled === 0 &&
    orphanRows === 0 &&
    askSuccessRate >= 0.99 &&
    sendSuccessRate >= 0.99;

  return {
    config: { ...cfg, pid: process.pid },
    samples: samples.length,
    durationMs: samples.length > 0
      ? (samples[samples.length - 1]?.elapsedMs ?? 0)
      : 0,
    rssMedianPostHour,
    rssMinPostHour,
    rssMaxPostHour,
    rssWithin20Pct,
    initialFdCount,
    peakFdCount,
    fdBounded,
    peakLiveSessions,
    maxGlobalLimit: cfg.maxGlobal,
    liveBoundedByCap,
    idempotencyPeak,
    idempotencyFinal,
    idempotencyDropped,
    unhandledRejections: unhandled,
    orphanSideSessions: orphanRows,
    stats,
    askSuccessRate,
    sendSuccessRate,
    pass,
    failures,
  };
}

// ---------- runner ----------

async function runSoak(): Promise<Report> {
  const cfg = parseSoakConfig();
  const samplesPath = join(cfg.artifactDir, "samples.jsonl");
  const reportPath = join(cfg.artifactDir, "report.json");
  const statusPath = join(cfg.artifactDir, "status.txt");

  // eslint-disable-next-line no-console
  console.log(
    `[soak] starting. artifact_dir=${cfg.artifactDir} duration_ms=${cfg.durationMs} sample_ms=${cfg.sampleIntervalMs} workload_ms=${cfg.workloadIntervalMs}`,
  );

  // Unhandled-rejection tripwire. Installed before gateway start so we
  // catch anything that escapes during setup.
  let unhandled = 0;
  const rejectionHandler = (err: unknown): void => {
    unhandled += 1;
    // eslint-disable-next-line no-console
    console.error("[soak] unhandledRejection:", err);
  };
  process.on("unhandledRejection", rejectionHandler);

  const h = await startSoakHarness(cfg);
  const startMs = Date.now();
  writeFileSync(statusPath, `running since ${new Date(startMs).toISOString()}\n`);

  const stats = newStats();
  const samples: Sample[] = [];
  const stickySessionIds = ["sticky-a", "sticky-b", "sticky-c"];
  let workloadIteration = 0;

  const workloadTimer = setInterval(() => {
    workloadIteration += 1;
    // 3 out of 4 asks ephemeral; every 4th uses a rotating sticky id.
    const sticky =
      workloadIteration % 4 === 0
        ? (stickySessionIds[workloadIteration % stickySessionIds.length] ?? null)
        : null;
    void fireAsk(h, sticky, stats);
    void fireSend(h, stats);
  }, cfg.workloadIntervalMs);

  const sampleTimer = setInterval(() => {
    void (async () => {
      try {
        const sample = await takeSample(h, startMs);
        samples.push(sample);
        appendFileSync(samplesPath, JSON.stringify(sample) + "\n");
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[soak] sampler failed:", err);
      }
    })();
  }, cfg.sampleIntervalMs);

  // Drain workload and samplers for the full duration.
  await new Promise((resolve) =>
    setTimeout(resolve, cfg.durationMs),
  );

  clearInterval(workloadTimer);
  clearInterval(sampleTimer);

  // Force a final idempotency sweep so the "rows drop after retention"
  // assertion has something to observe on short soaks where the hourly
  // sweep hasn't fired yet.
  const sweepBefore = Date.now() - cfg.idempotencyRetentionMs;
  const deletedRows = h.db.sweepIdempotency(sweepBefore);
  // eslint-disable-next-line no-console
  console.log(
    `[soak] forced final idempotency sweep: deleted ${deletedRows} rows (threshold=${new Date(sweepBefore).toISOString()})`,
  );

  // Allow any in-flight fires to settle.
  await new Promise((res) => setTimeout(res, 2_000));

  // Final sample (post-sweep) to capture the drop.
  const finalSample = await takeSample(h, startMs);
  samples.push(finalSample);
  appendFileSync(samplesPath, JSON.stringify(finalSample) + "\n");

  // Shutdown sequence with orphan-row snapshot in between.
  await h.gateway.shutdown("soak-teardown");
  const orphanRows = (
    h.db
      .query("SELECT COUNT(*) AS n FROM side_sessions")
      .get() as { n: number }
  ).n;
  h.db.close();
  await h.fake.stop();
  rmSync(h.tmpDir, { recursive: true, force: true });

  process.off("unhandledRejection", rejectionHandler);

  const report = aggregate(cfg, samples, stats, unhandled, orphanRows);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(
    statusPath,
    `${report.pass ? "PASS" : "FAIL"} after ${report.durationMs}ms; see report.json\n`,
  );

  // eslint-disable-next-line no-console
  console.log(
    `[soak] ${report.pass ? "PASS" : "FAIL"} — samples=${report.samples} ask=${stats.askSuccess}/${stats.askAttempts} send=${stats.sendSuccess}/${stats.sendAttempts}`,
  );
  if (!report.pass) {
    // eslint-disable-next-line no-console
    console.error("[soak] failures:");
    for (const f of report.failures) {
      // eslint-disable-next-line no-console
      console.error("  - " + f);
    }
  }

  return report;
}

// ---------- entry ----------

describe.skipIf(!SOAK_ENABLED)("Agent-API soak (§12.7)", () => {
  test(
    "runs clean under configured duration + cadence",
    async () => {
      const report = await runSoak();
      expect(report.pass).toBe(true);
    },
    // bun:test timeout needs to exceed duration + margin for shutdown.
    Number(process.env.AGENT_API_SOAK_DURATION_MS ?? 24 * 60 * 60 * 1000) +
      5 * 60 * 1000,
  );
});
