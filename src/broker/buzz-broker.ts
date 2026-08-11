import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { Server } from "bun";
import { verifyEvent, type Event } from "nostr-tools";

import type { Config } from "../config/schema.js";
import type {
  NormalizedConfigModel,
  NormalizedEndpointConfig,
} from "../config/v2.js";
import { logger } from "../log.js";
import { BuzzRelayClient } from "../platform/buzz/client.js";
import {
  discoverChannelIds,
  discoveryFilters,
  firstTag,
  isValidInboundEvent,
} from "../platform/buzz/protocol.js";
import type { ConversationRef } from "../platform/types.js";
import {
  assertBuzzOptionPolicy,
  buzzCommandPath,
  isKnownBuzzCommand,
  isReadOnlyBuzzCommand,
  resolveBuzzPolicy,
} from "./buzz-policy.js";

const log = logger("buzz.broker");
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const OPTION_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const EVENT_ID = /^[0-9a-f]{64}$/;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_OPTION_VALUES = 32;
const MEMBERSHIP_CACHE_MS = 10_000;
const FORBIDDEN_OPTIONS = new Set([
  "auth-tag",
  "cli-path",
  "config",
  "endpoint",
  "env",
  "format",
  "private-key",
  "relay-url",
]);
const FILE_OPTIONS = new Set([
  "body-file",
  "file",
  "patch-file",
  "templates-file",
]);
const STDIN_FILE_OPTIONS = new Set(["body-file", "patch-file"]);
const EVENT_REFERENCE_OPTIONS = new Set([
  "event",
  "issue",
  "pr",
  "reply-to",
  "report",
  "revision",
  "revision-of",
  "root",
]);
const REQUEST_FIELDS = new Set([
  "command",
  "group",
  "nestedCommand",
  "options",
  "positionals",
  "stdin",
]);

export interface BuzzBrokerRequest {
  group: string;
  command: string;
  nestedCommand?: string;
  options?: Record<string, string | number | boolean | string[]>;
  positionals?: string[];
  stdin?: string;
}

export interface BuzzBrokerResponse {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stdoutBase64?: string;
  stderr: string;
  error?: string;
}

interface Capability {
  token: string;
  agentId: string;
  endpointId: string;
  sessionId: string;
  expiresAt: number;
}

export interface BuzzCapabilityFile {
  version: 1;
  transport: "unix" | "http";
  socketPath?: string;
  url?: string;
  token: string;
  expiresAt: number;
}

interface SpawnResult {
  exitCode: number;
  stdout: string | Uint8Array;
  stderr: string;
}

export interface BuzzCredentialBrokerOptions {
  config: Config;
  normalized: NormalizedConfigModel;
  clock?: () => number;
  spawnCli?: (args: {
    argv: string[];
    env: Record<string, string>;
    cwd: string;
    stdin: string;
    timeoutMs: number;
  }) => Promise<SpawnResult>;
  discoverMembership?: (
    endpoint: NormalizedEndpointConfig,
  ) => Promise<ReadonlySet<string>>;
  resolveEvent?: (
    endpoint: NormalizedEndpointConfig,
    eventId: string,
  ) => Promise<Event | null>;
  allowedOptions?: (commandPath: string) => Promise<ReadonlySet<string>>;
  verifyCli?: () => void;
}

export class BuzzCredentialBroker {
  readonly capabilityDir: string;
  readonly socketPath: string;

  private config: Config;
  private normalized: NormalizedConfigModel;
  private clock: () => number;
  private spawnCli: NonNullable<BuzzCredentialBrokerOptions["spawnCli"]>;
  private discoverMembership: NonNullable<
    BuzzCredentialBrokerOptions["discoverMembership"]
  >;
  private resolveEvent: NonNullable<
    BuzzCredentialBrokerOptions["resolveEvent"]
  >;
  private allowedOptions: NonNullable<
    BuzzCredentialBrokerOptions["allowedOptions"]
  >;
  private verifyCli: () => void;
  private optionCache = new Map<string, ReadonlySet<string>>();
  private capabilities = new Map<string, Capability>();
  private tokenBySession = new Map<string, string>();
  private membershipCache = new Map<
    string,
    { expiresAt: number; channels: ReadonlySet<string> }
  >();
  private unixListener: ReturnType<typeof Bun.listen> | null = null;
  private httpServer: Server<unknown> | null = null;
  private httpUrl: string | null = null;

