// `torana ask <bot_id> <text>` — synchronous request/response against a
// torana-hosted bot. Returns the bot's text on success; on 202 (timeout)
// returns the turn id on stdout (so the caller can poll `torana turns get`)
// and a hint on stderr.
//
// Examples:
//   torana ask reviewer "summarize PR 42"
//   torana ask --session-id review-123 reviewer "what about the tests?"
//   torana ask --file /tmp/diff.png reviewer "what does this look like?"
//   cat diff.png | torana ask --file @- reviewer "review this patch"

import { basename } from "node:path";

import type { AgentApiClient, FileUpload } from "../agent-api/client.js";
import { AgentApiError } from "../agent-api/client.js";
import {
  COMMON_FLAGS,
  CliUsageError,
  parseFlags,
  type FlagSpec,
} from "./shared/args.js";
import { ExitCode, exitCodeFor } from "./shared/exit.js";
import { readFileForUpload } from "./shared/files.js";
import { renderJson, renderText, type Rendered } from "./shared/output.js";

const ASK_FLAGS: Record<string, FlagSpec> = {
  ...COMMON_FLAGS,
  "session-id": {
    kind: "value",
    describe: "Reuse a keyed side-session by id",
  },
  "timeout-ms": {
    kind: "value",
    describe: "Per-call timeout in milliseconds (default 60000, max 300000)",
  },
  file: {
    kind: "values",
    describe: "Attach a file (repeat for multiple files)",
  },
};

export const ASK_HELP = `Usage: torana ask [options] <bot_id> <text>

Send a synchronous question to a torana-hosted bot and print its reply.

Options:
  --server URL          Torana server URL (env: TORANA_SERVER)
  --token  T            Bearer token (env: TORANA_TOKEN)
  --session-id ID       Reuse a keyed side-session by id
  --timeout-ms N        Per-call timeout in ms (default 60000, max 300000)
  --file PATH           Attach a file (repeat for multiple files; use @- for stdin)
  --json                Emit JSON instead of human-formatted output
  -h, --help            Show this help

Exit codes:
  0  success
  2  bad usage
  3  authentication failed
  4  not found
  5  server / runner error
  6  timeout (returned 202; turn_id printed for polling)
  7  capacity / busy

Example:
  $ torana ask --server http://localhost:8787 reviewer "summarize PR 42"`;

export interface AskCliInput {
  /** Argv after the `ask` subcommand was lifted off (see args.parseCommand). */
  argv: string[];
}

export interface AskRunDeps {
  /** Factory for a client. CLI passes the real one; tests inject a fake. */
  client: AgentApiClient;
  /**
   * Reads a file from disk or stdin (overridable for tests). The path is
   * `@-` to request stdin bytes.
   */
  readFile?: (path: string) => Promise<{ data: Uint8Array; mime: string; filename: string }>;
}

export async function runAsk(
  input: AskCliInput,
  deps: AskRunDeps,
): Promise<Rendered> {
  const { positional, flags } = parseFlags(input.argv, ASK_FLAGS);

  if (flags.help === true) {
    return renderText([ASK_HELP], ExitCode.success);
  }

  if (positional.length < 2) {
    throw new CliUsageError("ask requires <bot_id> and <text>");
  }
  if (positional.length > 2) {
    throw new CliUsageError(
      `ask takes exactly two positional args; got ${positional.length}`,
    );
  }
  const botId = positional[0]!;
  const text = positional[1]!;

  const sessionId = stringFlag(flags, "session-id");
  const timeoutMs = numberFlag(flags, "timeout-ms");

  const fileFlag = flags.file;
  const filePaths: string[] =
    typeof fileFlag === "string"
      ? [fileFlag]
      : Array.isArray(fileFlag)
        ? fileFlag
        : [];

  let stdinSeen = 0;
  for (const p of filePaths) {
    if (p === "@-") {
      stdinSeen += 1;
      if (stdinSeen > 1) {
        throw new CliUsageError(
          "--file @- may be given at most once (stdin can only be consumed once per invocation)",
        );
      }
    }
  }

  const reader = deps.readFile ?? readFileForUpload;
  const files: FileUpload[] = [];
  for (const p of filePaths) {
    const { data, mime, filename } = await reader(p);
    files.push({
      data,
      filename: p === "@-" ? filename : basename(p),
      contentType: mime,
    });
  }

  const wantJson = flags.json === true;

  let response: Awaited<ReturnType<AgentApiClient["ask"]>>;
  try {
    response = await deps.client.ask(
      botId,
      {
        text,
        session_id: sessionId,
        timeout_ms: timeoutMs,
      },
      files.length > 0 ? files : undefined,
    );
  } catch (err) {
    return renderError(err, wantJson);
  }

  if (wantJson) {
    return renderJson(response, ExitCode.success);
  }

  if (response.status === "done") {
    return renderText([response.text], ExitCode.success);
  }

  // in_progress — print turn_id on stdout for `torana turns get`
  return renderText(
    [String(response.turn_id)],
    ExitCode.timeout,
    [
      `# ask returned 202 in_progress; poll with: torana turns get ${response.turn_id}`,
      `# session_id: ${response.session_id}`,
    ],
  );
}

function stringFlag(
  flags: Record<string, string | string[] | boolean>,
  name: string,
): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function numberFlag(
  flags: Record<string, string | string[] | boolean>,
  name: string,
): number | undefined {
  const v = flags[name];
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new CliUsageError(`--${name} must be numeric (got '${v}')`);
  }
  return n;
}

export function renderError(err: unknown, wantJson: boolean): Rendered {
  if (err instanceof AgentApiError) {
    const exit = exitCodeFor(err.code, err.status);
    if (wantJson) {
      return {
        stdout: [
          JSON.stringify(
            { error: err.code, message: err.message, status: err.status },
            null,
            2,
          ),
        ],
        stderr: [],
        exitCode: exit,
      };
    }
    return {
      stdout: [],
      stderr: [`error: ${err.code}: ${err.message}`],
      exitCode: exit,
    };
  }
  if (err instanceof CliUsageError) {
    return { stdout: [], stderr: [`usage: ${err.message}`], exitCode: ExitCode.badUsage };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { stdout: [], stderr: [`error: ${msg}`], exitCode: ExitCode.internal };
}
