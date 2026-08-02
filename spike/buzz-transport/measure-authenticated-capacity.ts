export {};

type Runner = "claude" | "codex";

type Measurement = {
  runner: Runner;
  requested: number;
  succeeded: number;
  durationMs: number;
  peakProcessCount: number;
  peakTotalRssKiB: number;
  peakRssKiBPerInvocation: number;
  peakFdCount: number | null;
  peakFdCountPerInvocation: number | null;
};

const requestedCounts = (process.env.CAPACITY_COUNTS ?? "1,2,8,32")
  .split(",")
  .map(Number);
if (
  requestedCounts.length === 0 ||
  requestedCounts.some(
    (count) => !Number.isSafeInteger(count) || count < 1 || count > 32,
  )
) {
  throw new Error("CAPACITY_COUNTS must contain integers from 1 through 32");
}

const selectedRunners = (process.env.CAPACITY_RUNNERS ?? "claude,codex")
  .split(",")
  .map((value) => value.trim()) as Runner[];
if (
  selectedRunners.length === 0 ||
  selectedRunners.some((runner) => runner !== "claude" && runner !== "codex")
) {
  throw new Error("CAPACITY_RUNNERS must contain claude and/or codex");
}

function command(runner: Runner): string[] {
  if (runner === "claude") {
    return [
      Bun.which("claude") ?? "claude",
      "--print",
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--model",
      "haiku",
      "--output-format",
      "json",
      "Reply exactly: CAPACITY_OK",
    ];
  }
  return [
    Bun.which("codex") ?? "codex",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "Reply exactly: CAPACITY_OK",
  ];
}

async function processSnapshot(): Promise<
  Map<number, { parent: number; rssKiB: number }>
> {
  const proc = Bun.spawn(["ps", "-ax", "-o", "ppid=,pid=,rss="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("ps failed");
  const result = new Map<number, { parent: number; rssKiB: number }>();
  for (const line of stdout.split("\n")) {
    const [parent, pid, rssKiB] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(pid)) result.set(pid, { parent, rssKiB });
  }
  return result;
}

function descendants(
  roots: number[],
  snapshot: Map<number, { parent: number; rssKiB: number }>,
): Set<number> {
  const found = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, value] of snapshot) {
      if (found.has(value.parent) && !found.has(pid)) {
        found.add(pid);
        changed = true;
      }
    }
  }
  return found;
}

async function fdCount(pids: number[]): Promise<number | null> {
  if (pids.length === 0 || !Bun.which("lsof")) return null;
  const proc = Bun.spawn(
    [Bun.which("lsof")!, "-a", "-p", pids.join(","), "-Fn"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.split("\n").filter((line) => line.startsWith("n")).length;
}

async function measure(
  runner: Runner,
  requested: number,
): Promise<Measurement> {
  const startedAt = Date.now();
  const children = Array.from({ length: requested }, () =>
    Bun.spawn(command(runner), {
      cwd: "/private/tmp",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const outputs = children.map(async (child) => ({
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  }));
  const roots = children.map((child) => child.pid);
  let peakProcessCount = 0;
  let peakTotalRssKiB = 0;
  let peakFdCount: number | null = null;
  const deadline = Date.now() + 120_000;

  try {
    while (children.some((child) => child.exitCode === null)) {
      if (Date.now() >= deadline) throw new Error(`${runner} run timed out`);
      const snapshot = await processSnapshot();
      const pids = [...descendants(roots, snapshot)].filter((pid) =>
        snapshot.has(pid),
      );
      const totalRssKiB = pids.reduce(
        (sum, pid) => sum + (snapshot.get(pid)?.rssKiB ?? 0),
        0,
      );
      if (totalRssKiB > peakTotalRssKiB) {
        peakTotalRssKiB = totalRssKiB;
        peakProcessCount = pids.length;
        peakFdCount = await fdCount(pids);
      }
      await Bun.sleep(25);
    }

    const results = await Promise.all(outputs);
    await Promise.all(children.map((child) => child.exited));
    const succeeded = children.filter(
      (child, index) =>
        child.exitCode === 0 && results[index].stdout.includes("CAPACITY_OK"),
    ).length;
    if (succeeded !== requested) {
      const failures = children
        .map((child, index) => ({
          exitCode: child.exitCode,
          stderrTail: results[index].stderr.slice(-200),
        }))
        .filter((failure) => failure.exitCode !== 0);
      throw new Error(
        `${runner} ${requested}-way run had ${succeeded} successes: ${JSON.stringify(failures)}`,
      );
    }

    return {
      runner,
      requested,
      succeeded,
      durationMs: Date.now() - startedAt,
      peakProcessCount,
      peakTotalRssKiB,
      peakRssKiBPerInvocation: Math.round(peakTotalRssKiB / requested),
      peakFdCount,
      peakFdCountPerInvocation:
        peakFdCount === null
          ? null
          : Math.round((peakFdCount / requested) * 10) / 10,
    };
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    await Promise.all(children.map((child) => child.exited));
  }
}

const measurements: Measurement[] = [];
for (const runner of selectedRunners) {
  for (const count of requestedCounts) {
    measurements.push(await measure(runner, count));
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      host: { platform: process.platform, arch: process.arch },
      versions: {
        claude: (await Bun.$`claude --version`.quiet().text()).trim(),
        codex: (await Bun.$`codex --version`.quiet().text()).trim(),
      },
      prompt: "minimal authenticated provider turn; Claude uses haiku",
      measurements,
    },
    null,
    2,
  )}\n`,
);
