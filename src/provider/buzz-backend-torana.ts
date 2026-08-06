// `buzz-backend-torana` — a Buzz Desktop remote-agent provider that deploys
// onto a Torana gateway.
//
// Layer 2 of the remote-agents contract at `desktop-v0.5.5`: one process per
// operation, exactly one JSON object in on stdin, exactly one out on stdout,
// non-zero exit means failure regardless of what was printed. The Desktop
// treats everything this binary emits as untrusted and scrubs it, but we do
// not rely on that — nothing here ever writes a secret to stdout, stderr, or
// disk.
//
// There is no `undeploy` op in v1. Stopping a remote agent is the owner's
// `!shutdown` over the relay, which Torana honours; Desktop "Stop" never calls
// this binary.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROTOCOL_VERSION = 1;
export const PROVIDER_NAME = "torana";

/** Contract caps. Exceeding them is our bug, so we truncate deliberately. */
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/** Deploy budget is 600 s; give the endpoint 120 s to come up inside it. */
const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2000;

export interface ProviderConfigFile {
  /** Bearer for the `endpoints:admin` token. Never travels in provider_config. */
  admin_token?: string;
  /** Optional per-reference tokens, keyed by `torana_admin_token_ref`. */
  tokens?: Record<string, string>;
}

export interface DeployRequestAgent {
  name?: string;
  relay_url?: string;
  private_key_nsec?: string;
  auth_tag?: string | null;
  respond_to?: string;
  respond_to_allowlist?: string[];
  env_vars?: Record<string, string>;
  system_prompt?: string;
  model?: string;
  provider?: string;
  parallelism?: number;
  turn_timeout_seconds?: number;
  idle_timeout_seconds?: number;
  max_turn_duration_seconds?: number;
  launch?: { owner_pubkey?: string } & Record<string, unknown>;
  owner_pubkey?: string;
  [key: string]: unknown;
}

export interface ProviderRequest {
  op?: string;
  request_id?: string;
  agent?: DeployRequestAgent;
  provider_config?: Record<string, unknown>;
}

export type ProviderResponse =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string };

/**
 * Reserved identity keys. The Desktop strips these before merging user env,
 * and a provider must build identity from the top-level payload fields
 * instead — reading them from `env_vars` yields an identityless agent. We also
 * refuse them outright rather than silently dropping them, so a user who set
 * one is told their value is being ignored.
 */
const RESERVED_ENV_KEYS = new Set([
  "BUZZ_PRIVATE_KEY",
  "NOSTR_PRIVATE_KEY",
  "BUZZ_AUTH_TAG",
  "BUZZ_RELAY_URL",
  "BUZZ_ACP_NO_PRESENCE",
  "BUZZ_ACP_EXIT_AFTER_INACTIVITY",
]);

/** Knobs the Desktop sends that Torana's own runner configuration owns. */
const TORANA_MANAGED_FIELDS = [
  "system_prompt",
  "model",
  "provider",
  "parallelism",
  "turn_timeout_seconds",
  "idle_timeout_seconds",
  "max_turn_duration_seconds",
  "agent_command",
  "agent_args",
] as const;

export class ProviderError extends Error {}

export function infoResponse(version: string): ProviderResponse {
  return {
    ok: true,
    name: PROVIDER_NAME,
    version,
    protocol_version: PROTOCOL_VERSION,
    description:
      "Deploy Buzz agents onto a Torana gateway. The agent runs under Torana's " +
      "own runner configuration; Torana keeps it online independently of this " +
      "Desktop. Stop is the owner's !shutdown over the relay, not a provider call.",
    config_schema: {
      type: "object",
      required: ["torana_url", "torana_agent_id"],
      properties: {
        torana_url: {
          type: "string",
          title: "Torana URL",
          description:
            "Base URL of the Torana gateway, e.g. https://…up.railway.app",
        },
        torana_agent_id: {
          type: "string",
          title: "Torana agent id",
          description:
            "The agent already configured in Torana that this endpoint attaches to. " +
            "Torana creates endpoints, never agents or runners.",
        },
        torana_admin_token_ref: {
          type: "string",
          title: "Admin token reference",
          description:
            "Name of the token in ~/.config/torana/provider.json. The token itself " +
            "must never be entered here — provider config is stored by the Desktop.",
          default: "default",
        },
        torana_endpoint_id: {
          type: "string",
          title: "Endpoint id",
          description: "Defaults to <torana_agent_id>-buzz when left blank.",
        },
        community_id: {
          type: "string",
          title: "Community id",
          default: "primary",
        },
        respond_to: {
          type: "string",
          title: "Respond to",
          enum: ["owner_only", "allowlist", "anyone", "nobody"],
          default: "owner_only",
        },
        subscribe: {
          type: "string",
          title: "Subscribe",
          enum: ["mentions_and_dms", "all_channels"],
          default: "mentions_and_dms",
        },
      },
    },
  };
}