  constructor(opts: BuzzCredentialBrokerOptions) {
    this.config = opts.config;
    this.normalized = opts.normalized;
    this.clock = opts.clock ?? Date.now;
    this.spawnCli = opts.spawnCli ?? spawnBuzzCli;
    this.discoverMembership =
      opts.discoverMembership ?? ((endpoint) => this.fetchMembership(endpoint));
    this.resolveEvent =
      opts.resolveEvent ??
      ((endpoint, eventId) => this.fetchEvent(endpoint, eventId));
    this.allowedOptions =
      opts.allowedOptions ?? ((commandPath) => this.fetchOptions(commandPath));
    this.verifyCli =
      opts.verifyCli ??
      (opts.spawnCli ? () => {} : () => this.verifyConfiguredCli());
    const base = resolve(this.config.gateway.data_dir, "buzz-broker");
    this.capabilityDir = join(base, "capabilities");
    this.socketPath = join(base, "broker.sock");
  }

  get enabled(): boolean {
    return Boolean(this.normalized.buzzTools?.length);
  }

  start(): void {
    if (!this.enabled || this.unixListener || this.httpServer) return;
    mkdirSync(this.capabilityDir, { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.socketPath), 0o700);
    this.verifyCli();
    if (process.platform === "win32") {
      this.startHttp();
      return;
    }
    rmSync(this.socketPath, { force: true });
    const buffers = new WeakMap<object, string>();
    this.unixListener = Bun.listen({
      unix: this.socketPath,
      socket: {
        data: (socket, chunk) => {
          const current =
            (buffers.get(socket as unknown as object) ?? "") +
            Buffer.from(chunk).toString("utf8");
          if (Buffer.byteLength(current) > MAX_REQUEST_BYTES) {
            socket.write(
              `${JSON.stringify(errorResponse("broker request is too large"))}\n`,
            );
            socket.end();
            return;
          }
          const newline = current.indexOf("\n");
          if (newline < 0) {
            buffers.set(socket as unknown as object, current);
            return;
          }
          buffers.delete(socket as unknown as object);
          void this.handleRpc(current.slice(0, newline)).then((response) => {
            socket.write(`${JSON.stringify(response)}\n`);
            socket.end();
          });
        },
        error: (_socket, error) => {
          log.warn("Buzz broker socket error", { error: error.message });
        },
      },
    });
    chmodSync(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    this.unixListener?.stop(true);
    this.unixListener = null;
    if (this.httpServer) await this.httpServer.stop(true);
    this.httpServer = null;
    this.httpUrl = null;
    rmSync(this.socketPath, { force: true });
    for (const sessionId of [...this.tokenBySession.keys()]) {
      this.revokeCapability(sessionId);
    }
  }

  runnerEnvironment(agentId: string): Record<string, string> {
    const tools = this.toolsFor(agentId);
    if (!tools) return {};
    const result: Record<string, string> = {
      TORANA_BUZZ_CAPABILITY_DIR: this.capabilityDir,
    };
    if (!tools.exposePrivateKeyToRunner) return result;
    const endpoint = this.endpointForId(tools.defaultEndpointId ?? "");
    if (!endpoint?.buzz) return result;
    result.BUZZ_RELAY_URL = endpoint.buzz.relayUrl;
    result.BUZZ_PRIVATE_KEY = endpoint.buzz.privateKey;
    if (endpoint.buzz.authTag) result.BUZZ_AUTH_TAG = endpoint.buzz.authTag;
    return result;
  }

  /**
   * Mint a session-scoped capability for one turn.
   *
   * `conversation` is null for turns that have no conversation to resolve an
   * endpoint from — Agent API `ask`. That case falls through to the agent's
   * configured `defaultEndpointId`, the same branch a non-Buzz conversation
   * already takes. Callers must not fabricate a `ConversationRef` to reach
   * it: a synthetic ref with `platform: "buzz"` would need an `endpointId`
   * the caller does not have.
   *
   * `ttlMs` overrides the default lifetime, which is derived from
   * `worker_tuning.turn_timeout_secs` — the *managed*-turn budget. Callers
   * on a different clock (Agent API turns clamp to
   * `agent_api.ask.max_timeout_ms`) must pass their own, or a long turn can
   * outlive its own capability. Clamped to the same 1 minute .. 24 hour
   * bounds as the default.
   */
  issueCapability(args: {
    agentId: string;
    sessionId: string;
    conversation: ConversationRef | null;
    ttlMs?: number;
  }): BuzzCapabilityFile | null {
    if (!SESSION_ID.test(args.sessionId)) {
      throw new Error("invalid runner session id for Buzz capability");
    }
    const tools = this.toolsFor(args.agentId);
    if (!tools) return null;
    const endpointId =
      args.conversation?.platform === "buzz"
        ? args.conversation.endpointId
        : tools.defaultEndpointId;
    if (!endpointId || !tools.allowedEndpointIds.includes(endpointId)) {
      this.revokeCapability(args.sessionId);
      return null;
    }
    const endpoint = this.endpointForId(endpointId);
    if (!endpoint?.buzz || !endpoint.enabled) {
      this.revokeCapability(args.sessionId);
      return null;
    }
    this.revokeCapability(args.sessionId);
    const token = randomBytes(32).toString("base64url");
    const capability: Capability = {
      token,
      agentId: args.agentId,
      endpointId,
      sessionId: args.sessionId,
      expiresAt:
        this.clock() +
        Math.min(
          24 * 60 * 60 * 1000,
          Math.max(
            60_000,
            args.ttlMs ??
              this.config.worker_tuning.turn_timeout_secs * 1000 + 60_000,
          ),
        ),
    };
    this.capabilities.set(token, capability);
    this.tokenBySession.set(args.sessionId, token);
    const file: BuzzCapabilityFile = {
      version: 1,
      transport: process.platform === "win32" ? "http" : "unix",
      ...(process.platform === "win32"
        ? { url: this.httpUrl ?? undefined }
        : { socketPath: this.socketPath }),
      token,
      expiresAt: capability.expiresAt,
    };
    writeJsonAtomic(this.capabilityPath(args.sessionId), file);
    return file;
  }

  revokeCapability(sessionId: string): void {
    const token = this.tokenBySession.get(sessionId);
    if (token) this.capabilities.delete(token);
    this.tokenBySession.delete(sessionId);
    rmSync(this.capabilityPath(sessionId), { force: true });
  }

  async execute(
    token: string,
    request: BuzzBrokerRequest,
  ): Promise<BuzzBrokerResponse> {
    try {
      const capability = this.requireCapability(token);
      const endpoint = this.endpointForId(capability.endpointId);
      if (!endpoint?.buzz)
        throw new Error("bound Buzz endpoint is unavailable");
      const tools = this.toolsFor(capability.agentId);
      if (!tools) throw new Error("Buzz tools policy is unavailable");
      const commandPath = validateRequest(request);
      const allowed = resolveBuzzPolicy({
        profile: tools.policy,
        allowedCommands: tools.allowedCommands,
        acknowledgeDangerous: tools.acknowledgeDangerous,
      });
      if (!allowed.has(commandPath)) {
        throw new Error(`Buzz command '${commandPath}' is denied by policy`);
      }
      assertBuzzOptionPolicy({
        commandPath,
        optionNames: Object.keys(request.options ?? {}),
        profile: tools.policy,
        acknowledgeDangerous: tools.acknowledgeDangerous,
      });
      const allowedOptions = await this.allowedOptions(commandPath);
      for (const name of Object.keys(request.options ?? {})) {
        if (!allowedOptions.has(name)) {
          throw new Error(
            `Buzz option '--${name}' is not valid for '${commandPath}'`,
          );
        }
      }
      await this.validateResources(endpoint, commandPath, request);
      const stagedFiles: string[] = [];
      try {
        const argv = await this.buildArgv(
          capability.agentId,
          request,
          stagedFiles,
        );
        const result = await this.spawnCli({
          argv,
          env: {
            PATH: process.env.PATH ?? "",
            BUZZ_RELAY_URL: endpoint.buzz.relayUrl,
            BUZZ_PRIVATE_KEY: endpoint.buzz.privateKey,
            ...(endpoint.buzz.authTag
              ? { BUZZ_AUTH_TAG: endpoint.buzz.authTag }
              : {}),
          },
          cwd: this.runnerCwd(capability.agentId),
          stdin: request.stdin ?? "",
          timeoutMs: this.normalized.limits?.broker_call_timeout_ms ?? 30_000,
        });
        log.info("Buzz broker command", {
          agent_id: capability.agentId,
          endpoint_id: capability.endpointId,
          command: commandPath,
          mutation: !isReadOnlyBuzzCommand(commandPath),
          exit_code: result.exitCode,
        });
        return {
          ok: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: Buffer.from(result.stdout).toString("utf8"),
          stdoutBase64: Buffer.from(result.stdout).toString("base64"),
          stderr: result.stderr,
        };
      } finally {
        for (const path of stagedFiles)
          rmSync(path, { recursive: true, force: true });
      }
    } catch (error) {
      return errorResponse(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private startHttp(): void {
    this.httpServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.method !== "POST")
          return new Response(null, { status: 405 });
        const raw = await request.text();
        if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) {
          return Response.json(errorResponse("broker request is too large"), {
            status: 413,
          });
        }
        return Response.json(await this.handleRpc(raw));
      },
    });
    this.httpUrl = `http://127.0.0.1:${this.httpServer.port}/call`;
  }

  private async handleRpc(raw: string): Promise<BuzzBrokerResponse> {
    try {
      const parsed = JSON.parse(raw) as {
        token?: unknown;
        request?: unknown;
      };
      if (typeof parsed.token !== "string" || !isObject(parsed.request)) {
        throw new Error("invalid Buzz broker RPC envelope");
      }
      return await this.execute(
        parsed.token,
        parsed.request as unknown as BuzzBrokerRequest,
      );
    } catch (error) {
      return errorResponse(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private requireCapability(token: string): Capability {
    const capability = this.capabilities.get(token);
    if (!capability || capability.expiresAt <= this.clock()) {
      if (capability) this.revokeCapability(capability.sessionId);
      throw new Error("Buzz broker capability is missing or expired");
    }
    return capability;
  }

  private toolsFor(agentId: string) {
    return this.normalized.buzzTools?.find(
      (tools) => tools.agentId === agentId,
    );
  }

  private endpointForId(endpointId: string): NormalizedEndpointConfig | null {
    return (
      this.normalized.endpoints.find(
        (endpoint) =>
          endpoint.id === endpointId && endpoint.platform === "buzz",
      ) ?? null
    );
  }

  private runnerCwd(agentId: string): string {
    const runner = this.config.bots.find((bot) => bot.id === agentId)?.runner;
    return resolve(runner?.cwd ?? process.cwd());
  }

  private capabilityPath(sessionId: string): string {
    return join(this.capabilityDir, `${sessionId}.json`);
  }

  private async validateResources(
    endpoint: NormalizedEndpointConfig,
    commandPath: string,
    request: BuzzBrokerRequest,
  ): Promise<void> {
    const channel = optionString(request.options, "channel");
    if (channel) {
      const memberships = await this.memberships(endpoint);
      if (!memberships.has(channel)) {
        throw new Error(
          "target channel is not accessible to the bound endpoint",
        );
      }
    }
    for (const reference of EVENT_REFERENCE_OPTIONS) {
      const eventId = optionString(request.options, reference);
      if (!eventId) continue;
      if (!EVENT_ID.test(eventId)) {
        throw new Error(`--${reference} must be a lowercase event id`);
      }
      const event = await this.resolveEvent(endpoint, eventId);
      if (!event || !verifyEvent(event)) {
        throw new Error(`target event from --${reference} was not found`);
      }
      const eventChannel = firstTag(event, "h");
      if (eventChannel) {
        const memberships = await this.memberships(endpoint);
        if (!memberships.has(eventChannel)) {
          throw new Error("target event channel is not accessible");
        }
        if (channel && eventChannel !== channel) {
          throw new Error("target event belongs to a different channel");
        }
      }
      if (
        reference === "event" &&
        (commandPath === "messages.edit" ||
          commandPath === "messages.delete") &&
        event.pubkey !== endpoint.buzz?.pubkey
      ) {
        throw new Error(
          "messages.edit/delete may target only endpoint-owned events",
        );
      }
    }
  }

  private async memberships(
    endpoint: NormalizedEndpointConfig,
  ): Promise<ReadonlySet<string>> {
    const cached = this.membershipCache.get(endpoint.id);
    if (cached && cached.expiresAt > this.clock()) return cached.channels;
    const channels = await this.discoverMembership(endpoint);
    this.membershipCache.set(endpoint.id, {
      expiresAt: this.clock() + MEMBERSHIP_CACHE_MS,
      channels,
    });
    return channels;
  }

  private async buildArgv(
    agentId: string,
    request: BuzzBrokerRequest,
    stagedFiles: string[],
  ): Promise<string[]> {
    const cliPath = this.normalized.buzzPlatform?.cli_path ?? "buzz";
    const argv = [cliPath, request.group, request.command];
    if (request.nestedCommand) argv.push(request.nestedCommand);
    const commandPath = buzzCommandPath(request);
    for (const [index, value] of (request.positionals ?? []).entries()) {
      if (commandPath.startsWith("pack.") && index === 0) {
        const staged = this.stageDirectory(agentId, value);
        stagedFiles.push(staged);
        argv.push(staged);
      } else {
        argv.push(value);
      }
    }
    for (const [name, raw] of Object.entries(request.options ?? {})) {
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        if (value === false) continue;
        argv.push(`--${name}`);
        if (value === true) continue;
        let rendered = String(value);
        if (name === "output" && rendered !== "-") {
          throw new Error("broker output paths are denied; use stdout");
        }
        if (commandPath === "emoji.export" && name === "file") {
          throw new Error("emoji.export file output is denied; use stdout");
        }
        if (FILE_OPTIONS.has(name)) {
          if (rendered === "-") {
            if (!STDIN_FILE_OPTIONS.has(name)) {
              throw new Error(`Buzz option '--${name}' does not accept stdin`);
            }
          } else {
            rendered = this.stageFile(agentId, rendered);
            stagedFiles.push(rendered);
          }
        }
        argv.push(rendered);
      }
    }
    return argv;
  }

  private stageFile(agentId: string, input: string): string {
    if (!isAbsolute(input))
      throw new Error("broker file paths must be absolute");
    const source = realpathSync(input);
    const allowedRoots = [
      resolve(this.config.gateway.data_dir, "attachments"),
      this.runnerCwd(agentId),
    ];
    if (!allowedRoots.some((root) => isWithin(source, root))) {
      throw new Error(
        "file path is outside the runner workspace and attachments",
      );
    }
    const info = lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("file argument must be a regular non-symlink file");
    }
    if (info.size > this.config.attachments.max_bytes) {
      throw new Error("file argument exceeds attachments.max_bytes");
    }
    const dir = resolve(this.config.gateway.data_dir, "buzz-broker", "files");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `${randomUUID()}.bin`);
    const fd = openSync(target, "wx", 0o600);
    closeSync(fd);
    copyFileSync(source, target);
    chmodSync(target, 0o600);
    return target;
  }

  private stageDirectory(agentId: string, input: string): string {
    if (!isAbsolute(input))
      throw new Error("broker pack paths must be absolute");
    const source = realpathSync(input);
    if (!isWithin(source, this.runnerCwd(agentId))) {
      throw new Error("pack path is outside the runner workspace");
    }
    const info = lstatSync(source);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("pack path must be a non-symlink directory");
    }
    const root = resolve(
      this.config.gateway.data_dir,
      "buzz-broker",
      "files",
      randomUUID(),
    );
    mkdirSync(root, { recursive: true, mode: 0o700 });
    let files = 0;
    let bytes = 0;
    const maxBytes =
      this.config.attachments.max_bytes * this.config.attachments.max_per_turn;
    const copyDirectory = (from: string, to: string) => {
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const sourcePath = join(from, entry.name);
        const targetPath = join(to, entry.name);
        if (entry.isSymbolicLink())
          throw new Error("pack may not contain symlinks");
        if (entry.isDirectory()) {
          mkdirSync(targetPath, { mode: 0o700 });
          copyDirectory(sourcePath, targetPath);
          continue;
        }
        if (!entry.isFile()) throw new Error("pack contains a special file");
        const fileInfo = lstatSync(sourcePath);
        files += 1;
        bytes += fileInfo.size;
        if (files > 256 || bytes > maxBytes) {
          throw new Error("pack exceeds broker file-count or byte limits");
        }
        copyFileSync(sourcePath, targetPath);
        chmodSync(targetPath, 0o600);
      }
    };
    try {
      copyDirectory(source, root);
      return root;
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  private async fetchMembership(
    endpoint: NormalizedEndpointConfig,
  ): Promise<ReadonlySet<string>> {
    if (!endpoint.buzz) return new Set();
    const client = this.clientFor(endpoint);
    try {
      await client.connect();
      const events = await client.query(
        discoveryFilters(endpoint.buzz.pubkey),
        `torana-broker-members-${randomUUID()}`.slice(0, 120),
      );
      return new Set(discoverChannelIds(events.filter(isValidInboundEvent)));
    } finally {
      client.close();
    }
  }

  private async fetchEvent(
    endpoint: NormalizedEndpointConfig,
    eventId: string,
  ): Promise<Event | null> {
    const client = this.clientFor(endpoint);
    try {
      await client.connect();
      const events = await client.query(
        [{ ids: [eventId] }],
        `torana-broker-event-${randomUUID()}`.slice(0, 120),
      );
      return (
        events.find(
          (event): event is Event =>
            isValidInboundEvent(event) && event.id === eventId,
        ) ?? null
      );
    } finally {
      client.close();
    }
  }

  private async fetchOptions(
    commandPath: string,
  ): Promise<ReadonlySet<string>> {
    const cached = this.optionCache.get(commandPath);
    if (cached) return cached;
    const cliPath = this.normalized.buzzPlatform?.cli_path ?? "buzz";
    const proc = Bun.spawn([cliPath, ...commandPath.split("."), "--help"], {
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `failed to inspect pinned Buzz command '${commandPath}': ${stderr.trim()}`,
      );
    }
    const options = new Set<string>();
    for (const match of stdout.matchAll(/--([a-z][a-z0-9-]*)\b/g)) {
      if (match[1] !== "help") options.add(match[1]!);
    }
    this.optionCache.set(commandPath, options);
    return options;
  }

  private verifyConfiguredCli(): void {
    const input = this.normalized.buzzPlatform?.cli_path ?? "buzz";
    const expected = this.normalized.buzzPlatform?.cli_sha256;
    const path = resolveExecutable(input);
    if (!path) throw new Error(`pinned Buzz CLI '${input}' was not found`);
    if (!expected) throw new Error("platforms.buzz.cli_sha256 is missing");
    const actual = new Bun.CryptoHasher("sha256")
      .update(readFileSync(path))
      .digest("hex");
    if (actual !== expected) {
      throw new Error(
        "Buzz CLI checksum does not match platforms.buzz.cli_sha256",
      );
    }
  }

  private clientFor(endpoint: NormalizedEndpointConfig): BuzzRelayClient {
    if (!endpoint.buzz) throw new Error("not a Buzz endpoint");
    return new BuzzRelayClient({
      relayUrl: endpoint.buzz.relayUrl,
      privateKey: endpoint.buzz.privateKey,
      authTag: endpoint.buzz.authTag,
      maxFrameBytes: this.normalized.buzzPlatform?.max_frame_bytes ?? 524_288,
      waitMs: this.normalized.limits?.relay_ok_wait_ms ?? 5000,
    });
  }
}

