// Analyze a production presence watch.
//
// Collect samples from inside the deployment container, one line per sample:
//
//   railway ssh "for i in \$(seq 1 30); do \
//     curl -s http://127.0.0.1:3001/health | python3 -c 'import sys,json,time;\
//       d=json.load(sys.stdin);print(int(time.time()*1000),json.dumps(\
//       [[e[\"endpoint_id\"],e[\"presence\"][\"last_published_at\"],\
//         e[\"presence\"][\"consecutive_failures\"],e[\"presence\"][\"stale\"],\
//         e[\"connected\"],e[\"runtime_state\"]] \
//        for e in d[\"endpoints\"] if e.get(\"presence\")]))'; \
//     sleep 8; done" > samples.txt
//
//   bun run spike/buzz-transport/presence-watch.ts samples.txt
//
// **Poll faster than the heartbeat.** At a 60 s poll against a 30 s heartbeat
// each sample sees the newest publish two refreshes on, so the apparent gap
// collapses to the poll period and reads as a doubled cadence. That misreading
// happened once already; the analyzer now detects the condition and falls back
// to the staleness bound, but sampling correctly is better than being warned.
//
// Two different measures, easy to conflate:
//   - refresh gap: distance between successive accepted publishes. The cadence
//     the relay sees, and what must stay well under the 180 s TTL.
//   - observed staleness: how old the newest publish was when sampled. Bounded
//     by gap + poll interval, so weaker — but meaningful at any sampling rate,
//     and it still catches a heartbeat that stops entirely.

export {};

const TTL_MS = 180_000;
const path = Bun.argv[2];
if (!path) {
  console.error("usage: bun run presence-watch.ts <samples.txt>");
  process.exit(2);
}

const lines = (await Bun.file(path).text())
  .split("\n")
  .filter((line) => /^\d{13} \[/.test(line));

interface Sample {
  at: number;
  rows: Array<[string, number | null, number, boolean, boolean, string]>;
}
const samples: Sample[] = lines.map((line) => {
  const space = line.indexOf(" ");
  return {
    at: Number(line.slice(0, space)),
    rows: JSON.parse(line.slice(space + 1)),
  };
});

if (samples.length === 0) {
  console.error("no parseable samples");
  process.exit(1);
}

const windowMs = samples.at(-1)!.at - samples[0]!.at;
console.log(
  `samples: ${samples.length}   window: ${(windowMs / 60000).toFixed(1)} min`,
);
console.log();

const endpoints = [...new Set(samples.flatMap((s) => s.rows.map((r) => r[0])))];
let worstGap = 0;
let worstLag = 0;
let anyStale = false;
let anyDisconnect = false;
let anyFailure = false;

console.log(
  "endpoint            refreshes  gap min/mean/max (s)   lag max (s)  stale  failures  states",
);
for (const id of endpoints) {
  const published: number[] = [];
  const lags: number[] = [];
  const states = new Set<string>();
  let maxFailures = 0;
  let stale = false;
  for (const sample of samples) {
    const row = sample.rows.find((r) => r[0] === id);
    if (!row) continue;
    const [, lastAt, fails, isStale, connected, state] = row;
    states.add(`${state}${connected ? "" : "/disconnected"}`);
    maxFailures = Math.max(maxFailures, fails);
    if (isStale) stale = anyStale = true;
    if (fails > 0) anyFailure = true;
    if (!connected) anyDisconnect = true;
    if (lastAt !== null) {
      if (published.at(-1) !== lastAt) published.push(lastAt);
      lags.push(sample.at - lastAt);
    }
  }
  const gaps: number[] = [];
  for (let i = 1; i < published.length; i++) {
    gaps.push(published[i]! - published[i - 1]!);
  }
  const max = Math.max(...gaps, 0);
  const maxLag = Math.max(...lags, 0);
  worstGap = Math.max(worstGap, max);
  worstLag = Math.max(worstLag, maxLag);
  const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  console.log(
    `${id.padEnd(20)}${String(published.length).padStart(6)}   ` +
      `${(Math.min(...gaps, Infinity) / 1000).toFixed(1)}/${(mean / 1000).toFixed(1)}/${(max / 1000).toFixed(1)}`.padEnd(
        22,
      ) +
      `${(maxLag / 1000).toFixed(1)}`.padStart(9) +
      `${stale ? "  YES" : "   no"}` +
      `${String(maxFailures).padStart(10)}` +
      `  ${[...states].join(",")}`,
  );
}

console.log();
const intervalMs = samples.length > 1 ? windowMs / (samples.length - 1) : 0;
const aliased = worstGap > 0 && intervalMs > 0 && worstGap <= intervalMs * 1.15;
console.log(
  `worst refresh gap across all endpoints: ${(worstGap / 1000).toFixed(1)} s`,
);
console.log(
  `margin against the relay's ${TTL_MS / 1000} s presence TTL: ${((TTL_MS - worstGap) / 1000).toFixed(1)} s`,
);
console.log(
  `worst observed staleness (bounds the true refresh gap): ${(worstLag / 1000).toFixed(1)} s`,
);
if (aliased) {
  console.log(
    `note: the poll interval (${(intervalMs / 1000).toFixed(1)} s) is not faster than the\n` +
      `      refresh cadence, so the gap column is aliased to the poll period. Read the\n` +
      `      staleness figure, or re-sample faster to measure the gap directly.`,
  );
}
const clean = !anyStale && !anyFailure && !anyDisconnect;
const bound = aliased ? worstLag : worstGap;
console.log(
  `verdict: ${
    worstGap === 0
      ? "INCOMPLETE — not enough samples to measure a refresh gap"
      : clean && bound < 60_000
        ? "PASS — every endpoint refreshed continuously, none went stale, none disconnected"
        : clean
          ? `REVIEW — no failures, but the worst measured bound (${(bound / 1000).toFixed(1)} s) exceeded the 60 s budget`
          : "FAIL — an endpoint went stale, disconnected, or failed a publish"
  }`,
);
