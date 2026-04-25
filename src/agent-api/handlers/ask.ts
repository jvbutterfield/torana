// POST /v1/bots/:bot_id/ask handler.
//
// Flow (tasks/impl-agent-api.md §6.1):
//   1. Parse + validate body (JSON only in Phase 4a; multipart in Phase 5).
//   2. Check runner supports side sessions; clamp timeout_ms.
//   3. pool.acquire(bot, session_id?) — may return ok/busy/capacity/
//      runner_error/runner_does_not_support_side_sessions.
//   4. db.insertAskTurn — synthetic inbound + turn row status='running'.
//   5. Subscribe to onSide(done|error|fatal|text_delta) + setTimeout.
//   6. runner.sendSideTurn(sessionId, turnId, text, attachments).
//   7. On done: setTurnFinalText + 200 with text. On timeout: attach
//      orphan listener + 202. On error: 500 runner_error + retriable
//      header. On fatal: pool.stop + 503.
//
// Invariant: exactly one of (handler finally, orphan listener terminal)
// calls pool.release for any given acquire.

import { randomUUID } from "node:crypto";

import type { Attachment } from "../../telegram/types.js";
import type {
  AgentRunner,
  RunnerEvent,
  RunnerEventHandler,
  Unsubscribe,
} from "../../runner/types.js";
import type { AgentApiDeps, AuthedHandler } from "../types.js";
import type { OrphanListenerManager } from "../orphan-listeners.js";
import type { SideSessionPool } from "../pool.js";
import { AskBodySchema } from "../schemas.js";
import { errorResponse, jsonResponse } from "../errors.js";
import { cleanupFiles, parseMultipartRequest } from "../attachments.js";
import { readJsonBody } from "../body.js";
import { recordAsk } from "../metrics.js";

export interface AskDeps extends AgentApiDeps {
  pool: SideSessionPool;
  orphans: OrphanListenerManager;
}

export function handleAsk(deps: AskDeps): AuthedHandler {
  const inner = handleAskInner(deps);
  return async (req, params) => {
    const startMs = Date.now();
    const resp = await inner(req, params);
    recordAsk(deps.metrics, params.botId, {
      // narrow: every exit path is one of the documented ask statuses.
      status: resp.status as
        | 200
        | 202
        | 400
        | 401
        | 403
        | 404
        | 429
        | 500
        | 501
        | 503,
      durationMs: Date.now() - startMs,
    });
    return resp;
  };
}

