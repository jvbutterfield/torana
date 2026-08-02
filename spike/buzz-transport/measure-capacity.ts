type Measurement = {
  runner: "claude" | "codex";
  requested: number;
  alive: number;
  processCount: number;
  totalRssKiB: number;
  rssKiBPerInvocation: number;
  totalFdCount: number | null;
  fdCountPerInvocation: number | null;
};

const counts = [1, 2, 8, 32];

function command(runner: "claude" | "codex"): string[] {
  if (runner === "claude") {
    return [
      Bun.which("claude") ?? "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--replay-user-messages",
      "--verbose",
      "--dangerously-skip-permissions",
    ];
  }
  return [Bun.which("codex") ?? "codex", "exec", "--json", "-"];
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
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.split("\n").filter((line) => line.startsWith("n")).length;
}

async function measure(
  runner: "claude" | "codex",
  requested: number,
): Promise<Measurement> {
  const children = Array.from({ length: requested }, () =>
    Bun.spawn(command(runner), {
      cwd: "/private/tmp",
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  try {
    await Bun.sleep(1_500);
    const aliveChildren = children.filter((child) => child.exitCode === null);
    const snapshot = await processSnapshot();
    const pids = [
      ...descendants(
        aliveChildren.map((child) => child.pid),
        snapshot,
      ),
    ].filter((pid) => snapshot.has(pid));
    const totalRssKiB = pids.reduce(
      (sum, pid) => sum + (snapshot.get(pid)?.rssKiB ?? 0),
      0,
    );
    const totalFdCount = await fdCount(pids);
    return {
      runner,
      requested,
      alive: aliveChildren.length,
      processCount: pids.length,
      totalRssKiB,
      rssKiBPerInvocation:
        aliveChildren.length === 0
          ? 0
          : Math.round(totalRssKiB / aliveChildren.length),
      totalFdCount,
      fdCountPerInvocation:
        totalFdCount === null || aliveChildren.length === 0
          ? null
          : Math.round((totalFdCount / aliveChildren.length) * 10) / 10,
    };
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    await Promise.all(children.map((child) => child.exited));
  }
}

const measurements: Measurement[] = [];
for (const runner of ["claude", "codex"] as const) {
  for (const count of counts) measurements.push(await measure(runner, count));
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
      caveat:
        "Idle CLI baselines only. Provider-authenticated in-turn peaks and the Railway deployment ceiling remain required for the production capacity gate.",
      measurements,
    },
    null,
    2,
  )}\n`,
);
