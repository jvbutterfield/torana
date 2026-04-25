// `torana send <bot_id> <text>` — push a system message into a user's
// chat. Always async (202). Auto-generates an idempotency key on
// stderr if `--idempotency-key` is omitted (callers SHOULD reuse the
// printed value if they retry).

import { basename } from "node:path";
import { randomUUID } from "node:crypto";

import type { AgentApiClient, FileUpload } from "../agent-api/client.js";
import {
  COMMON_FLAGS,
  CliUsageError,
  parseFlags,
  type FlagSpec,
} from "./shared/args.js";
import { ExitCode } from "./shared/exit.js";
import { readFileForUpload } from "./shared/files.js";
import { renderJson, renderText, type Rendered } from "./shared/output.js";
import { renderError } from "./ask.js";

const SEND_FLAGS: Record<string, FlagSpec> = {
  ...COMMON_FLAGS,
  "user-id": {
    kind: "value",
    describe: "Telegram user id to send to (or use --chat-id)",
  },
  "chat-id": {
    kind: "value",
    describe: "Chat id to send to (or use --user-id)",
  },
  source: {
    kind: "value",
    describe: "Required source label (lowercase, [a-z0-9_-]{1,64})",
  },
  "idempotency-key": {
    kind: "value",
    describe: "Idempotency key (auto-generated if omitted)",
  },
  file: {
    kind: "values",
    describe: "Attach a file (repeat for multiple files)",
  },
};

export const SEND_HELP = `Usage: torana send [options] --source LABEL <bot_id> <text>

Push a system message into a user's chat. Always returns 202;
poll \`torana turns get <id>\` for delivery status.

Options:
  --server URL          Torana server URL (env: TORANA_SERVER)
  --token  T            Bearer token (env: TORANA_TOKEN)
  --user-id ID          Telegram user id to send to
  --chat-id ID          Chat id to send to (alternative to --user-id)
  --source LABEL        Required source label (lowercase, [a-z0-9_-]{1,64})
  --idempotency-key K   Idempotency key (auto-generated if omitted)
  --file PATH           Attach a file (repeat for multiple files; use @- for stdin)
  --json                Emit JSON instead of human-formatted output
  -h, --help            Show this help

Exit codes:
  0  success (turn queued)
  2  bad usage
  3  authentication failed / target not authorized
  4  not found
  5  server error
  7  capacity

Example:
  $ torana send --source calendar --user-id 12345 reviewer "9am standup"`;

export interface SendCliInput {
  argv: string[];
}

export interface SendRunDeps {
  client: AgentApiClient;
  readFile?: (
    path: string,
  ) => Promise<{ data: Uint8Array; mime: string; filename: string }>;
  /** Override key generator for tests. */
  generateKey?: () => string;
}

export async function runSend(
  input: SendCliInput,
  deps: SendRunDeps,
): Promise<Rendered> {
  const { positional, flags } = parseFlags(input.argv, SEND_FLAGS);

  if (flags.help === true) {
    return renderText([SEND_HELP], ExitCode.success);
  }

  if (positional.length < 2) {
    throw new CliUsageError("send requires <bot_id> and <text>");
  }
  if (positional.length > 2) {
    throw new CliUsageError(
      `send takes exactly two positional args; got ${positional.length}`,
    );
  }
  const botId = positional[0]!;
  const text = positional[1]!;

  const source = stringFlag(flags, "source");
  if (!source) {
    throw new CliUsageError("--source is required");
  }

  const userId = stringFlag(flags, "user-id");
  const chatIdRaw = stringFlag(flags, "chat-id");
  if (!userId && !chatIdRaw) {
    throw new CliUsageError("either --user-id or --chat-id is required");
  }
  if (userId && chatIdRaw) {
    throw new CliUsageError("pass only one of --user-id / --chat-id, not both");
  }
  let chatId: number | undefined;
  if (chatIdRaw !== undefined) {
    const n = Number(chatIdRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new CliUsageError(
        `--chat-id must be an integer (got '${chatIdRaw}')`,
      );
    }
    chatId = n;
  }

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

  const stderr: string[] = [];
  let key = stringFlag(flags, "idempotency-key");
  if (!key) {
    key = (deps.generateKey ?? defaultKey)();
    stderr.push(`# auto-generated idempotency-key: ${key}`);
  }

  let response;
  try {
    response = await deps.client.send(
      botId,
      {
        text,
        source,
        user_id: userId,
        chat_id: chatId,
      },
      {
        idempotencyKey: key,
        files: files.length > 0 ? files : undefined,
      },
    );
  } catch (err) {
    const rendered = renderError(err, wantJson);
    return {
      ...rendered,
      stderr: [...stderr, ...rendered.stderr],
    };
  }

  if (wantJson) {
    return {
      stdout: [JSON.stringify(response, null, 2)],
      stderr,
      exitCode: ExitCode.success,
    };
  }

  return {
    stdout: [`turn_id: ${response.turn_id} (status: ${response.status})`],
    stderr,
    exitCode: ExitCode.success,
  };
}

function defaultKey(): string {
  // The server requires 16–128 chars from [A-Za-z0-9_-]; UUID v4 is 36
  // chars and only uses [0-9a-f-], well within both bounds.
  return randomUUID();
}

function stringFlag(
  flags: Record<string, string | string[] | boolean>,
  name: string,
): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

// Re-export for symmetry — callers expect `renderJson` available.
export { renderJson };