function handleAskInner(deps: AskDeps): AuthedHandler {
  return async (req, { botId, token }) => {
    // 1. Parse body — JSON or multipart. Multipart writes files to disk
    //    up-front; on any failure before the turn row lands, we unlink them.
    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    const isMultipart = contentType.includes("multipart/form-data");
    const requestId = randomUUID();

    let bodyRaw: unknown;
    let attachments: Attachment[] = [];
    if (isMultipart) {
      const multipart = await parseMultipartRequest(
        req,
        deps.config,
        botId,
        requestId,
      );
      if (multipart.kind === "err") {
        return errorResponse(multipart.code, multipart.detail);
      }
      attachments = multipart.attachments;
      bodyRaw = {
        text: multipart.text,
        session_id: multipart.fields.session_id,
        timeout_ms: multipart.fields.timeout_ms,
      };
    } else {
      const read = await readJsonBody(
        req,
        deps.config.agent_api.ask.max_body_bytes,
      );
      if (read.kind === "err") {
        return errorResponse(read.code, read.detail);
      }
      bodyRaw = read.value;
    }
    const parsed = AskBodySchema.safeParse(bodyRaw);
    if (!parsed.success) {
      await cleanupFiles(attachments.map((a) => a.path));
      const issue = parsed.error.issues[0];
      if (issue?.path?.[0] === "timeout_ms") {
        return errorResponse("invalid_timeout", issue.message);
      }
      return errorResponse("invalid_body", issue?.message);
    }
    const body = parsed.data;

    // 2. Runner readiness precheck.
    const bot = deps.registry.bot(botId)!;
    if (!bot.runner.supportsSideSessions()) {
      await cleanupFiles(attachments.map((a) => a.path));
      return errorResponse("runner_does_not_support_side_sessions");
    }

    const askCfg = deps.config.agent_api.ask;
    const timeoutMs = Math.min(
      body.timeout_ms ?? askCfg.default_timeout_ms,
      askCfg.max_timeout_ms,
    );

    // 3. Acquire side session. Per-token cap: explicit token override falls
    //    back to the config-wide default (schema default 8). Both are always
    //    set in production; the `??` keeps stub tokens in tests valid.
    const tokenLimit =
      token.maxConcurrentSideSessions ??
      deps.config.agent_api.side_sessions.max_per_token_default;
    const acquire = await deps.pool.acquire(botId, body.session_id ?? null, {
      name: token.name,
      limit: tokenLimit,
    });
    if (acquire.kind !== "ok") {
      await cleanupFiles(attachments.map((a) => a.path));
      switch (acquire.kind) {
        case "capacity":
          return errorResponse("side_session_capacity");
        case "token_capacity":
          return errorResponse(
            "token_concurrency_limit",
            `token '${acquire.tokenName}' is at its concurrent side-session limit (${acquire.limit})`,
            { limit: acquire.limit },
          );
        case "busy":
          return errorResponse("side_session_busy");
        case "runner_does_not_support_side_sessions":
          return errorResponse("runner_does_not_support_side_sessions");
        case "gateway_shutting_down":
          return errorResponse("gateway_shutting_down");
        case "runner_error":
          return errorResponse("runner_error", acquire.message);
      }
    }
    const sessionId = acquire.sessionId;

    let releasedBySync = false;
    const releaseSync = () => {
      if (releasedBySync) return;
      releasedBySync = true;
      deps.pool.release(botId, sessionId);
    };

    try {
      // 4. Persist turn row (status='running'). From this point on the
      //    turn row owns the attachment files — they live until the
      //    completed-turn sweeper reaps them (retention_secs).
      const turnId = deps.db.insertAskTurn({
        botId,
        tokenName: token.name,
        sessionId,
        textPreview: body.text,
        attachmentPaths: attachments.map((a) => a.path),
      });

      // 5. Subscribe + send.
      const result = await awaitSideTurn({
        runner: bot.runner,
        sessionId,
        turnId,
        text: body.text,
        attachments,
        timeoutMs,
      });

      if (result.kind === "done") {
        const usageJson = result.usage ? JSON.stringify(result.usage) : null;
        deps.db.setTurnFinalText(
          turnId,
          result.text,
          usageJson,
          result.durationMs ?? null,
        );
        return jsonResponse(200, {
          text: result.text,
          turn_id: turnId,
          session_id: sessionId,
          usage: result.usage,
          duration_ms: result.durationMs,
        });
      }

      if (result.kind === "timeout") {
        // Transfer pool-release ownership to the orphan listener.
        releasedBySync = true;
        deps.orphans.attach({
          runner: bot.runner,
          botId,
          sessionId,
          turnId,
        });
        return jsonResponse(202, {
          turn_id: turnId,
          session_id: sessionId,
          status: "in_progress",
        });
      }

      if (result.kind === "error") {
        deps.db.completeTurn(turnId, result.message);
        return jsonResponse(
          500,
          {
            error: "runner_error",
            message: result.message,
            turn_id: turnId,
          },
          { "X-Torana-Retriable": result.retriable ? "true" : "false" },
        );
      }

      // fatal
      deps.db.completeTurn(turnId, result.message);
      // Tear down the poisoned side-session — next acquire recreates fresh.
      void deps.pool.stop(botId, sessionId).catch(() => {
        /* already logged */
      });
      return errorResponse("runner_fatal", result.message, { turn_id: turnId });
    } catch (err) {
      // Log raw cause + stack server-side; never echo exception text into
      // the response body. Matches the send.ts policy from commit 4c6ae18.
      deps.log.error("ask handler threw", {
        bot_id: botId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return errorResponse("internal_error");
    } finally {
      releaseSync();
    }
  };
}

interface AwaitSideTurnOptions {
  runner: AgentRunner;
  sessionId: string;
  turnId: number;
  text: string;
  attachments?: Attachment[];
  timeoutMs: number;
}

type AwaitSideTurnResult =
  | {
      kind: "done";
      text: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      durationMs?: number;
    }
  | { kind: "error"; message: string; retriable: boolean }
  | { kind: "fatal"; message: string }
  | { kind: "timeout" };

export async function awaitSideTurn(
  opts: AwaitSideTurnOptions,
): Promise<AwaitSideTurnResult> {
  const { runner, sessionId, turnId, text, timeoutMs } = opts;
  const attachments = opts.attachments ?? [];
  let buffer = "";
  const unsubs: Unsubscribe[] = [];
  const turnIdStr = String(turnId);

  return new Promise<AwaitSideTurnResult>((resolve) => {
    let settled = false;
    const done = (r: AwaitSideTurnResult) => {
      if (settled) return;
      settled = true;
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* ok */
        }
      }
      clearTimeout(timer);
      resolve(r);
    };

    const onDone: RunnerEventHandler<"done"> = (ev) => {
      if (String(ev.turnId) !== turnIdStr) return;
      const text = ev.finalText ?? buffer;
      done({
        kind: "done",
        text,
        usage: ev.usage,
        durationMs: ev.durationMs,
      });
    };
    const onText: RunnerEventHandler<"text_delta"> = (ev) => {
      if (String(ev.turnId) !== turnIdStr) return;
      buffer += ev.text;
    };
    const onErr: RunnerEventHandler<"error"> = (ev) => {
      if (String(ev.turnId) !== turnIdStr) return;
      done({ kind: "error", message: ev.message, retriable: ev.retriable });
    };
    const onFatal: RunnerEventHandler<"fatal"> = (ev) => {
      done({ kind: "fatal", message: ev.message });
    };

    unsubs.push(runner.onSide(sessionId, "done", onDone));
    unsubs.push(runner.onSide(sessionId, "text_delta", onText));
    unsubs.push(runner.onSide(sessionId, "error", onErr));
    unsubs.push(runner.onSide(sessionId, "fatal", onFatal));

    const timer = setTimeout(() => done({ kind: "timeout" }), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();

    const send = runner.sendSideTurn(sessionId, turnIdStr, text, attachments);
    if (!send.accepted) {
      done({
        kind: "error",
        message: `runner refused turn: ${send.reason}`,
        retriable: send.reason === "busy",
      });
    }
  });
}

// Exported for use by handler attachment — unused variable escape hatch.
type _UsedRunnerEvent = RunnerEvent;
