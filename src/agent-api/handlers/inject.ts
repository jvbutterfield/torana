// POST /v1/bots/:bot_id/inject handler.
//
// Flow (tasks/impl-agent-api.md §6.4 + §7.1):
//   1. Validate Idempotency-Key header (format + presence).
//   2. Idempotency replay (pre-write) — on hit, return prior turn id
//      WITHOUT touching the body or the filesystem.
//   3. Parse body — JSON or multipart/form-data. Multipart writes files to
//      disk under a gateway-controlled namespace BEFORE the DB transaction.
//   4. Validate body fields via zod (strict, rejects unknown keys).
//   5. Resolve chat_id, re-check ACL against resolved user.
//   6. Marker-wrap text.
//   7. db.insertInjectTurn — synthetic inbound + turn (status='queued') +
//      idempotency row in a single BEGIN IMMEDIATE transaction. Throws or
//      returns {replay: true} under the in-txn race path.
//        - on throw: cleanupFiles(attachmentPaths); return 500
//        - on replay: cleanupFiles(attachmentPaths); return prior turn
//   8. registry.dispatchFor(botId) — wake the dispatch loop.
//   9. 202 {turn_id, status: "queued" | "in_progress"}.

import { randomUUID } from "node:crypto";

import type { AgentApiDeps, AuthedHandler } from "../types.js";
import type { BotRegistry } from "../../core/registry.js";
import type { GatewayDB } from "../../db/gateway-db.js";
import { errorResponse, jsonResponse } from "../errors.js";
import { InjectBodySchema, validateIdempotencyKey } from "../schemas.js";
import { resolveChatId } from "../chat-resolve.js";
import { wrapInjected } from "../marker.js";
import { isAuthorized } from "../../core/acl.js";
import { cleanupFiles, parseMultipartRequest } from "../attachments.js";
import { recordInject } from "../metrics.js";

export interface InjectDeps extends AgentApiDeps {
  registry: BotRegistry;
}

export function handleInject(deps: InjectDeps): AuthedHandler {
  const inner = handleInjectInner(deps);
  return async (req, params) => {
    const startMs = Date.now();
    const outcome: { replay: boolean } = { replay: false };
    const resp = await inner(req, params, outcome);
    recordInject(deps.metrics, params.botId, {
      status: resp.status as 202 | 400 | 401 | 403 | 404 | 429 | 500 | 501 | 503,
      replay: outcome.replay,
      durationMs: Date.now() - startMs,
    } as Parameters<typeof recordInject>[2]);
    return resp;
  };
}

