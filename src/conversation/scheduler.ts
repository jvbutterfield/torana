import type { NormalizedConfigModel } from "../config/v2.js";
import type { GatewayDB } from "../db/gateway-db.js";
import { logger } from "../log.js";
import type { BotRegistry } from "../core/registry.js";
import type { ConversationSessionManager } from "./manager.js";
import type { ConversationRef } from "../platform/types.js";
import type { Config } from "../config/schema.js";
import type { AlertManager } from "../alerts.js";
import type { ManagedTurnOutcome } from "../core/bot.js";

const log = logger("conversation.scheduler");

export interface ConversationSchedulerOptions {
  db: GatewayDB;
  registry: BotRegistry;
  manager: ConversationSessionManager;
  normalized: NormalizedConfigModel;
  tickMs?: number;
  workerTuning?: Config["worker_tuning"];
  alerts?: AlertManager;
}

/**
 * Single owner of normalized turn dispatch. Selection is round-robin by
 * conversation while execution is serialized by resolved session key.
 */
export class ConversationScheduler {
  private db: GatewayDB;
  private registry: BotRegistry;
  private manager: ConversationSessionManager;
  private limits: NormalizedConfigModel["sessions"];
  private tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scheduled = false;
  private dispatching = false;
  private cursor = -1;
  private activeSessions = new Set<string>();
  private activeByAgent = new Map<string, number>();
  private activeCancels = new Map<string, () => void>();
  private activeGlobal = 0;
  private turnTimeoutMs: number;
  private maxConsecutiveFailures: number;
  private alerts?: AlertManager;
  private failuresBySession = new Map<string, number>();
  private quarantinedSessions = new Set<string>();
  private quarantinedAgents = new Set<string>();

  constructor(opts: ConversationSchedulerOptions) {
    this.db = opts.db;
    this.registry = opts.registry;
    this.manager = opts.manager;
    this.limits = opts.normalized.sessions;
    this.tickMs = opts.tickMs ?? 1000;
    this.turnTimeoutMs = (opts.workerTuning?.turn_timeout_secs ?? 60) * 1000;
    this.maxConsecutiveFailures =
      opts.workerTuning?.max_consecutive_failures ?? 10;
    this.alerts = opts.alerts;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), this.tickMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
    this.wake();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Finish work accepted before transport intake stopped. Queued rows remain
   * durable when the budget expires; active runner turns are cancelled so the
   * caller can continue the bounded shutdown sequence.
   */
  async drainAccepted(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    this.wake();
    while (Date.now() <= deadline) {
      if (
        this.activeGlobal === 0 &&
        this.db.getQueuedConversationTurns().length === 0
      ) {
        this.stop();
        return true;
      }
      this.wake();
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Bun.sleep(Math.min(25, remaining));
    }
    for (const cancel of this.activeCancels.values()) cancel();
    this.stop();
    return false;
  }

