// `torana inject <bot_id> <text>` — push a system-injected message into a
// user's chat. Always async (202). Auto-generates an idempotency key on
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

const INJECT_FLAGS: Record<string, FlagSpec> = {
  ...COMMON_FLAGS,
  "user-id": {
    kind: "value",
    describe: "Telegram user id to inject into (or use --chat-id)",
  },
  "chat-id": {
    kind: "value",
    describe: "Chat id to inject into (or use --user-id)",
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

export const INJECT_HELP = `Usage: torana inject [options] --source LABEL <bot_id> <text>

Push a system-injected message into a user's chat. Always returns 202;
poll \`torana turns get <id>\` for delivery status.

Options:
  --server URL          Torana server URL (env: TORANA_SERVER)
  --token  T            Bearer token (env: TORANA_TOKEN)
  --user-id ID          Telegram user id to inject into
  --chat-id ID          Chat id to inject into (alternative to --user-id)
  --source LABEL        Required source label (lowercase, [a-z0-9_-]{1,64})
  --idempotency-key K   Idempotency key (auto-generated if omitted)
  --file PATH           Attach a file (repeat for multiple files)
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
  $ torana inject --source calendar --user-id 12345 reviewer "9am standup"`;

export interface InjectCliInput {
  argv: string[];
}

export interface InjectRunDeps {
  client: AgentApiClient;
  readFile?: (path: string) => Promise<{ data: Uint8Array; mime: string }>;
  /** Override key generator for tests. */
  generateKey?: () => string;
  /** Where to emit the auto-generated key notice (defaults to stderr lines). */
}

export async function runInject(
  input: InjectCliInput,
  deps: InjectRunDeps,
): Promise<Rendered> {
  const { positional, flags } = parseFlags(input.argv, INJECT_FLAGS);

  if (flags.help === true) {
    return renderText([INJECT_HELP], ExitCode.success);
  }

  if (positional.length < 2) {
    throw new CliUsageError("inject requires <bot_id> and <text>");
  }
  if (positional.length > 2) {
    throw new CliUsageError(
      `inject takes exactly two positional args; got ${positional.length}`,
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
    throw new CliUsageError(
      "pass only one of --user-id / --chat-id, not both",
    );
  }
  let chatId: number | undefined;
  if (chatIdRaw !== undefined) {
    const n = Number(chatIdRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new CliUsageError(`--chat-id must be an integer (got '${chatIdRaw}')`);
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

  const reader = deps.readFile ?? readFileForUpload;
  const files: FileUpload[] = [];
  for (const p of filePaths) {
    const { data, mime } = await reader(p);
    files.push({ data, filename: basename(p), contentType: mime });
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
    response = await deps.client.inject(
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