function handleInjectInner(
  deps: InjectDeps,
): (
  req: Request,
  params: Parameters<AuthedHandler>[1],
  outcome: { replay: boolean },
) => Promise<Response> {
  return async (req, { botId, token }, outcome) => {
    // 1. Idempotency-Key header — mandatory, format-validated.
    const keyCheck = validateIdempotencyKey(req.headers.get("Idempotency-Key"));
    if (!keyCheck.ok) return errorResponse(keyCheck.code);
    const idempotencyKey = keyCheck.key;

    // 2. Idempotency replay. Short-circuits before any body parse, chat
    //    resolution, or file writes — per §6.4 the body is ignored on replay.
    const priorTurnId = deps.db.getIdempotencyTurn(botId, idempotencyKey);
    if (priorTurnId !== null) {
      const prior = deps.db.getTurnExtended(priorTurnId);
      if (prior) {
        outcome.replay = true;
        return jsonResponse(202, {
          turn_id: priorTurnId,
          status: statusForClient(prior.status),
        });
      }
      deps.log.warn("idempotency row points at missing turn", {
        bot_id: botId,
        turn_id: priorTurnId,
      });
    }

    // 3. Body parse. JSON → just req.json(). Multipart → parseMultipartRequest
    //    which writes files to disk; those files become our cleanup
    //    responsibility until the DB transaction commits successfully.
    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    const isMultipart = contentType.includes("multipart/form-data");
    const requestId = randomUUID();

    let bodyRaw: unknown;
    let attachmentPaths: string[] = [];
    try {
      if (isMultipart) {
        const parsed = await parseMultipartRequest(
          req,
          deps.config,
          botId,
          requestId,
        );
        if (parsed.kind === "err") {
          return errorResponse(parsed.code, parsed.detail);
        }
        attachmentPaths = parsed.attachments.map((a) => a.path);
        bodyRaw = {
          text: parsed.text,
          source: parsed.fields.source,
          user_id: parsed.fields.user_id,
          chat_id: parsed.fields.chat_id,
        };
      } else {
        try {
          bodyRaw = await req.json();
        } catch {
          return errorResponse("invalid_body", "body must be JSON");
        }
      }
    } catch (err) {
      // parseMultipartRequest's error path already cleaned up its own
      // writes; this catch is for truly unexpected failures (e.g. the
      // Request object itself threw during header inspection).
      await cleanupFiles(attachmentPaths);
      deps.log.error("inject body parse threw", {
        bot_id: botId,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse("internal_error");
    }

    // 4. Validate body fields.
    const parsed = InjectBodySchema.safeParse(bodyRaw);
    if (!parsed.success) {
      await cleanupFiles(attachmentPaths);
      const issue = parsed.error.issues[0];
      if (issue?.message === "either user_id or chat_id required") {
        return errorResponse("missing_target");
      }
      return errorResponse("invalid_body", issue?.message);
    }
    const body = parsed.data;

    // 5. Resolve chat + ACL re-check.
    const bot = deps.registry.bot(botId)!;
    const resolve = resolveChatId(deps.db, botId, {
      user_id: body.user_id,
      chat_id: body.chat_id,
    });
    if (resolve.kind === "err") {
      await cleanupFiles(attachmentPaths);
      return errorResponse(resolve.code);
    }
    const chatId = resolve.chatId;

    const userId = body.user_id
      ? Number(body.user_id)
      : findUserForChat(deps.db, botId, chatId);
    if (userId === null || !isAuthorized(deps.config, bot.botConfig, userId)) {
      await cleanupFiles(attachmentPaths);
      return errorResponse("target_not_authorized");
    }

    // 6. Marker-wrap prompt.
    const wrapped = wrapInjected(body.text, body.source);

    // 7. Persist. On throw, roll back files. On in-txn replay, files are
    //    orphans (the prior turn owns its own first-call files); unlink ours.
    let insertResult: { replay: boolean; turnId: number };
    try {
      insertResult = deps.db.insertInjectTurn({
        botId,
        tokenName: token.name,
        chatId,
        markerWrappedText: wrapped,
        idempotencyKey,
        sourceLabel: body.source,
        attachmentPaths,
      });
    } catch (err) {
      await cleanupFiles(attachmentPaths);
      deps.log.error("insertInjectTurn failed", {
        bot_id: botId,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(
        "internal_error",
        err instanceof Error ? err.message : String(err),
      );
    }

    if (insertResult.replay) {
      outcome.replay = true;
      await cleanupFiles(attachmentPaths);
      const prior = deps.db.getTurnExtended(insertResult.turnId);
      return jsonResponse(202, {
        turn_id: insertResult.turnId,
        status: prior ? statusForClient(prior.status) : "queued",
      });
    }

    // 8. Wake dispatch. Fire-and-forget.
    try {
      deps.registry.dispatchFor(botId);
    } catch (err) {
      deps.log.warn("dispatchFor threw after inject insert", {
        bot_id: botId,
        turn_id: insertResult.turnId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 9. Respond.
    const row = deps.db.getTurnExtended(insertResult.turnId);
    return jsonResponse(202, {
      turn_id: insertResult.turnId,
      status: row ? statusForClient(row.status) : "queued",
    });
  };
}

function statusForClient(
  dbStatus: string,
): "queued" | "in_progress" | "done" | "failed" {
  switch (dbStatus) {
    case "queued":
      return "queued";
    case "running":
      return "in_progress";
    case "completed":
      return "done";
    case "failed":
    case "dead":
    case "interrupted":
      return "failed";
    default:
      return "queued";
  }
}

/**
 * Look up the telegram_user_id associated with a (bot_id, chat_id). Used
 * for the ACL re-check when the caller passed chat_id only.
 */
function findUserForChat(
  db: GatewayDB,
  botId: string,
  chatId: number,
): number | null {
  const row = db
    .query(
      "SELECT telegram_user_id FROM user_chats WHERE bot_id = ? AND chat_id = ? LIMIT 1",
    )
    .get(botId, chatId) as { telegram_user_id: string } | null;
  if (!row) return null;
  const n = Number(row.telegram_user_id);
  return Number.isFinite(n) ? n : null;
}
