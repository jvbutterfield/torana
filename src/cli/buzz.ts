import { readFileSync } from "node:fs";
import { join } from "node:path";

import { generateSecretKey, nip19 } from "nostr-tools";

import type {
  BuzzBrokerRequest,
  BuzzBrokerResponse,
  BuzzCapabilityFile,
} from "../broker/buzz-broker.js";
import {
  createOwnerAuthTag,
  decodeSecret,
  publicKey,
} from "../platform/buzz/protocol.js";
import { ExitCode } from "./shared/exit.js";
import { renderJson, renderText, type Rendered } from "./shared/output.js";

const HELP = `Usage: torana buzz <call|keygen|auth-tag>

  call       Send one typed broker request (runner-facing).
  keygen     Generate a new Buzz identity keypair.
  auth-tag   Mint a NIP-OA owner auth tag for an endpoint identity.

torana buzz call
  Read one typed Buzz broker request as JSON from stdin. The current runner
  session's short-lived capability selects the endpoint; callers cannot supply
  relay URLs or signing credentials.

  Request shape:
    {"group":"messages","command":"send","options":{"channel":"<uuid>","content":"hello"}}

  Nested commands use "nestedCommand" (for example repos/protect/list).
  Optional fields: "positionals", "stdin".

torana buzz keygen [--format text|json]
  Print a fresh secret key and its public key. The secret is written to stdout
  once and never stored — capture it into your secret manager.

torana buzz auth-tag --agent-pubkey <64-hex> [--conditions kind=9]
                     [--format text|json]
  Sign an owner attestation for an endpoint identity. The owner secret is read
  from BUZZ_OWNER_PRIVATE_KEY, never from a flag, so it stays out of argv and
  shell history. Conditions default to "kind=9" (ordinary messages).
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
  if (argv[0] === "keygen") return runKeygen(argv.slice(1));
  if (argv[0] === "auth-tag") {
    return runAuthTag(argv.slice(1), opts.env ?? process.env);
  }
  if (argv.length !== 1 || argv[0] !== "call") {
    return renderText([], ExitCode.badUsage, [
      "usage: torana buzz <call|keygen|auth-tag>; see torana buzz --help",
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

// ── credential helpers ──────────────────────────────────────────────────────
//
// These two exist because obtaining Buzz credentials was the one step of the
// Buzz setup with no documented path: Torana could verify an owner attestation
// but never mint one, so operators had no first-party way to produce the
// `auth_tag` every Buzz endpoint requires.
//
// Neither touches the gateway, the database, or the network. `keygen` is pure
// generation; `auth-tag` is a pure signature over inputs the caller supplies.

/** `--format json` → JSON, anything else → text. Defaults to text. */
function wantsJson(argv: string[]): boolean {
  const i = argv.indexOf("--format");
  return (i >= 0 && argv[i + 1] === "json") || argv.includes("--json");
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) {
    return argv[i + 1];
  }
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

function runKeygen(argv: string[]): Rendered {
  const secret = generateSecretKey();
  const secretHex = Buffer.from(secret).toString("hex");
  const pubkey = publicKey(secret);
  if (wantsJson(argv)) {
    return renderJson(
      {
        private_key: secretHex,
        public_key: pubkey,
        nsec: nip19.nsecEncode(secret),
        npub: nip19.npubEncode(pubkey),
      },
      ExitCode.success,
    );
  }
  return renderText(
    [
      `private_key  ${secretHex}`,
      `public_key   ${pubkey}`,
      `nsec         ${nip19.nsecEncode(secret)}`,
      `npub         ${nip19.npubEncode(pubkey)}`,
    ],
    ExitCode.success,
    [
      "This secret is not stored anywhere. Copy it into your secret manager now.",
    ],
  );
}

function runAuthTag(argv: string[], env: NodeJS.ProcessEnv): Rendered {
  const agentPubkeyRaw = flagValue(argv, "--agent-pubkey");
  if (!agentPubkeyRaw) {
    return renderText([], ExitCode.badUsage, [
      "usage: torana buzz auth-tag --agent-pubkey <64-hex> [--conditions kind=9]",
      "the owner secret is read from BUZZ_OWNER_PRIVATE_KEY, not from a flag",
    ]);
  }
  const ownerRaw = env.BUZZ_OWNER_PRIVATE_KEY;
  if (!ownerRaw || ownerRaw.trim() === "") {
    return renderText([], ExitCode.badUsage, [
      "BUZZ_OWNER_PRIVATE_KEY is not set",
      "Set it to the owner identity's secret key (hex or nsec). It is read from",
      "the environment rather than a flag so it stays out of argv and shell history.",
    ]);
  }
  try {
    const ownerSecret = decodeSecret(ownerRaw.trim());
    // Accept an npub for the endpoint too — operators copy whichever form the
    // client showed them.
    const agentPubkey = agentPubkeyRaw.startsWith("npub1")
      ? (nip19.decode(agentPubkeyRaw).data as string)
      : agentPubkeyRaw.toLowerCase();
    const conditions = flagValue(argv, "--conditions") ?? "kind=9";
    const tag = createOwnerAuthTag(ownerSecret, agentPubkey, conditions);
    const serialized = JSON.stringify(tag);
    if (wantsJson(argv)) {
      return renderJson(
        {
          auth_tag: serialized,
          owner_pubkey: publicKey(ownerSecret),
          agent_pubkey: agentPubkey,
          conditions,
        },
        ExitCode.success,
      );
    }
    return renderText(
      [
        `auth_tag      ${serialized}`,
        `owner_pubkey  ${publicKey(ownerSecret)}`,
        `agent_pubkey  ${agentPubkey}`,
        `conditions    ${conditions}`,
      ],
      ExitCode.success,
      ["Quote auth_tag when you put it in YAML or an env var — it is JSON."],
    );
  } catch (error) {
    return renderText([], ExitCode.badUsage, [
      `could not mint an auth tag: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ]);
  }
}

export { HELP as BUZZ_HELP };