function validateRequest(request: BuzzBrokerRequest): string {
  if (!isObject(request))
    throw new Error("Buzz broker request must be an object");
  for (const field of Object.keys(request)) {
    if (!REQUEST_FIELDS.has(field)) {
      throw new Error(`unknown Buzz broker request field '${field}'`);
    }
  }
  if (request.options !== undefined && !isObject(request.options)) {
    throw new Error("Buzz broker options must be an object");
  }
  if (
    request.positionals !== undefined &&
    !Array.isArray(request.positionals)
  ) {
    throw new Error("Buzz broker positionals must be an array");
  }
  for (const field of [request.group, request.command, request.nestedCommand]) {
    if (field !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(field)) {
      throw new Error("invalid Buzz command component");
    }
  }
  const commandPath = buzzCommandPath(request);
  if (!isKnownBuzzCommand(commandPath)) {
    throw new Error(`unknown Buzz command '${commandPath}'`);
  }
  if ((request.positionals?.length ?? 0) > 8) {
    throw new Error("too many positional arguments");
  }
  for (const positional of request.positionals ?? []) {
    validateString(positional, "positional argument");
    if (positional.startsWith("-")) {
      throw new Error("positional arguments may not begin with '-'");
    }
  }
  for (const [name, raw] of Object.entries(request.options ?? {})) {
    if (!OPTION_NAME.test(name) || FORBIDDEN_OPTIONS.has(name)) {
      throw new Error(`forbidden or invalid Buzz option '${name}'`);
    }
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length > MAX_OPTION_VALUES) {
      throw new Error(`too many values for Buzz option '${name}'`);
    }
    if (Array.isArray(raw) && raw.some((value) => typeof value !== "string")) {
      throw new Error(`Buzz option '${name}' arrays may contain only strings`);
    }
    for (const value of values) {
      if (typeof value === "boolean") continue;
      if (typeof value === "number" && Number.isFinite(value)) continue;
      validateString(value, `Buzz option '${name}'`);
    }
  }
  if (request.stdin !== undefined) validateString(request.stdin, "stdin");
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) {
    throw new Error("Buzz broker request is too large");
  }
  return commandPath;
}

