import { logger } from "./log.js";
import { nextBackoffMs } from "./backoff.js";
import type { BotId, Config } from "./config/schema.js";
import type { NormalizedConfigModel } from "./config/v2.js";
import type { GatewayDB } from "./db/gateway-db.js";
import type { Metrics } from "./metrics.js";
import type { AlertManager } from "./alerts.js";
import type {
  DeliveryResult,
  PlatformAdapter,
} from "./platform/capabilities.js";
import { telegramConversation } from "./platform/telegram/adapter.js";
import type { ConversationRef, OutboundOperation } from "./platform/types.js";

const log = logger("outbox");

type SendCallback = (externalMessageId: string) => void;

/**
 * How long an `in_flight` outbox row stays excluded from re-pickup before
 * auto-recovering. Sized to comfortably exceed a normal Telegram POST
 * (sub-second under healthy conditions, a few seconds under retry +
 * Retry-After). A crashed row reappears for retry only after this grace
 * elapses, narrowing the window in which a fast restart could double-send.
 *
 * 60s also matches the outbox handleFailure backoff cap, so a hung-but-
 * not-crashed process can't accidentally race itself.
 */
const IN_FLIGHT_GRACE_SECS = 60;

export class OutboxProcessor {
  private config: Config;
  private db: GatewayDB;
  private adapters: Map<BotId, PlatformAdapter>;
  private metrics: Metrics;
  private alerts: AlertManager | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sendCallbacks = new Map<number, SendCallback>();
  /**
   * Per-bot reentrancy guard. Replaces the previous global `processing`
   * mutex so a 429 / slow Telegram response on bot A's queue cannot
   * head-of-line block bot B's queue. Within a single bot the queue is
   * still serial (preserves message ordering inside a chat).
   */
  private processingBots = new Set<BotId>();
  private inFlightGraceSecs: number;
  private replyRates: {
    conversation: { count: number; windowMs: number };
    endpoint: { count: number; windowMs: number };
  } | null;

  constructor(
    config: Config,
    db: GatewayDB,
    endpoints: ReadonlyMap<BotId, PlatformAdapter>,
    metrics: Metrics,
    alerts: AlertManager | null = null,
    opts: {
      inFlightGraceSecs?: number;
      normalized?: NormalizedConfigModel;
    } = {},
  ) {
    this.config = config;
    this.db = db;
    this.adapters = new Map(endpoints);
    this.metrics = metrics;
    this.alerts = alerts;
    this.inFlightGraceSecs = opts.inFlightGraceSecs ?? IN_FLIGHT_GRACE_SECS;
    this.replyRates = opts.normalized?.limits
      ? {
          conversation: parseRate(
            opts.normalized.limits.agent_reply_rate_per_conversation,
          ),
          endpoint: parseRate(
            opts.normalized.limits.agent_reply_rate_per_endpoint,
          ),
        }
      : null;
  }