function requireString(
  config: Record<string, unknown>,
  key: string,
): string | null {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Load the admin token from the provider's own config file, never from
 * `provider_config`. Invariant I2 forbids secrets in provider config, and the
 * Desktop persists that object.
 */
export function loadAdminToken(
  ref: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
  configPath = join(homedir(), ".config", "torana", "provider.json"),
): string {
  let parsed: ProviderConfigFile;
  try {
    parsed = JSON.parse(read(configPath)) as ProviderConfigFile;
  } catch (error) {
    throw new ProviderError(
      `could not read ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }. Create it with mode 0600 containing {"admin_token": "…"}.`,
    );
  }
  const token =
    (ref && parsed.tokens?.[ref]) ??
    (ref === "default" ? parsed.admin_token : undefined) ??
    parsed.admin_token;
  if (!token || typeof token !== "string") {
    throw new ProviderError(`no admin token named '${ref}' in ${configPath}`);
  }
  return token;
}

export interface DeployDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  loadToken?: (ref: string) => string;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}

export async function deploy(
  request: ProviderRequest,
  deps: DeployDeps = {},
): Promise<ProviderResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;

  const agent = request.agent ?? {};
  const config = request.provider_config ?? {};

  const toranaUrl = requireString(config, "torana_url");
  if (!toranaUrl) throw new ProviderError("provider config needs torana_url");
  if (!/^https:\/\//i.test(toranaUrl) && !isLoopback(toranaUrl)) {
    // The nsec crosses this hop. Plaintext HTTP is only tolerable to a local
    // gateway an operator is testing against.
    throw new ProviderError(
      "torana_url must be https:// (http:// is allowed only for localhost)",
    );
  }
  const agentId = requireString(config, "torana_agent_id");
  if (!agentId) {
    throw new ProviderError(
      "provider config needs torana_agent_id — the agent already configured in Torana",
    );
  }
  const endpointId =
    requireString(config, "torana_endpoint_id") ?? `${agentId}-buzz`;

  const relayUrl = agent.relay_url;
  if (typeof relayUrl !== "string" || relayUrl.trim() === "") {
    throw new ProviderError("deploy payload has no relay_url");
  }
  if (/^relay-mesh:|^mesh:/i.test(relayUrl)) {
    // Non-deployable by spec: that transport only exists between Desktops.
    throw new ProviderError(
      "this agent uses a relay-mesh transport, which cannot be deployed remotely",
    );
  }
  if (isLoopback(relayUrl) && !isLoopback(toranaUrl)) {
    // The Desktop's own loopback relay is not reachable from the gateway —
    // the remote host's localhost is a different machine. A loopback relay is
    // only coherent when Torana is loopback too, which is the local-test case.
    throw new ProviderError(
      "this agent uses a desktop-loopback relay, which a remote Torana cannot reach",
    );
  }

  const nsec = agent.private_key_nsec;
  if (typeof nsec !== "string" || nsec.trim() === "") {
    throw new ProviderError("deploy payload has no private_key_nsec");
  }

  const authTag = agent.auth_tag;
  if (authTag === null || authTag === undefined || authTag === "") {
    // Torana's relay requires the owner attestation (a hosted relay answers
    // 403 relay_membership_required without it), and upstream omits
    // owner_pubkey when the tag is null — which would also leave the endpoint
    // with no owner to accept a `!shutdown` from.
    throw new ProviderError(
      "this agent has no NIP-OA auth tag. Torana requires the owner attestation: " +
        "the hosted relay refuses membership without it, and the owner is what " +
        "authorizes the remote Stop command. Re-create the agent with an owner " +
        "attestation, then deploy again.",
    );
  }

  const ownerPubkey =
    typeof agent.launch?.owner_pubkey === "string"
      ? agent.launch.owner_pubkey
      : typeof agent.owner_pubkey === "string"
        ? agent.owner_pubkey
        : undefined;

  for (const key of Object.keys(agent.env_vars ?? {})) {
    if (RESERVED_ENV_KEYS.has(key)) {
      throw new ProviderError(
        `env var '${key}' is reserved; the agent identity comes from the deploy ` +
          `payload, not from env`,
      );
    }
  }

  const token = (deps.loadToken ?? loadAdminToken)(
    requireString(config, "torana_admin_token_ref") ?? "default",
  );

  const body: Record<string, unknown> = {
    agent_id: agentId,
    relay_url: relayUrl,
    private_key: nsec,
    auth_tag: authTag,
    community_id: requireString(config, "community_id") ?? "primary",
    respond_to:
      requireString(config, "respond_to") ??
      (typeof agent.respond_to === "string" ? agent.respond_to : "owner_only"),
    subscribe: requireString(config, "subscribe") ?? "mentions_and_dms",
    ...(ownerPubkey ? { owner_pubkey: ownerPubkey } : {}),
    ...(agent.respond_to_allowlist?.length
      ? { allowed_pubkeys: agent.respond_to_allowlist }
      : {}),
    ...(request.request_id ? { deploy_nonce: request.request_id } : {}),
  };

  const base = toranaUrl.replace(/\/+$/, "");
  const url = `${base}/v1/admin/buzz/endpoints/${encodeURIComponent(endpointId)}`;

  // One create attempt per call (normative). A deterministic failure cannot
  // be fixed by re-running the identical create inside the same call, and
  // retrying would churn state every poll interval; retry is gated on fresh
  // owner intent, i.e. another Start.
  const created = await fetchImpl(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const createdBody = await safeJson(created);
  if (!created.ok) {
    // Torana's message is surfaced verbatim: for an unknown agent it lists the
    // configured ones, which is exactly what the operator needs.
    throw new ProviderError(
      `Torana refused the deploy (HTTP ${created.status}): ${
        messageOf(createdBody) ?? "no detail"
      }`,
    );
  }

  const deadline = now() + readyTimeoutMs;
  let lastStatus = "unknown";
  for (;;) {
    const status = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const statusBody = (await safeJson(status)) as Record<string, unknown>;
    if (status.ok) {
      const connected = statusBody.connected === true;
      const presence = statusBody.presence as {
        last_published_at?: number | null;
        stale?: boolean;
      } | null;
      lastStatus = `runtime_state=${String(statusBody.runtime_state)} connected=${connected}`;
      if (connected && presence?.last_published_at && !presence.stale) {
        const reconciliation =
          createdBody && typeof createdBody === "object"
            ? (createdBody as { result?: unknown }).result
            : undefined;
        return {
          ok: true,
          agent_id: backendAgentId(endpointId),
          endpoint_id: endpointId,
          result:
            typeof reconciliation === "string" ? reconciliation : "deployed",
          message: managedByToranaMessage(agent),
        };
      }
    } else {
      lastStatus = `HTTP ${status.status}: ${messageOf(statusBody) ?? "no detail"}`;
    }
    if (now() >= deadline) {
      throw new ProviderError(
        `endpoint '${endpointId}' did not come online within ${Math.round(
          readyTimeoutMs / 1000,
        )}s; last status: ${lastStatus}. The endpoint was created — check the ` +
          `gateway's logs, then press Start again to retry.`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * The addressing scheme already hand-written into Desktop records for these
 * agents, kept so a re-deploy through this provider does not orphan them.
 */
export function backendAgentId(endpointId: string): string {
  return `railway:agent-team:${endpointId}`;
}

/**
 * Knobs Torana owns are reported rather than silently dropped: a user who set
 * a model or a timeout in the Desktop should learn it has no effect here.
 */
export function managedByToranaMessage(agent: DeployRequestAgent): string {
  const supplied = TORANA_MANAGED_FIELDS.filter((field) => {
    const value = agent[field];
    return value !== undefined && value !== null && value !== "";
  });
  const base =
    "Deployed. Torana keeps this agent online independently of this Desktop; " +
    "use !shutdown in a channel to stop it.";
  if (supplied.length === 0) return base;
  return `${base} These settings are managed by Torana's own configuration and were not applied: ${supplied.join(", ")}.`;
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function messageOf(body: unknown): string | null {
  if (body && typeof body === "object" && "message" in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return null;
}

/**
 * Scrub secret material out of anything we are about to emit.
 *
 * The Desktop redacts provider output, but a provider that relies on that has
 * already lost: the values pass through this process, and an upstream error
 * string is a perfectly ordinary way for one to come back out. Literal values
 * from the request are removed longest-first so a substring cannot survive its
 * container, and the `nsec1…`/`sprt_tok_…` shapes are removed regardless of
 * where they came from.
 */
export function scrubSecrets(
  text: string,
  literals: readonly (string | null | undefined)[] = [],
): string {
  let scrubbed = text;
  const values = literals
    .filter(
      (value): value is string =>
        typeof value === "string" && value.length >= 4,
    )
    .sort((a, b) => b.length - a.length);
  for (const value of values) {
    scrubbed = scrubbed.split(value).join("[redacted]");
  }
  return scrubbed
    .replace(/nsec1[0-9a-z]{6,}/gi, "[redacted]")
    .replace(/sprt_tok_[A-Za-z0-9_-]{4,}/g, "[redacted]");
}

function secretsIn(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const request = raw as ProviderRequest;
  const agent = request.agent ?? {};
  return [
    typeof agent.private_key_nsec === "string" ? agent.private_key_nsec : "",
    typeof agent.auth_tag === "string" ? agent.auth_tag : "",
    ...Object.values(agent.env_vars ?? {}),
  ].filter((value) => value.length >= 4);
}

/** Route one request object to its op. Never throws; failures are in-band. */
export async function handleRequest(
  raw: unknown,
  version: string,
  deps: DeployDeps = {},
): Promise<ProviderResponse> {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: "request must be a JSON object" };
    }
    const request = raw as ProviderRequest;
    switch (request.op) {
      case "info":
        return infoResponse(version);
      case "deploy":
        return await deploy(request, deps);
      case undefined:
        return { ok: false, error: "request has no 'op'" };
      default:
        return {
          ok: false,
          error: `unsupported op '${String(request.op)}'; this provider speaks info and deploy (protocol_version ${PROTOCOL_VERSION})`,
        };
    }
  } catch (error) {
    let token: string | null = null;
    try {
      // Best-effort: include the bearer in the scrub set when we can resolve
      // it, so an upstream error echoing an Authorization header is covered.
      const ref =
        typeof (raw as ProviderRequest)?.provider_config?.[
          "torana_admin_token_ref"
        ] === "string"
          ? String(
              (raw as ProviderRequest).provider_config![
                "torana_admin_token_ref"
              ],
            )
          : "default";
      token = (deps.loadToken ?? loadAdminToken)(ref);
    } catch {
      token = null;
    }
    return {
      ok: false,
      error: scrubSecrets(
        error instanceof Error ? error.message : String(error),
        [...secretsIn(raw), token],
      ),
    };
  }
}

/**
 * Cap our own output at the contract's limits. The Desktop truncates anyway;
 * emitting an over-long object and letting it be cut mid-JSON would turn a
 * clean failure into an unparseable one.
 */
export function encodeResponse(response: ProviderResponse): string {
  const encoded = JSON.stringify(response);
  if (Buffer.byteLength(encoded, "utf8") <= MAX_STDOUT_BYTES) return encoded;
  return JSON.stringify({
    ok: false,
    error: "provider response exceeded the 1MB stdout budget and was discarded",
  });
}

export function encodeStderr(message: string): string {
  const bytes = Buffer.from(message, "utf8");
  return bytes.length <= MAX_STDERR_BYTES
    ? message
    : bytes.subarray(0, MAX_STDERR_BYTES).toString("utf8");
}

export async function main(
  version: string,
  stdin: ReadableStream<Uint8Array> | null = Bun.stdin.stream(),
): Promise<number> {
  let text = "";
  if (stdin) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stdin as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    process.stdout.write(
      encodeResponse({ ok: false, error: "stdin was not a JSON object" }),
    );
    return 1;
  }
  const response = await handleRequest(parsed, version);
  process.stdout.write(encodeResponse(response));
  // Non-zero exit is failure even when stdout parsed, so the two must agree.
  return response.ok ? 0 : 1;
}

if (import.meta.main) {
  const pkg = (await import("../../package.json", {
    with: { type: "json" },
  })) as { default: { version: string } };
  process.exit(await main(pkg.default.version));
}