function validateString(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > 65_536
  ) {
    throw new Error(`${label} is invalid or too large`);
  }
}

function optionString(
  options: BuzzBrokerRequest["options"],
  name: string,
): string | null {
  const value = options?.[name];
  return typeof value === "string" ? value : null;
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(realpathOrResolve(root), path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realpathOrResolve(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function resolveExecutable(input: string): string | null {
  if (isAbsolute(input)) return existsSync(input) ? input : null;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, input);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

function errorResponse(message: string): BuzzBrokerResponse {
  return { ok: false, exitCode: 1, stdout: "", stderr: "", error: message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function spawnBuzzCli(args: {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
  timeoutMs: number;
}): Promise<SpawnResult> {
  const proc = Bun.spawn(args.argv, {
    cwd: args.cwd,
    env: args.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(args.stdin);
  proc.stdin.end();
  const timeout = setTimeout(() => proc.kill("SIGKILL"), args.timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      readBounded(proc.stdout, proc, "stdout"),
      readBounded(proc.stderr, proc, "stderr"),
    ]);
    return { exitCode, stdout, stderr: stderr.toString("utf8") };
  } finally {
    clearTimeout(timeout);
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  proc: { kill(signal?: number | NodeJS.Signals): void },
  label: string,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_OUTPUT_BYTES) {
      proc.kill("SIGKILL");
      throw new Error(`Buzz CLI ${label} exceeded the output limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
