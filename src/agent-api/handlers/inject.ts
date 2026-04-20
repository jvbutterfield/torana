// POST /v1/bots/:bot_id/inject handler.
//
// Flow (tasks/impl-agent-api.md §6.4):
//   1. Validate Idempotency-Key header (format + presence).
//   2. Parse + zod-validate JSON body.
//   3. Idempotency lookup — on hit, re-fetch and return prior turn id.
//   4. Resolve chat_id (user_id → chat_id via user_chats, or pass-through
//      with chat_not_permitted check).
//   5. ACL re-check (isAuthorized against resolved user) — covers admin
//      removed a user between DM and inject.
//   6. Wrap text with marker prefix.
//   7. db.insertInjectTurn — synthetic inbound + turn (status='queued') +
//      idempotency row in a single BEGIN IMMEDIATE transaction.
//   8. registry.dispatchFor(botId) — wake the dispatch loop.
//   9. 202 {turn_id, status: "queued"} (or "in_progress" if already picked up).

import type { AgentApiDeps, AuthedHandler } from "../types.js";
import type { BotRegistry } from "../../core/registry.js";
import { errorResponse, jsonResponse } from "../errors.js";
import { InjectBodySchema, validateIdempotencyKey } from "../schemas.js";
import { resolveChatId } from "../chat-resolve.js";
import { wrapInjected } from "../marker.js";
import { isAuthorized } from "../../core/acl.js";

export interface InjectDeps extends AgentApiDeps {
  registry: BotRegistry;
}

export function handleInject(deps: InjectDeps): AuthedHandler {
  return async (req, { botId, token }) => {
    // 1. Idempotency-Key header is mandatory. Validate before touching the
    //    body — on a replay we don't re-validate the caller's payload.
    const keyCheck = validateIdempotencyKey(req.headers.get("Idempotency-Key"));
    if (!keyCheck.ok) return errorResponse(keyCheck.code);
    const idempotencyKey = keyCheck.key;

    // 2. Idempotency replay — short-circuits before any writes, ACL work,
    //    or body validation. Per spec: on replay the body is ignored, so a
    //    client retrying with different content still gets the original
    //    turn id back.
    const priorTurnId = deps.db.getIdempotencyTurn(botId, idempotencyKey);
    if (priorTurnId !== null) {
      const prior = deps.db.getTurnExtended(priorTurnId);
      if (prior) {
        return jsonResponse(202, {
          turn_id: priorTurnId,
          status: statusForClient(prior.status),
        });
      }
      // Row points at a missing turn — shouldn't happen (their lifecycles
      // are coupled). Fall through to fresh insert; the transaction's
      // in-txn replay check will handle a concurrent racer.
      deps.log.warn("idempotency row points at missing turn", {
        bot_id: botId,
        turn_id: priorTurnId,
      });
    }

    // 3. Parse + validate body.
    let bodyRaw: unknown;
    try {
      bodyRaw = await req.json();
    } catch {
      return errorResponse("invalid_body", "body must be JSON");
    }
    const parsed = InjectBodySchema.safeParse(bodyRaw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (issue?.message === "either user_id or chat_id required") {
        return errorResponse("missing_target");
      }
      return errorResponse("invalid_body", issue?.message);
    }
    const body = parsed.data;

    // 4. Resolve chat.
    const bot = deps.registry.bot(botId)!;
    const resolve = resolveChatId(deps.db, botId, {
      user_id: body.user_id,
      chat_id: body.chat_id,
    });
    if (resolve.kind === "err") return errorResponse(resolve.code);
    const chatId = resolve.chatId;

    // 5. ACL re-check against the resolved user. If caller passed chat_id
    //    only, find the associated user via getLastChatForUser's inverse —
    //    we need a user to check. The user_chats row that permitted this
    //    chat_id must exist (step 4 enforced that); pick any user for that
    //    chat. (One user per chat_id is invariant for private DMs.)
    const userId = body.user_id
      ? Number(body.user_id)
      : findUserForChat(deps.db, botId, chatId);
    if (
      userId === null ||
      !isAuthorized(deps.config, bot.botConfig, userId)
    ) {
      return errorResponse("target_not_authorized");
    }

    // 6. Marker wrap.
    const wrapped = wrapInjected(body.text, body.source);

    // 7. Persist.
    let insertResult: { replay: boolean; turnId: number };
    try {
      insertResult = deps.db.insertInjectTurn({
        botId,
        tokenName: token.name,
        chatId,
        markerWrappedText: wrapped,
        idempotencyKey,
        sourceLabel: body.source,
        attachmentPaths: [],
      });
    } catch (err) {
      deps.log.error("insertInjectTurn failed", {
        bot_id: botId,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(
        "internal_error",
        err instanceof Error ? err.message : String(err),
      );
    }

    // Inside-transaction replay (race with a concurrent caller holding the
    // same key). Body on the winning path is what the client sees.
    if (insertResult.replay) {
      const prior = deps.db.getTurnExtended(insertResult.turnId);
      return jsonResponse(202, {
        turn_id: insertResult.turnId,
        status: prior ? statusForClient(prior.status) : "queued",
      });
    }

    // 8. Wake dispatch. Fire-and-forget — dispatchFor is synchronous and
    //    cheap (one SQL read + maybe one runner.sendTurn).
    try {
      deps.registry.dispatchFor(botId);
    } catch (err) {
      deps.log.warn("dispatchFor threw after inject insert", {
        bot_id: botId,
        turn_id: insertResult.turnId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 9. Respond. Re-read status — if the dispatcher already picked up the
    //    turn, the client sees 'in_progress' which is accurate.
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
 * Look up the telegram_user_id associated with a (bot_id, chat_id) via the
 * user_chats table. Returns the numeric user id if exactly one match, null
 * otherwise. Used for the ACL re-check when the caller passed chat_id only.
 */
function findUserForChat(
  db: import("../../db/gateway-db.js").GatewayDB,
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
