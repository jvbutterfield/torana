// Evidence capture for the Desktop-managed agent rollout drills (plan Phase 7).
//
// The G5 claim is falsifiable and is meant to be tested as such: create, edit,
// start, stop, and delete an agent entirely from Buzz Desktop, with a written
// record that **no Railway-side action occurred**. A drill whose evidence is a
// human pasting JSON into a document proves less than it looks like it does —
// the timestamps are wrong, the intermediate states are missing, and nobody can
// tell afterwards whether a step was observed or assumed.
//
// So this tool takes the snapshot. It runs from a laptop against the **public
// edge**, using only the admin token the Desktop provider already uses. That is
// the point: everything it can see is something the drill was allowed to use.
// It never writes — no staging, no restore, no purge — because an instrument
// that can mutate the thing it measures is not evidence.
//
//   bun run managed-agent-drill.ts snapshot --label "01-before-create"
//   bun run managed-agent-drill.ts watch --agent canary --until staged_delete
//
// Env: TORANA_DRILL_URL, plus TORANA_DRILL_TOKEN or the deployment's own
// TORANA_ADMIN_TOKEN_BUZZ_MANAGED_AGENTS (so `railway run` works). Artifacts in
// `--out` (default ./drill-evidence) as one JSON file per snapshot.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface AgentRow {
  agent_id: string;
  pubkey: string;
  harness: string;
  lifecycle: string;
  instruction_version: string;
  staged_at: string | null;
  purge_deadline: string | null;
  endpoint_id: string | null;
  endpoint_state: string | null;
  connected: boolean | null;
}

interface Snapshot {
  label: string;
  capturedAt: string;
  gateway: string;
  agents: AgentRow[];
  reconciliation: unknown;
  /** Non-fatal problems, so a partial snapshot is still usable evidence. */
  notes: string[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(64);
  }
  return value;
}

/**
 * The admin bearer, from whichever name the environment already uses.
 *
 * `TORANA_ADMIN_TOKEN_BUZZ_MANAGED_AGENTS` is the deployment's own variable
 * name, which means the drill can be run as
 *
 *   railway run bun run drill snapshot --label 01-before-create
 *
 * with the value injected from the service and never copied, echoed, or typed.
 * That matters more here than in most tools: the point of this one is to
 * produce trustworthy evidence, and a procedure whose first step is "paste the
 * production admin token into your shell" invites exactly the accident that
 * makes the evidence untrustworthy. `TORANA_DRILL_TOKEN` stays supported for
 * running against a gateway Railway does not know about.
 */
function adminToken(): string {
  return (
    process.env.TORANA_DRILL_TOKEN ||
    process.env.TORANA_ADMIN_TOKEN_BUZZ_MANAGED_AGENTS ||
    requireEnv("TORANA_DRILL_TOKEN")
  );
}

/**
 * One authenticated GET. `error` is non-null exactly when `body` is null, kept
 * as two fields rather than a union so the caller reads both without narrowing
 * ceremony in a script this small.
 */
interface Fetched {
  body: unknown;
  error: string | null;
}

