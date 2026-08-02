import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  BuzzBrokerRequest,
  BuzzBrokerResponse,
  BuzzCapabilityFile,
} from "../broker/buzz-broker.js";
import { ExitCode } from "./shared/exit.js";
import { renderText, type Rendered } from "./shared/output.js";

const HELP = `Usage: torana buzz call

Read one typed Buzz broker request as JSON from stdin. The current runner
session's short-lived capability selects the endpoint; callers cannot supply
relay URLs or signing credentials.

Request shape:
  {"group":"messages","command":"send","options":{"channel":"<uuid>","content":"hello"}}

Nested commands use "nestedCommand" (for example repos/protect/list).
Optional fields: "positionals", "stdin".
`;

export interface RunBuzzOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
  rpc?: (
    capability: BuzzCapabilityFile,
    envelope: { token: string; request: BuzzBrokerRequest },
  ) => Promise<BuzzBrokerResponse>;
}

export async function runBuzz(
  argv: string[],
  opts: RunBuzzOptions = {},
): Promise<Rendered> {
  if (
    argv[0] === undefined ||
    argv[0] === "help" ||
    argv.includes("--help") ||
    argv.includes("-h")
  ) {
    return renderText(HELP.split("\n").slice(0, -1), ExitCode.success);
  }
  if (argv.length !== 1 || argv[0] !== "call") {
    return renderText([], ExitCode.badUsage, [
      "usage: torana buzz call < request.json",
    ]);
  }
  try {
    const env = opts.env ?? process.env;
    const capability = readCapability(env);
    const input = opts.input ?? (await readStdin());
    if (Buffer.byteLength(input) > 256 * 1024) {
      throw new Error("Buzz broker request is too large");
    }
    const request = JSON.parse(input) as BuzzBrokerRequest;
    const response = await (opts.rpc ?? callBroker)(capability, {
      token: capability.token,
      request,
    });
    const exitCode =
      Number.isInteger(response.exitCode) &&
      response.exitCode >= 0 &&
      response.exitCode <= 5
        ? response.exitCode
        : ExitCode.internal;
    const rendered = renderText(
      response.stdout ? response.stdout.replace(/\n$/, "").split("\n") : [],
      exitCode,
      [
        ...(response.stderr
          ? response.stderr.replace(/\n$/, "").split("\n")
          : []),
        ...(response.error ? [`buzz broker: ${response.error}`] : []),
      ],
    );
    if (
      request.group === "mem" &&
      request.command === "get" &&
      response.stdoutBase64
    ) {
      rendered.stdout = [];
      rendered.rawStdout = Buffer.from(response.stdoutBase64, "base64");
    }
    return rendered;
  } catch (error) {
    return renderText([], ExitCode.internal, [
      `buzz broker: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

function readCapability(env: NodeJS.ProcessEnv): BuzzCapabilityFile {
  const sessionId = env.TORANA_SESSION_ID;
  const directory = env.TORANA_BUZZ_CAPABILITY_DIR;
  if (!sessionId || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId) || !directory) {
    throw new Error("no Buzz capability is available for this runner session");
  }
  const parsed = JSON.parse(
    readFileSync(join(directory, `${sessionId}.json`), "utf8"),
  ) as BuzzCapabilityFile;
  if (
    parsed.version !== 1 ||
    typeof parsed.token !== "string" ||
    parsed.expiresAt <= Date.now()
  ) {
    throw new Error("Buzz capability is invalid or expired");
  }
  return parsed;
}

async function callBroker(
  capability: BuzzCapabilityFile,
  envelope: { token: string; request: BuzzBrokerRequest },
): Promise<BuzzBrokerResponse> {
  if (capability.transport === "http") {
    if (!capability.url) throw new Error("Buzz capability has no broker URL");
    const response = await fetch(capability.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Buzz broker HTTP ${response.status}`);
    return (await response.json()) as BuzzBrokerResponse;
  }
  if (!capability.socketPath) {
    throw new Error("Buzz capability has no broker socket path");
  }
  return await callUnix(capability.socketPath, JSON.stringify(envelope));
}

async function callUnix(
  socketPath: string,
  payload: string,
): Promise<BuzzBrokerResponse> {
  return await new Promise<BuzzBrokerResponse>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    void Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(`${payload}\n`);
        },
        data(socket, chunk) {
          buffer += Buffer.from(chunk).toString("utf8");
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          settled = true;
          socket.end();
          try {
            resolve(JSON.parse(buffer.slice(0, newline)) as BuzzBrokerResponse);
          } catch (error) {
            reject(error);
          }
        },
        close() {
          if (!settled)
            reject(new Error("Buzz broker closed without a response"));
        },
        error(_socket, error) {
          if (!settled) reject(error);
        },
      },
    }).catch(reject);
  });
}

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

export { HELP as BUZZ_HELP };
