// `torana bots list` — print bots that the configured token can address.

import type { AgentApiClient } from "../agent-api/client.js";
import {
  COMMON_FLAGS,
  CliUsageError,
  parseFlags,
  type FlagSpec,
} from "./shared/args.js";
import { ExitCode } from "./shared/exit.js";
import {
  formatTable,
  renderJson,
  renderText,
  type Rendered,
} from "./shared/output.js";
import { renderError } from "./ask.js";

const BOTS_FLAGS: Record<string, FlagSpec> = { ...COMMON_FLAGS };

export const BOTS_HELP = `Usage: torana bots list [options]

List bots permitted by the configured token. Output is sorted by bot id.

Options:
  --server URL          Torana server URL (env: TORANA_SERVER)
  --token  T            Bearer token (env: TORANA_TOKEN)
  --json                Emit JSON instead of human-formatted output
  -h, --help            Show this help

Exit codes:
  0  success
  2  bad usage
  3  authentication failed
  5  server error

Example:
  $ torana bots list`;

export interface BotsCliInput {
  argv: string[];
  /** "list" — only subcommand in Phase 6 core. */
  action: string;
}

export interface BotsRunDeps {
  client: AgentApiClient;
}

export async function runBots(
  input: BotsCliInput,
  deps: BotsRunDeps,
): Promise<Rendered> {
  if (input.action !== "list") {
    throw new CliUsageError(
      `unknown bots subcommand '${input.action}' (only 'list' supported)`,
    );
  }

  const { positional, flags } = parseFlags(input.argv, BOTS_FLAGS);

  if (flags.help === true) {
    return renderText([BOTS_HELP], ExitCode.success);
  }
  if (positional.length > 0) {
    throw new CliUsageError("bots list takes no positional arguments");
  }

  const wantJson = flags.json === true;

  let response;
  try {
    response = await deps.client.listBots();
  } catch (err) {
    return renderError(err, wantJson);
  }

  if (wantJson) {
    return renderJson(response, ExitCode.success);
  }

  if (response.bots.length === 0) {
    return renderText(
      ["(no bots — token has no permitted bot_ids)"],
      ExitCode.success,
    );
  }

  const rows = response.bots.map((b) => [
    b.bot_id,
    b.runner_type,
    b.supports_side_sessions ? "yes" : "no",
  ]);
  const lines = formatTable(["BOT_ID", "RUNNER", "ASK?"], rows);
  return renderText(lines, ExitCode.success);
}