async function get(
  base: string,
  token: string,
  path: string,
): Promise<Fetched> {
  try {
    const res = await fetch(new URL(path, base), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    if (!res.ok) {
      // 404 here is the single most informative failure in this whole drill: it
      // means the edge allowlist does not carry this route, not that the agent
      // is missing. Say so rather than reporting an empty fleet.
      return {
        body: null,
        error:
          res.status === 404
            ? `${path} returned 404 — the edge proxy allowlist is probably missing this route`
            : `${path} returned ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    return { body: JSON.parse(text), error: null };
  } catch (error) {
    return {
      body: null,
      error: `${path} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function snapshot(label: string): Promise<Snapshot> {
  const base = requireEnv("TORANA_DRILL_URL");
  const token = adminToken();
  const notes: string[] = [];

  const agents = await get(base, token, "/v1/admin/buzz/agents");
  if (agents.error) notes.push(agents.error);
  const report = await get(base, token, "/v1/admin/buzz/reconciliation");
  if (report.error) notes.push(report.error);

  return {
    label,
    capturedAt: new Date().toISOString(),
    gateway: base,
    agents: (agents.body as { agents?: AgentRow[] } | null)?.agents ?? [],
    reconciliation: report.body,
    notes,
  };
}

function write(outDir: string, snap: Snapshot): string {
  mkdirSync(outDir, { recursive: true });
  const safe = snap.label.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const path = join(outDir, `${safe}.json`);
  writeFileSync(path, `${JSON.stringify(snap, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function summarize(snap: Snapshot): void {
  for (const agent of snap.agents) {
    const staged =
      agent.lifecycle === "staged_delete"
        ? ` purge_at=${agent.purge_deadline ?? "?"}`
        : "";
    console.log(
      `  ${agent.agent_id}\t${agent.lifecycle}\tversion=${agent.instruction_version}` +
        `\tendpoint=${agent.endpoint_state ?? "-"}\tconnected=${agent.connected ?? "-"}${staged}`,
    );
  }
  if (snap.agents.length === 0) console.log("  (no Desktop-managed agents)");
  for (const note of snap.notes) console.log(`  ! ${note}`);
}

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
}

const argv = process.argv.slice(2);
const command = argv[0] ?? "";
const outDir = flag(argv, "out") ?? "./drill-evidence";

if (command === "snapshot") {
  const label = flag(argv, "label") ?? new Date().toISOString();
  const snap = await snapshot(label);
  const path = write(outDir, snap);
  console.log(`[${snap.label}] ${snap.capturedAt}`);
  summarize(snap);
  console.log(`written: ${path}`);
  // A snapshot that could not read the fleet is not a passing drill step.
  process.exit(snap.notes.length === 0 ? 0 : 1);
} else if (command === "watch") {
  // Poll one agent until it reaches an expected lifecycle. The drill's delete
  // step has a real latency budget (R14.3: staging starts ≤ 10 s after relay
  // delivery), and "I refreshed until it changed" is not a measurement.
  const agentId = flag(argv, "agent");
  const until = flag(argv, "until") ?? "staged_delete";
  const timeoutSecs = Number(flag(argv, "timeout") ?? "120");
  if (!agentId) {
    console.error("watch requires --agent <id>");
    process.exit(64);
  }
  const startedAt = Date.now();
  const deadline = startedAt + timeoutSecs * 1000;
  let last = "";
  for (;;) {
    const snap = await snapshot(`watch-${agentId}`);
    const row = snap.agents.find((item) => item.agent_id === agentId);
    const state = row?.lifecycle ?? "(absent)";
    if (state !== last) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`+${elapsed}s ${agentId} → ${state}`);
      last = state;
    }
    if (state === until) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const path = write(outDir, {
        ...snap,
        label: `watch-${agentId}-${until}`,
      });
      console.log(`reached ${until} after ${elapsed}s; written: ${path}`);
      process.exit(0);
    }
    if (Date.now() > deadline) {
      console.error(
        `timed out after ${timeoutSecs}s waiting for ${agentId} → ${until} (last: ${state})`,
      );
      write(outDir, { ...snap, label: `watch-${agentId}-TIMEOUT` });
      process.exit(1);
    }
    await Bun.sleep(2000);
  }
} else {
  console.error(
    "usage:\n" +
      "  managed-agent-drill.ts snapshot --label <name> [--out <dir>]\n" +
      "  managed-agent-drill.ts watch --agent <id> [--until <lifecycle>] [--timeout <secs>] [--out <dir>]\n" +
      "\nenv: TORANA_DRILL_URL, and TORANA_DRILL_TOKEN or " +
      "TORANA_ADMIN_TOKEN_BUZZ_MANAGED_AGENTS",
  );
  process.exit(64);
}
