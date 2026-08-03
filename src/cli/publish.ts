import { readFileSync } from "node:fs";
import { parseFlags, CliUsageError } from "./shared/args.js";
import { ExitCode } from "./shared/exit.js";
import { renderJson, renderText, type Rendered } from "./shared/output.js";
import { IDEMPOTENCY_KEY } from "../publisher/schemas.js";

interface PublishCliDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  readFile?: (path: string | number) => string;
}

export async function runPublish(
  chain: string[],
  rest: string[],
  deps: PublishCliDeps = {},
): Promise<Rendered> {
  if (rest.includes("--help") || rest.includes("-h")) return help();
  const statusMode = chain[1] === "status";
  const flags = parseFlags(rest, {
    server: { kind: "value", describe: "loopback Torana URL" },
    "idempotency-key": {
      kind: "value",
      describe: "stable logical message key",
    },
    source: { kind: "value", describe: "bounded producer label" },
    severity: { kind: "value", describe: "info, warning, or error" },
    file: {
      kind: "value",
      describe: "read content from a file; default stdin",
    },
    json: { kind: "bool", describe: "emit JSON" },
  });
  const publisherId = statusMode ? flags.positional[0] : chain[1];
  if (
    !publisherId ||
    (statusMode ? flags.positional.length !== 1 : flags.positional.length !== 0)
  ) {
    throw new CliUsageError(
      statusMode
        ? "publish status requires exactly one publisher id"
        : "publish requires a publisher id; message content must come from stdin or --file",
    );
  }
  const key = stringFlag(flags.flags["idempotency-key"]);
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    throw new CliUsageError(
      "--idempotency-key must be 16–128 chars of [A-Za-z0-9_-]",
    );
  }
  const env = deps.env ?? process.env;
  const server = (stringFlag(flags.flags.server) ?? env.TORANA_SERVER)?.replace(
    /\/+$/,
    "",
  );
  if (!server) throw new CliUsageError("--server or TORANA_SERVER is required");
  const read = deps.readFile ?? ((path) => readFileSync(path, "utf8"));
  const token = env.TORANA_PUBLISH_TOKEN_FILE
    ? read(env.TORANA_PUBLISH_TOKEN_FILE).trim()
    : env.TORANA_PUBLISH_TOKEN;
  if (!token) {
    throw new CliUsageError(
      "TORANA_PUBLISH_TOKEN_FILE or TORANA_PUBLISH_TOKEN is required; raw token flags are not supported",
    );
  }

  let body: Record<string, string>;
  if (statusMode) {
    body = { idempotency_key: key };
  } else {
    const severity = stringFlag(flags.flags.severity) ?? "info";
    if (!new Set(["info", "warning", "error"]).has(severity)) {
      throw new CliUsageError("--severity must be info, warning, or error");
    }
    const source = stringFlag(flags.flags.source);
    if (!source || !/^[a-z0-9_-]{1,64}$/.test(source)) {
      throw new CliUsageError("--source must match ^[a-z0-9_-]{1,64}$");
    }
    body = {
      content: read(stringFlag(flags.flags.file) ?? 0),
      source,
      severity,
    };
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetchImpl(
      `${server}/v1/publishers/${encodeURIComponent(publisherId)}/messages${statusMode ? "/status" : ""}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(statusMode ? {} : { "Idempotency-Key": key }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      },
    );
  } catch {
    return renderText([], ExitCode.serverError, ["publisher request failed"]);
  }
  let value: any;
  try {
    value = await response.json();
  } catch {
    return renderText([], ExitCode.internal, [
      "publisher returned malformed JSON",
    ]);
  }
  const jsonOutput = flags.flags.json === true;
  if (!response.ok) {
    const exit = exitForStatus(response.status);
    return jsonOutput
      ? renderJson(value, exit)
      : renderText([], exit, [String(value?.error ?? "publisher_error")]);
  }
  if (jsonOutput) return renderJson(value, ExitCode.success);
  return statusMode
    ? renderText(
        [
          `publication ${value.publication_id}: ${value.status}`,
          `outbox ${value.outbox_id}`,
        ],
        ExitCode.success,
      )
    : renderText(
        [
          `publication ${value.publication_id} accepted${value.replayed ? " (replay)" : ""}`,
          `outbox ${value.outbox_id}`,
        ],
        ExitCode.success,
      );
}

function help(): Rendered {
  return renderText(
    [
      "Usage:",
      "  torana publish <publisher> --source <label> --idempotency-key <key> [--severity info|warning|error] [--file <path>]",
      "  torana publish status <publisher> --idempotency-key <key>",
      "",
      "Message content is read from stdin unless --file is supplied. Publisher tokens are read only from TORANA_PUBLISH_TOKEN_FILE or TORANA_PUBLISH_TOKEN.",
      "Exit codes: 0 success, 2 usage, 3 auth, 4 not found, 5 server, 7 rate/capacity.",
    ],
    ExitCode.success,
  );
}

function stringFlag(
  value: string | string[] | boolean | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function exitForStatus(status: number): number {
  if (status === 401 || status === 403) return ExitCode.authFailed;
  if (status === 404) return ExitCode.notFound;
  if (status === 429) return ExitCode.capacity;
  if (status >= 500) return ExitCode.serverError;
  if (status >= 400) return ExitCode.badUsage;
  return ExitCode.internal;
}