  wake(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.dispatch();
    });
  }

  async resetConversation(
    agentId: string,
    conversation: ConversationRef,
  ): Promise<string> {
    const resolved = this.db.resolveConversation(agentId, conversation);
    if (!resolved.sessionKey)
      return "Ephemeral session already starts fresh each turn.";
    const bindings = this.db.conversationSessionBindingCount(
      resolved.sessionKey,
    );
    if (bindings > 1) {
      return `Reset refused: this session is shared by ${bindings} conversations. Use the local sessions reset command with shared confirmation.`;
    }
    this.activeCancels.get(resolved.sessionKey)?.();
    await this.manager.resetConversation(resolved.sessionKey);
    this.failuresBySession.delete(resolved.sessionKey);
    this.quarantinedSessions.delete(resolved.sessionKey);
    return "Session cleared. Fresh start ready.";
  }

  async cancelConversation(
    agentId: string,
    conversation: ConversationRef,
  ): Promise<string> {
    const resolved = this.db.resolveConversation(agentId, conversation);
    if (!resolved.sessionKey) return "No active turn for this conversation.";
    const cancelActive = this.activeCancels.get(resolved.sessionKey);
    if (!cancelActive) return "No active turn for this conversation.";
    const stopping = this.manager.cancelConversation(resolved.sessionKey);
    cancelActive();
    const cancelled = await stopping;
    return cancelled
      ? "Active turn cancelled. Session context was preserved."
      : "No active turn for this conversation.";
  }

  conversationStatus(agentId: string, conversation: ConversationRef): string {
    const resolved = this.db.resolveConversation(agentId, conversation);
    if (!resolved.sessionKey) return "Session: ephemeral\nMailbox: 0 queued";
    const status = this.manager.conversationStatus(resolved.sessionKey);
    return [
      `Session: ${status.state}${status.live ? " (live)" : ""}`,
      `Runner: ${status.runnerHealth}`,
      `Mailbox: ${status.queueDepth} queued`,
      `Age: ${status.ageMs === null ? "unknown" : `${Math.floor(status.ageMs / 1000)}s`}`,
    ].join("\n");
  }

  canAccept(
    agentId: string,
    conversation: ConversationRef,
  ): { accepted: true } | { accepted: false; reason: string } {
    const resolved = this.db.resolveConversation(agentId, conversation);
    if (
      this.quarantinedAgents.has(agentId) ||
      (resolved.sessionKey && this.isSessionQuarantined(resolved.sessionKey))
    ) {
      return { accepted: false, reason: "conversation_quarantined" };
    }
    const conversationDepth = this.db.conversationQueueDepth(resolved.id);
    const agentDepth = this.db.agentQueueDepth(agentId);
    if (conversationDepth >= this.limits.max_queue_depth_per_conversation) {
      return { accepted: false, reason: "conversation_queue_full" };
    }
    if (agentDepth >= this.limits.max_queue_depth_per_agent) {
      return { accepted: false, reason: "agent_queue_full" };
    }
    if (
      this.limits.overflow === "reject" &&
      (conversationDepth > 0 ||
        this.activeGlobal >= this.limits.max_concurrent_turns_global ||
        (this.activeByAgent.get(agentId) ?? 0) >=
          this.limits.max_concurrent_turns_per_agent)
    ) {
      return { accepted: false, reason: "session_busy" };
    }
    return { accepted: true };
  }

  private async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.activeGlobal < this.limits.max_concurrent_turns_global) {
        const now = Date.now();
        const queued = this.db.getQueuedConversationTurns().filter((row) => {
          const stale =
            now - Date.parse(row.received_at) >=
            this.limits.context_retention_ms;
          if (row.conversation_archived || stale) {
            this.db.deadLetterTurn(
              row.id,
              row.conversation_archived
                ? "conversation archived"
                : "dispatch retention expired",
            );
            return false;
          }
          if (
            this.quarantinedAgents.has(row.bot_id) ||
            (row.session_key && this.isSessionQuarantined(row.session_key))
          ) {
            return false;
          }
          return true;
        });
        const heads = new Map<number, (typeof queued)[number]>();
        for (const row of queued) {
          if (row.conversation_id !== null && !heads.has(row.conversation_id)) {
            heads.set(row.conversation_id, row);
          }
        }
        const ordered = [...heads.entries()].sort(([a], [b]) => a - b);
        if (ordered.length === 0) return;
        const start = ordered.findIndex(([id]) => id > this.cursor);
        const rotated =
          start < 0
            ? ordered
            : [...ordered.slice(start), ...ordered.slice(0, start)];

        let dispatched = false;
        for (const [conversationId, row] of rotated) {
          const agentActive = this.activeByAgent.get(row.bot_id) ?? 0;
          if (agentActive >= this.limits.max_concurrent_turns_per_agent)
            continue;
          const sessionKey = row.session_key ?? `ephemeral:turn-${row.id}`;
          if (this.activeSessions.has(sessionKey)) continue;

          const acquired = await this.manager.acquireConversation(
            row.bot_id,
            sessionKey,
            row.session_key === null,
          );
          if (acquired.kind !== "ok") {
            if (acquired.kind === "runner_error") {
              log.warn("conversation session acquire failed", {
                agent_id: row.bot_id,
                conversation_id: conversationId,
                error: acquired.message,
              });
              this.recordFailure(
                row.bot_id,
                sessionKey,
                acquired.message,
                isAgentWideFailure(acquired.message),
              );
            }
            continue;
          }

          const bot = this.registry.bot(row.bot_id);
          if (!bot) {
            this.manager.release(row.bot_id, acquired.sessionId);
            continue;
          }
          this.activeSessions.add(sessionKey);
          this.activeGlobal += 1;
          this.activeByAgent.set(row.bot_id, agentActive + 1);
          let finished = false;
          let timeout: ReturnType<typeof setTimeout> | null = null;
          const finish = (outcome: ManagedTurnOutcome) => {
            if (finished) return;
            finished = true;
            if (timeout) clearTimeout(timeout);
            if (outcome.kind === "completed") {
              this.failuresBySession.delete(sessionKey);
              this.db.setConversationSessionError(sessionKey, "");
            } else if (outcome.kind !== "cancelled") {
              this.recordFailure(
                row.bot_id,
                sessionKey,
                outcome.reason,
                outcome.kind === "interrupted" && outcome.code === "auth",
              );
            }
            this.activeCancels.delete(sessionKey);
            this.activeSessions.delete(sessionKey);
            this.activeGlobal = Math.max(0, this.activeGlobal - 1);
            const n = this.activeByAgent.get(row.bot_id) ?? 1;
            if (n <= 1) this.activeByAgent.delete(row.bot_id);
            else this.activeByAgent.set(row.bot_id, n - 1);
            this.manager.release(row.bot_id, acquired.sessionId);
            this.wake();
          };
          this.activeCancels.set(sessionKey, () => {
            bot.cancelManagedTurn(row.id, "cancelled by operator");
          });
          const accepted = bot.dispatchSessionTurn(
            sessionKey,
            acquired.runnerSession,
            row.id,
            row.chat_id,
            this.db.getTurnText(row.id) ?? "",
            this.db.getTurnAttachments(row.id),
            finish,
          );
          if (!accepted) {
            this.activeCancels.delete(sessionKey);
            this.activeSessions.delete(sessionKey);
            this.activeGlobal -= 1;
            if (agentActive === 0) this.activeByAgent.delete(row.bot_id);
            else this.activeByAgent.set(row.bot_id, agentActive);
            this.manager.release(row.bot_id, acquired.sessionId);
            continue;
          }
          log.info("conversation turn dispatched", {
            agent_id: row.bot_id,
            platform: row.platform,
            endpoint_id: row.endpoint_id,
            conversation_id: conversationId,
            session_key: sessionKey,
            turn_id: row.id,
          });
          timeout = setTimeout(() => {
            const stopping = this.manager.cancelConversation(sessionKey);
            bot.cancelManagedTurn(row.id, "turn timeout");
            void stopping;
          }, this.turnTimeoutMs);
          (timeout as unknown as { unref?: () => void }).unref?.();
          this.cursor = conversationId;
          dispatched = true;
          break;
        }
        if (!dispatched) return;
      }
    } finally {
      this.dispatching = false;
    }
  }

  private recordFailure(
    agentId: string,
    sessionKey: string,
    reason: string,
    agentWide: boolean,
  ): void {
    if (agentWide) {
      const worker = this.db.getWorkerState(agentId);
      const failures = (worker?.consecutive_failures ?? 0) + 1;
      this.db.updateWorkerState(agentId, {
        consecutive_failures: failures,
        last_error: reason,
      });
      if (failures >= this.maxConsecutiveFailures) {
        this.quarantinedAgents.add(agentId);
        this.db.updateWorkerState(agentId, { status: "degraded" });
        void this.alerts?.workerDegraded(
          agentId,
          `${failures} agent-wide session failures`,
        );
      }
      return;
    }

    const persisted = parseFailureCount(
      this.db.getConversationSession(sessionKey)?.last_error ?? null,
    );
    const failures =
      Math.max(this.failuresBySession.get(sessionKey) ?? 0, persisted) + 1;
    this.failuresBySession.set(sessionKey, failures);
    this.db.setConversationSessionError(
      sessionKey,
      `failure_count=${failures};${reason}`,
    );
    if (failures < this.maxConsecutiveFailures) return;
    this.quarantinedSessions.add(sessionKey);
    this.db.deadLetterNextQueuedSessionTurn(
      sessionKey,
      `conversation quarantined after ${failures} failures`,
    );
    void this.alerts?.workerDegraded(
      agentId,
      `conversation session quarantined after ${failures} failures`,
    );
  }

  private isSessionQuarantined(sessionKey: string): boolean {
    if (this.quarantinedSessions.has(sessionKey)) return true;
    const failures = parseFailureCount(
      this.db.getConversationSession(sessionKey)?.last_error ?? null,
    );
    if (failures < this.maxConsecutiveFailures) return false;
    this.failuresBySession.set(sessionKey, failures);
    this.quarantinedSessions.add(sessionKey);
    return true;
  }
}

function isAgentWideFailure(message: string): boolean {
  return /\b(?:ENOENT|auth(?:entication)?|invalid credential|not found)\b/i.test(
    message,
  );
}

function parseFailureCount(lastError: string | null): number {
  const match = /^failure_count=(\d+);/.exec(lastError ?? "");
  return match ? Number(match[1]) : 0;
}
