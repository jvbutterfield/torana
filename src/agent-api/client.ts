// Typed HTTP client for the agent-api surface. Used by the CLI and any
// external TypeScript code that wants to drive a torana gateway without
// reimplementing fetch + error mapping.
//
// Design:
//
// - Methods throw `AgentApiError` on non-2xx; CLI catches and renders.
// - Multipart construction lives here so callers don't need to know the
//   field names.
// - `fetchImpl` is injectable so tests can route through a fake without
//   spinning up a server (and so the real CLI can use globalThis.fetch).
// - No retry logic: ask is non-idempotent without a session_id, and send
//   uses an explicit Idempotency-Key. Retry is the caller's call.
//
// Error mapping: every non-2xx response body of the form `{error: <code>,
// message?: <string>}` is parsed; the `code` populates `AgentApiError.code`.
// Network-level failures throw a `network` code.

import type { AgentApiErrorCode } from "./errors.js";

export interface AgentApiClientOptions {
  /** Base URL of the gateway, e.g. `http://localhost:8787`. No trailing slash. */
  server: string;
  /** Bearer token (raw secret, not the SHA-256 hash). */
  token: string;
  /** Override for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export type ErrorKind = AgentApiErrorCode | "network" | "malformed_response";

export class AgentApiError extends Error {
  readonly code: ErrorKind;
  readonly status: number;
  readonly body: unknown;

  constructor(args: {
    code: ErrorKind;
    status: number;
    message: string;
    body?: unknown;
  }) {
    super(args.message);
    this.name = "AgentApiError";
    this.code = args.code;
    this.status = args.status;
    this.body = args.body;
  }
}

export interface BotsListItem {
  bot_id: string;
  supports_side_sessions: boolean;
  // Present iff the gateway has `agent_api.expose_runner_type: true`.
  // Off by default — see docs/agent-api.md "Security model".
  runner_type?: string;
}

export interface BotsListResponse {
  bots: BotsListItem[];
}

export interface AskRequest {
  text: string;
  session_id?: string;
  timeout_ms?: number;
}

/** Response from `POST /v1/bots/:id/ask`. Discriminated on `status`. */
export type AskResponse =
  | {
      status: "done";
      turn_id: number;
      session_id: string;
      text: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      duration_ms?: number;
    }
  | {
      status: "in_progress";
      turn_id: number;
      session_id: string;
    };

export interface SendRequest {
  text: string;
  source: string;
  user_id?: string;
  chat_id?: number;
}

export interface SendResponse {
  turn_id: number;
  status: "queued" | "in_progress" | "done" | "failed";
}

/** Response from `GET /v1/turns/:id`. */
export type TurnResponse =
  | { turn_id: number; status: "in_progress" }
  | {
      turn_id: number;
      status: "done";
      text?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      duration_ms?: number;
    }
  | { turn_id: number; status: "failed"; error?: string };

export interface SessionSnapshot {
  session_id: string;
  started_at: string;
  last_used_at: string;
  hard_expires_at: string;
  state: string;
  inflight: number;
  ephemeral: boolean;
}

export interface SessionsListResponse {
  sessions: SessionSnapshot[];
}

/**
 * Attachment payload supplied by the CLI. The client wraps each entry in
 * a Blob and adds it to the multipart form under field name `file`.
 */
export interface FileUpload {
  /** Bytes to upload. */
  data: Uint8Array | ArrayBuffer;
  /** Original filename hint — server uses it for nothing except logs. */
  filename: string;
  /** MIME type. Must match the server's allowlist. */
  contentType: string;
}

const DEFAULT_NETWORK_MSG = "request failed";

export class AgentApiClient {
  private readonly server: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AgentApiClientOptions) {
    this.server = opts.server.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async listBots(): Promise<BotsListResponse> {
    const r = await this.request("GET", "/v1/bots");
    return (await this.readJson(r)) as BotsListResponse;
  }

  async ask(
    botId: string,
    body: AskRequest,
    files?: FileUpload[],
  ): Promise<AskResponse> {
    const path = `/v1/bots/${encodeURIComponent(botId)}/ask`;
    const r =
      files && files.length > 0
        ? await this.requestMultipart("POST", path, fieldsForAsk(body), files)
        : await this.request("POST", path, {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

    const json = (await this.readJson(r)) as Record<string, unknown>;
    if (r.status === 200) {
      return {
        status: "done",
        turn_id: requiredNumber(json, "turn_id"),
        session_id: requiredString(json, "session_id"),
        text: requiredString(json, "text"),
        usage: optionalUsage(json.usage),
        duration_ms: optionalNumber(json, "duration_ms"),
      };
    }
    if (r.status === 202) {
      return {
        status: "in_progress",
        turn_id: requiredNumber(json, "turn_id"),
        session_id: requiredString(json, "session_id"),
      };
    }
    throw new AgentApiError({
      code: "malformed_response",
      status: r.status,
      message: `unexpected status from ask: ${r.status}`,
      body: json,
    });
  }

  async send(
    botId: string,
    body: SendRequest,
    opts: { idempotencyKey: string; files?: FileUpload[] },
  ): Promise<SendResponse> {
    const path = `/v1/bots/${encodeURIComponent(botId)}/send`;
    const headers: Record<string, string> = {
      "Idempotency-Key": opts.idempotencyKey,
    };
    const r =
      opts.files && opts.files.length > 0
        ? await this.requestMultipart(
            "POST",
            path,
            fieldsForSend(body),
            opts.files,
            headers,
          )
        : await this.request("POST", path, {
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

    const json = (await this.readJson(r)) as Record<string, unknown>;
    if (r.status === 202) {
      return {
        turn_id: requiredNumber(json, "turn_id"),
        status: requiredEnum(json, "status", [
          "queued",
          "in_progress",
          "done",
          "failed",
        ] as const),
      };
    }
    throw new AgentApiError({
      code: "malformed_response",
      status: r.status,
      message: `unexpected status from send: ${r.status}`,
      body: json,
    });
  }

  async getTurn(turnId: number): Promise<TurnResponse> {
    const r = await this.request(
      "GET",
      `/v1/turns/${encodeURIComponent(String(turnId))}`,
    );
    const json = (await this.readJson(r)) as Record<string, unknown>;
    const status = requiredEnum(json, "status", [
      "in_progress",
      "done",
      "failed",
    ] as const);
    const turn_id = requiredNumber(json, "turn_id");
    if (status === "in_progress") return { turn_id, status };
    if (status === "failed") {
      return {
        turn_id,
        status,
        error: typeof json.error === "string" ? json.error : undefined,
      };
    }
    return {
      turn_id,
      status,
      text: typeof json.text === "string" ? json.text : undefined,
      usage: optionalUsage(json.usage),
      duration_ms: optionalNumber(json, "duration_ms"),
    };
  }

  async listSessions(botId: string): Promise<SessionsListResponse> {
    const r = await this.request(
      "GET",
      `/v1/bots/${encodeURIComponent(botId)}/sessions`,
    );
    return (await this.readJson(r)) as SessionsListResponse;
  }

  async deleteSession(botId: string, sessionId: string): Promise<void> {
    const path = `/v1/bots/${encodeURIComponent(botId)}/sessions/${encodeURIComponent(sessionId)}`;
    const r = await this.request("DELETE", path);
    if (r.status === 204) return;
    // Rare — handler returns 204 on success; anything else is an error
    // body that request() would have already raised. Belt-and-braces:
    throw new AgentApiError({
      code: "malformed_response",
      status: r.status,
      message: `unexpected status from deleteSession: ${r.status}`,
    });
  }

  // ---- transport helpers --------------------------------------------------

  private async request(
    method: string,
    path: string,
    init?: { headers?: Record<string, string>; body?: BodyInit },
  ): Promise<Response> {
    const url = `${this.server}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      ...(init?.headers ?? {}),
    };
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: init?.body,
      });
    } catch (err) {
      throw new AgentApiError({
        code: "network",
        status: 0,
        message: err instanceof Error ? err.message : DEFAULT_NETWORK_MSG,
      });
    }
    if (response.status >= 200 && response.status < 300) return response;
    throw await this.buildError(response);
  }

  private async requestMultipart(
    method: string,
    path: string,
    fields: Record<string, string>,
    files: FileUpload[],
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const f of files) {
      // Copy through a fresh ArrayBuffer so the BlobPart type narrows; the
      // alternative (declaring `data: ArrayBuffer | Uint8Array`) trips
      // SharedArrayBuffer/ArrayBuffer variance under strict tsc.
      const part: ArrayBuffer =
        f.data instanceof Uint8Array
          ? (f.data.slice().buffer as ArrayBuffer)
          : (f.data as ArrayBuffer);
      const blob = new Blob([part], { type: f.contentType });
      form.append("file", blob, f.filename);
    }
    return this.request(method, path, { headers: extraHeaders, body: form });
  }

  private async buildError(response: Response): Promise<AgentApiError> {
    let parsed: Record<string, unknown> | null = null;
    let text = "";
    try {
      text = await response.text();
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      // body not JSON — fall through; we'll surface the status text instead
    }
    const code = (
      parsed && typeof parsed.error === "string"
        ? parsed.error
        : "internal_error"
    ) as ErrorKind;
    const message =
      (parsed && typeof parsed.message === "string" ? parsed.message : null) ??
      text ??
      response.statusText;
    return new AgentApiError({
      code,
      status: response.status,
      message,
      body: parsed ?? text,
    });
  }

  private async readJson(r: Response): Promise<unknown> {
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      throw new AgentApiError({
        code: "malformed_response",
        status: r.status,
        message: "response body was not valid JSON",
      });
    }
    return body;
  }
}

// ---- helpers ---------------------------------------------------------------

function fieldsForAsk(body: AskRequest): Record<string, string> {
  const out: Record<string, string> = { text: body.text };
  if (body.session_id) out.session_id = body.session_id;
  if (body.timeout_ms !== undefined) out.timeout_ms = String(body.timeout_ms);
  return out;
}

function fieldsForSend(body: SendRequest): Record<string, string> {
  const out: Record<string, string> = { text: body.text, source: body.source };
  if (body.user_id) out.user_id = body.user_id;
  if (body.chat_id !== undefined) out.chat_id = String(body.chat_id);
  return out;
}

function requiredString(json: Record<string, unknown>, field: string): string {
  const v = json[field];
  if (typeof v !== "string") {
    throw new AgentApiError({
      code: "malformed_response",
      status: 0,
      message: `response missing string field '${field}'`,
      body: json,
    });
  }
  return v;
}

function requiredNumber(json: Record<string, unknown>, field: string): number {
  const v = json[field];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new AgentApiError({
      code: "malformed_response",
      status: 0,
      message: `response missing number field '${field}'`,
      body: json,
    });
  }
  return v;
}

function optionalNumber(
  json: Record<string, unknown>,
  field: string,
): number | undefined {
  const v = json[field];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function requiredEnum<const T extends readonly string[]>(
  json: Record<string, unknown>,
  field: string,
  options: T,
): T[number] {
  const v = json[field];
  if (typeof v !== "string" || !(options as readonly string[]).includes(v)) {
    throw new AgentApiError({
      code: "malformed_response",
      status: 0,
      message: `response field '${field}' was not one of ${options.join("|")}`,
      body: json,
    });
  }
  return v as T[number];
}

function optionalUsage(
  v: unknown,
): { input_tokens?: number; output_tokens?: number } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const out: { input_tokens?: number; output_tokens?: number } = {};
  if (typeof o.input_tokens === "number") out.input_tokens = o.input_tokens;
  if (typeof o.output_tokens === "number") out.output_tokens = o.output_tokens;
  return Object.keys(out).length ? out : undefined;
}
