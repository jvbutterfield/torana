// `torana turns get <turn_id>` — fetch the current state of a turn.
// Polled by callers who got 202 from `ask` or `send`.

import type { AgentApiClient } from "../agent-api/client.js";
import {
  COMMON_FLAGS,
  CliUsageError,
  parseFlags,
  type FlagSpec,
} from "./shared/args.js";
import { ExitCode } from "./shared/exit.js";
import { renderJson, renderText, type Rendered } from "./shared/output.js";
import { renderError } from "./ask.js";

const TURNS_FLAGS: Record<string, FlagSpec> = { ...COMMON_FLAGS };

export const TURNS_HELP = `Usage: torana turns get [options] <turn_id>

Fetch the current state of a turn (queued / in_progress / done / failed).

Options:
  --server URL          Torana server URL (env: TORANA_SERVER)
  --token  T            Bearer token (env: TORANA_TOKEN)
  --json                Emit JSON instead of human-formatted output
  -h, --help            Show this help

Exit codes:
  0  done
  1  unknown turn status
  2  bad usage
  3  authentication failed
  4  not found / result expired
  5  failed (status="failed")
  6  in progress

Example:
  $ torana turns get 42`;

export interface TurnsCliInput {
  /** Argv after `turns get` was lifted off. */
  argv: string[];
  /** "get" — only subcommand supported in Phase 6 core. */
  action: string;
}

export interface TurnsRunDeps {
  client: AgentApiClient;
}

export async function runTurns(
  input: TurnsCliInput,
  deps: TurnsRunDeps,
): Promise<Rendered> {
  if (input.action !== "get") {
    throw new CliUsageError(
      `unknown turns subcommand '${input.action}' (only 'get' supported)`,
    );
  }

  const { positional, flags } = parseFlags(input.argv, TURNS_FLAGS);

  if (flags.help === true) {
    return renderText([TURNS_HELP], ExitCode.success);
  }

  if (positional.length !== 1) {
    throw new CliUsageError("turns get requires exactly one <turn_id> argument");
  }
  const turnIdRaw = positional[0]!;
  const turnId = Number(turnIdRaw);
  if (!Number.isInteger(turnId) || turnId < 1) {
    throw new CliUsageError(`turn_id must be a positive integer (got '${turnIdRaw}')`);
  }

  const wantJson = flags.json === true;

  let response;
  try {
    response = await deps.client.getTurn(turnId);
  } catch (err) {
    return renderError(err, wantJson);
  }

  if (wantJson) {
    return renderJson(response, exitForStatus(response.status));
  }

  switch (response.status) {
    case "done": {
      const lines: string[] = [`status: done`];
      if (response.text !== undefined) lines.push(response.text);
      if (response.duration_ms !== undefined) {
        lines.push(`# duration_ms: ${response.duration_ms}`);
      }
      return renderText(lines, ExitCode.success);
    }
    case "failed":
      return renderText(
        [`status: failed`, `error: ${response.error ?? "(no detail)"}`],
        ExitCode.serverError,
      );
    case "in_progress":
      return renderText([`status: in_progress`], ExitCode.timeout);
  }
}

function exitForStatus(status: "done" | "failed" | "in_progress"): number {
  switch (status) {
    case "done":
      return ExitCode.success;
    case "failed":
      return ExitCode.serverError;
    case "in_progress":
      return ExitCode.timeout;
  }
}