  /**
   * Surface any outbox rows that a previous process left in `in_flight`
   * state — these were mid-platform-delivery when the previous process died.
   * The grace window auto-retries them via getPendingOutbox; this just
   * makes them visible to the operator (a duplicate Telegram message is
   * possible if Telegram had already accepted the original send before
   * we crashed). Call after migrations, before start().
   */
  recoverInFlight(): void {
    const rows = this.db.getInFlightOutbox();
    if (rows.length === 0) return;
    for (const row of rows) {
      log.warn("crash-affected outbox row will auto-retry", {
        id: row.id,
        turn_id: row.turn_id,
        agent_id: row.agent_id,
        bot_id: row.bot_id,
        chat_id: row.chat_id,
        kind: row.operation_kind ?? row.kind,
        attempt_count: row.attempt_count,
        next_attempt_at: row.next_attempt_at,
        caveat:
          "the platform may have accepted the prior attempt; a duplicate is possible",
      });
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.processPending(), 500);
    log.info("outbox processor started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sendCallbacks.clear();
  }

  /**
   * Best-effort flush of pending outbox rows before shutdown. Blocks until
   * either the pending queue is empty or `maxMs` elapses. Rows in 'retrying'
   * status with a future `next_attempt_at` are intentionally NOT rushed —
   * those are left for the next process start.
   */
  async drain(maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const pending = this.db.getPendingOutbox();
      if (pending.length === 0) return;
      await this.processPending();
      if (Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    log.warn("drain deadline reached; leaving pending rows for next start", {
      pending: this.db.getPendingOutbox().length,
    });
  }

  queueSend(
    turnId: number,
    botId: BotId,
    chatId: number,
    text: string,
  ): number {
    const endpointId =
      this.adapters.get(botId)?.endpoint.id ??
      this.db.getEndpointId(botId, "telegram");
    return this.queueOperation(
      turnId,
      botId,
      telegramConversation(endpointId, chatId),
      { kind: "send", text, files: [] },
    );
  }

  queueSendWithCallback(
    turnId: number,
    botId: BotId,
    chatId: number,
    text: string,
    onSent: (telegramMessageId: number) => void,
  ): number {
    const id = this.queueSend(turnId, botId, chatId, text);
    this.sendCallbacks.set(id, (externalMessageId) => {
      if (/^-?\d+$/.test(externalMessageId)) onSent(Number(externalMessageId));
    });
    return id;
  }

  queueEdit(
    turnId: number,
    botId: BotId,
    chatId: number,
    messageId: number,
    text: string,
  ): number {
    const endpointId =
      this.adapters.get(botId)?.endpoint.id ??
      this.db.getEndpointId(botId, "telegram");
    return this.queueOperation(
      turnId,
      botId,
      telegramConversation(endpointId, chatId),
      { kind: "edit", externalMessageId: String(messageId), text },
    );
  }

  queueOperation(
    turnId: number | null,
    agentId: BotId,
    conversation: ConversationRef,
    operation: OutboundOperation,
    prebuiltPayloadJson?: string,
  ): number {
    const adapter =
      this.adapters.get(conversation.endpointId) ?? this.adapters.get(agentId);
    const prepared = adapter?.prepareOutbound?.(conversation, operation);
    const budget =
      conversation.platform === "buzz" &&
      operation.kind === "send" &&
      (turnId === null || !this.db.hasConversationalOutboxForTurn(turnId))
        ? this.replyBudgetExceeded(
            conversation.endpointId,
            this.db.resolveConversation(agentId, conversation).id,
          )
        : null;
    const id = this.db.insertOutboundOperation({
      turnId,
      agentId,
      conversation,
      operation,
      payloadJson:
        prebuiltPayloadJson ??
        prepared?.payloadJson ??
        JSON.stringify(operation),
      signedPayloadJson: prepared?.signedPayloadJson,
      signedEventId: prepared?.signedEventId,
    });
    if (budget) {
      this.db.markOutboxDead(id, `loop budget exceeded: ${budget}`);
      this.metrics.inc(agentId, "loop_budget_rejected");
      void this.alerts?.loopBudgetRejected(agentId, budget);
    }
    return id;
  }

  queueOperationWithCallback(
    turnId: number | null,
    agentId: BotId,
    conversation: ConversationRef,
    operation: Extract<OutboundOperation, { kind: "send" }>,
    onSent: SendCallback,
  ): number {
    const id = this.queueOperation(turnId, agentId, conversation, operation);
    this.sendCallbacks.set(id, onSent);
    return id;
  }

  queueFinalResponse(turnId: number, text: string): number | null {
    const context = this.db.getTurnDeliveryContext(turnId);
    if (!context || context.conversation.platform !== "buzz" || !text.trim()) {
      return null;
    }
    const traceId =
      context.traceId ??
      `torana:${context.conversation.endpointId}:${context.sourceEventId}`;
    return this.queueOperation(turnId, context.agentId, context.conversation, {
      kind: "send",
      text,
      files: [],
      replyTo: context.sourceEventId,
      mentions: [context.senderId],
      traceId,
      hop: context.hop + 1,
    });
  }

  /**
   * Best-effort streaming edit. Returns the EditResult so callers can
   * observe 429 / Retry-After signals (the streaming path uses this to
   * pause its flush cadence — see StreamManager.flush). On exceptions or
   * missing client, returns a synthesised retriable failure rather than
   * throwing, preserving the historical "fire and forget" contract for
   * non-rate-limit-aware callers.
   */
  async fireAndForgetEdit(
    botId: BotId,
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<DeliveryResult> {
    const adapter = this.adapters.get(botId);
    if (!adapter) {
      return {
        ok: false,
        retriable: false,
        notModified: false,
        description: "no messaging endpoint",
      };
    }
    try {
      return await adapter.deliver(telegramConversation(botId, chatId), {
        kind: "edit",
        externalMessageId: String(messageId),
        text,
      });
    } catch (err) {
      return {
        ok: false,
        retriable: true,
        notModified: false,
        description: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async processPending(): Promise<void> {
    const rows = this.db.getPendingOutbox();
    if (rows.length === 0) return;

    // Group by agent_id. Each agent's queue is processed serially (preserves
    // intra-conversation ordering) but agents run concurrently, so a 429 on
    // one endpoint doesn't head-of-line block another. Per-agent reentrancy is
    // guarded via processingBots so a slow agent can't be picked up twice if the
    // 500ms timer fires while it's still draining.
    const byAgent = new Map<BotId, typeof rows>();
    for (const row of rows) {
      const list = byAgent.get(row.agent_id);
      if (list) list.push(row);
      else byAgent.set(row.agent_id, [row]);
    }

    await Promise.all(
      [...byAgent.entries()].map(async ([agentId, agentRows]) => {
        if (this.processingBots.has(agentId)) return;
        this.processingBots.add(agentId);
        try {
          for (const row of agentRows) {
            await this.processOne(row);
          }
        } finally {
          this.processingBots.delete(agentId);
        }
      }),
    );
  }

  private async processOne(
    row: ReturnType<GatewayDB["getPendingOutbox"]>[number],
  ): Promise<void> {
    const adapter =
      this.adapters.get(row.endpoint_id) ?? this.adapters.get(row.agent_id);
    if (!adapter) {
      log.error("no endpoint for agent", { agent_id: row.agent_id });
      this.db.markOutboxFailed(row.id, "no messaging endpoint");
      return;
    }

    const payload = JSON.parse(row.payload_json) as Partial<OutboundOperation> &
      Record<string, unknown>;
    const conversation: ConversationRef = {
      platform: row.platform,
      communityId: row.community_id,
      endpointId: row.endpoint_id,
      channelId: row.external_conversation_id,
      threadRootId: row.thread_root_id,
      workflowRunId: row.workflow_run_id,
      type: row.conversation_type,
    };
    const operationKind = row.operation_kind as OutboundOperation["kind"];
    const externalMessageId =
      row.external_message_id ??
      (row.telegram_message_id !== null
        ? String(row.telegram_message_id)
        : null);
    const operation = materializeOperation(
      operationKind,
      payload,
      externalMessageId,
    );
    if (!operation) {
      this.db.markOutboxFailed(
        row.id,
        `invalid ${operationKind} outbox payload`,
      );
      return;
    }

    // Mark as in_flight before the Telegram POST. If we crash between the
    // POST returning success and `markOutboxSent`, the row stays in
    // `in_flight` until the grace window expires — at which point it
    // auto-recovers via getPendingOutbox. The recoverInFlight() startup
    // pass makes the dup risk visible to operators.
    this.db.markOutboxInFlight(row.id, this.inFlightGraceSecs);

    try {
      const result = await adapter.deliver(conversation, operation, {
        payloadJson: row.payload_json,
        signedPayloadJson: row.signed_payload_json,
        signedEventId: row.signed_event_id,
      });
      if (result.ok || (!result.ok && result.notModified)) {
        this.db.markOutboxSent(
          row.id,
          result.ok ? result.externalMessageId : undefined,
        );
        if (operation.kind === "send" && result.ok) {
          const cb = this.sendCallbacks.get(row.id);
          if (cb && result.externalMessageId) {
            this.sendCallbacks.delete(row.id);
            cb(result.externalMessageId);
          }
        }
      } else if (!result.retriable) {
        this.db.markOutboxFailed(row.id, result.description);
      } else {
        this.handleFailure(row, result.description, result.retryAfterMs);
      }
    } catch (err) {
      this.handleFailure(row, err instanceof Error ? err.message : String(err));
    }
  }

  private replyBudgetExceeded(
    endpointId: string,
    conversationId: number,
  ): "conversation" | "endpoint" | null {
    if (!this.replyRates) return null;
    const since = (windowMs: number) =>
      new Date(Date.now() - windowMs)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");
    if (
      this.db.countRecentConversationalOutbox({
        endpointId,
        conversationId,
        since: since(this.replyRates.conversation.windowMs),
      }) >= this.replyRates.conversation.count
    ) {
      return "conversation";
    }
    if (
      this.db.countRecentConversationalOutbox({
        endpointId,
        since: since(this.replyRates.endpoint.windowMs),
      }) >= this.replyRates.endpoint.count
    ) {
      return "endpoint";
    }
    return null;
  }

  private handleFailure(
    row: {
      id: number;
      attempt_count: number;
      kind?: string | null;
      operation_kind?: string;
      bot_id?: BotId | null;
      agent_id?: BotId;
    },
    error: string,
    retryAfterMs?: number,
  ): void {
    const metricAgentId = row.agent_id ?? row.bot_id;
    const operationKind = row.operation_kind ?? row.kind;
    if (metricAgentId) {
      this.metrics.recordOutboundFailure(
        metricAgentId,
        operationKind === "edit" ? "edit" : "send",
      );
    }

    // Retry-After waits don't count against attempt_count. Otherwise a
    // cooperative attacker who keeps a chat throttled for longer than
    // (max_attempts × backoff_cap) would dead-letter legitimate replies
    // and trigger an operator alert that wasn't actually torana's fault.
    // Cap the cooldown at 5 minutes — Telegram's documented per-chat
    // limits don't exceed this, but we belt-and-braces to bound a
    // potentially-malicious server response.
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      const cappedMs = Math.min(retryAfterMs, 5 * 60_000);
      const nextAttempt = new Date(Date.now() + cappedMs)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");
      log.warn("outbox delivery throttled by Telegram; honoring Retry-After", {
        id: row.id,
        attempt: row.attempt_count,
        retry_after_ms: retryAfterMs,
        next_attempt_at: nextAttempt,
        error,
      });
      this.db.markOutboxRateLimited(row.id, error, nextAttempt);
      return;
    }

    const backoff = nextBackoffMs(
      row.attempt_count,
      this.config.outbox.retry_base_ms,
      60_000,
    );
    // Format must match SQLite's `datetime('now')` ("YYYY-MM-DD HH:MM:SS")
    // because the eligibility query does a lexicographic text comparison.
    // A plain ISO-8601 string ("...T...Z") sorts AFTER the space-separated
    // form, so same-day rows would never become eligible for retry.
    const nextAttempt = new Date(Date.now() + backoff)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");

    const nextAttemptCount = row.attempt_count + 1;
    const willDeadLetter = nextAttemptCount >= this.config.outbox.max_attempts;
    log.warn("outbox delivery failed", {
      id: row.id,
      attempt: nextAttemptCount,
      max_attempts: this.config.outbox.max_attempts,
      error,
    });

    this.db.markOutboxRetrying(
      row.id,
      error,
      nextAttempt,
      this.config.outbox.max_attempts,
    );

    if (willDeadLetter && metricAgentId && this.alerts) {
      void this.alerts.outboxFailures(metricAgentId, nextAttemptCount);
    }
  }
}

function parseRate(value: string): { count: number; windowMs: number } {
  const match = value.match(/^(\d+)\/(\d+)(ms|s|m|h)$/);
  if (!match) throw new Error(`invalid rate limit '${value}'`);
  const count = Number(match[1]);
  const amount = Number(match[2]);
  const unit = match[3];
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return { count, windowMs: amount * multiplier };
}

function materializeOperation(
  kind: OutboundOperation["kind"],
  payload: Partial<OutboundOperation> & Record<string, unknown>,
  externalMessageId: string | null,
): OutboundOperation | null {
  const candidate = { ...payload, kind } as Record<string, unknown>;
  if (kind === "send") {
    if (typeof candidate.text !== "string") return null;
    candidate.files = Array.isArray(candidate.files) ? candidate.files : [];
  }
  if (
    ["edit", "delete", "reaction_add", "reaction_remove", "vote"].includes(kind)
  ) {
    candidate.externalMessageId =
      typeof candidate.externalMessageId === "string"
        ? candidate.externalMessageId
        : externalMessageId;
    if (typeof candidate.externalMessageId !== "string") return null;
  }
  return candidate as unknown as OutboundOperation;
}
