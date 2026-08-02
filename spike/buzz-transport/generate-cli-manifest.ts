import { delimiter, join } from "node:path";

type CommandNode = { command: string; subcommands?: CommandNode[] };

function resolveBinary(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    if (Bun.file(candidate).size > 0) return candidate;
  }
  throw new Error(`${name} was not found on PATH`);
}

function commandsFromHelp(help: string): string[] {
  const section =
    help.match(/(?:^|\n)Commands:\n([\s\S]*?)(?:\n\n|$)/)?.[1] ?? "";
  return section
    .split("\n")
    .map((line) => line.match(/^\s{2}([^\s|,]+)(?:\|[^\s]+)?\s{2,}/)?.[1])
    .filter((value): value is string => Boolean(value) && value !== "help")
    .sort();
}

async function help(binary: string, path: string[]): Promise<string> {
  const proc = Bun.spawn([binary, ...path, "--help"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0)
    throw new Error(
      `${[binary, ...path, "--help"].join(" ")} failed: ${stderr}`,
    );
  return stdout;
}

async function walk(
  binary: string,
  path: string[],
  depth = 0,
): Promise<CommandNode[]> {
  if (depth > 4)
    throw new Error(`unexpected command nesting at ${path.join(" ")}`);
  const names = commandsFromHelp(await help(binary, path));
  return Promise.all(
    names.map(async (command) => {
      const subcommands = await walk(binary, [...path, command], depth + 1);
      return subcommands.length === 0 ? { command } : { command, subcommands };
    }),
  );
}

async function versionProbe(binary: string) {
  const proc = Bun.spawn([binary, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();
  const exitCode = await proc.exited;
  return { supported: exitCode === 0, exitCode, stdout, stderr };
}

const binary = resolveBinary(process.env.BUZZ_BIN ?? "buzz");
const bytes = await Bun.file(binary).arrayBuffer();
const manifest = {
  schemaVersion: 1,
  binary: "buzz",
  versionProbe: await versionProbe(binary),
  sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  commands: await walk(binary, []),
};

const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const expected = await Bun.file(
    new URL("./cli-manifest.json", import.meta.url),
  ).text();
  if (expected !== rendered) {
    throw new Error(
      "cli-manifest.json does not match the installed buzz binary",
    );
  }
  process.stdout.write("cli-manifest.json matches the installed buzz binary\n");
} else {
  process.stdout.write(rendered);
}
