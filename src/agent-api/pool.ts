// SideSessionPool — owns the per-bot LRU pool of side-session subprocesses.
//
// Design rules (tasks/impl-agent-api.md §5):
//   1. Ephemeral path: acquire(bot, null) mints eph-<uuid>, spawns, auto-stops
//      on release when inflight returns to 0.
//   2. Keyed reuse: acquire(bot, id) with an existing entry — inflight=1 max.
//      Another caller with the same id while busy → {kind:"busy"} → 429.
//   3. Keyed miss: check per-bot + global caps, LRU-evict idle if at cap,
//      pre-register inflight=1 before await startSideSession so a racing
//      acquire on the same id doesn't double-spawn.
//   4. Spawn failure: scrub entry, delete DB row, return runner_error.
//   5. Idle + hard TTL sweeps (60s timer). Hard-TTL mark stopping, drain
//      up to graceMs, force stop. Lazy recreate on next acquire.
//   6. Release is no-op on missing entry (crash-safe during shutdown races).
//   7. Shutdown: parallel stop all entries; new acquires return
//      gateway_shutting_down.
//   8. Startup: markAllSideSessionsStopped clears stale DB rows from the
//      prior process.

import { randomUUID } from "node:crypto";

import type { Config } from "../config/schema.js";
import type { GatewayDB } from "../db/gateway-db.js";
import type { BotRegistry } from "../core/registry.js";
import type { Metrics } from "../metrics.js";
import { logger, type Logger } from "../log.js";
import {
  recordAcquire,
  recordEviction,
  setSideSessionsLive,
} from "./metrics.js";

export interface SideSessionPoolOptions {
  config: Config;
  db: GatewayDB;
  registry: BotRegistry;
  clock?: () => number;
  /** Sweep cadence (ms). Default 60_000. Overridable for tests. */
  sweepIntervalMs?: number;
  /** Optional metrics emitter — omitted in tests that don't assert metrics. */
  metrics?: Metrics;
}

export type AcquireResult =
  | { kind: "ok"; sessionId: string; ephemeral: boolean }
  | { kind: "capacity" }
  | { kind: "token_capacity"; tokenName: string; limit: number }
  | { kind: "busy" }
  | { kind: "runner_error"; message: string }
  | { kind: "gateway_shutting_down" }
  | { kind: "runner_does_not_support_side_sessions" };

/**
 * Per-token concurrency context passed to `acquire`. The pool enforces
 * `inflight < limit` before incrementing, and tracks the owning token name
 * on each entry so `release` decrements the correct counter.
 */
export interface AcquireTokenInfo {
  name: string;
  /** Resolved per-token cap; pool rejects when current inflight >= limit. */
  limit: number;
}

export interface PoolEntrySnapshot {
  sessionId: string;
  ephemeral: boolean;
  startedAtMs: number;
  lastUsedAtMs: number;
  hardExpiresAtMs: number;
  inflight: number;
  state: "starting" | "ready" | "busy" | "stopping";
}

interface PoolEntry {
  botId: string;
  sessionId: string;
  ephemeral: boolean;
  startedAtMs: number;
  lastUsedAtMs: number;
  hardExpiresAtMs: number;
  inflight: number;
  state: "starting" | "ready" | "busy" | "stopping";
  stopPromise: Promise<void> | null;
  /**
   * Token name currently holding inflight (set on every successful acquire,
   * cleared on release). Used to decrement the right per-token counter
   * without the caller passing the token info into release(). Stays null on
   * tests that don't pass tokenInfo to acquire().
   */
  tokenName: string | null;
}

function entryKey(botId: string, sessionId: string): string {
  return `${botId}\u0000${sessionId}`;
}

export class SideSessionPool {
  private config: Config;
  private db: GatewayDB;
  private registry: BotRegistry;
  private metrics?: Metrics;
  private clock: () => number;
  private log: Logger = logger("agent-api.pool");
  private entries = new Map<string, PoolEntry>();
  /**
   * Inflight side-session count per token name. Incremented on every
   * successful acquire, decremented on release. Entries are pruned when the
   * count hits 0 to keep the map size bounded by active tokens, not lifetime
   * tokens.
   */
  private tokenInflight = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepIntervalMs: number;
  private shuttingDown = false;
  /**
   * Background stopPromises (ephemeral auto-stop on release, TTL sweeps)
   * that aren't tracked in `entries` anymore but must be awaited during
   * shutdown so no subprocess escapes teardown.
   */
  private pendingBackgroundStops = new Set<Promise<void>>();

  constructor(opts: SideSessionPoolOptions) {
    this.config = opts.config;
    this.db = opts.db;
    this.registry = opts.registry;
    this.metrics = opts.metrics;
    this.clock = opts.clock ?? Date.now;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60_000;

    // Startup reconciliation: any rows the prior process left are orphans.
    this.db.markAllSideSessionsStopped();
  }

  /**
   * Recompute and publish the side_sessions_live gauge for a bot. Called
   * after any state transition that might change the live count: successful
   * spawn, explicit release, eviction completion.
   */
  private publishLiveGauge(botId: string): void {
    if (!this.metrics) return;
    let live = 0;
    for (const e of this.entries.values()) {
      if (e.botId !== botId) continue;
      if (e.state === "stopping") continue;
      live += 1;
    }
    setSideSessionsLive(this.metrics, botId, live);
  }

  startSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    (this.sweepTimer as unknown as { unref?: () => void }).unref?.();
  }

  stopSweeper(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Acquire a side-session entry. Caller MUST eventually call release(),
   * typically in a finally block. `tokenInfo` enforces the per-token
   * concurrency cap; production callers (ask handler) always pass it.
   * Tests may omit it to opt out of per-token tracking.
   */
  async acquire(
    botId: string,
    sessionId: string | null,
    tokenInfo?: AcquireTokenInfo,
  ): Promise<AcquireResult> {
    const startMs = this.clock();
    const recordOutcome = (
      outcome: "reuse" | "spawn" | "capacity" | "busy",
    ): void => {
      recordAcquire(this.metrics, botId, outcome, this.clock() - startMs);
    };

    if (this.shuttingDown) return { kind: "gateway_shutting_down" };

    const bot = this.registry.bot(botId);
    if (!bot)
      return { kind: "runner_error", message: `unknown bot '${botId}'` };
    if (!bot.runner.supportsSideSessions()) {
      return { kind: "runner_does_not_support_side_sessions" };
    }

    // Per-token cap: check + reserve the slot atomically, BEFORE any await.
    // Without the optimistic reservation, two concurrent acquires both read
    // inflight=0 against limit=1, both pass the check, both await spawn, and
    // both end up incrementing past the cap. We reserve here and roll back
    // in the failure tail below.
    if (tokenInfo) {
      const inflight = this.tokenInflight.get(tokenInfo.name) ?? 0;
      if (inflight >= tokenInfo.limit) {
        recordOutcome("capacity");
        return {
          kind: "token_capacity",
          tokenName: tokenInfo.name,
          limit: tokenInfo.limit,
        };
      }
      this.tokenInflight.set(tokenInfo.name, inflight + 1);
    }

    let succeeded = false;
    try {
      // Ephemeral path — mint a UUID and take the fresh-spawn branch.
      if (sessionId === null) {
        const minted = `eph-${randomUUID()}`;
        const res = await this.spawnAndRegister(botId, minted, true);
        if (res.kind === "ok") {
          succeeded = true;
          this.markEntryToken(botId, minted, tokenInfo);
          recordOutcome("spawn");
        }
        return res;
      }

      const key = entryKey(botId, sessionId);
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.state === "stopping") {
          // Treat as miss — the entry is on its way out.
          this.entries.delete(key);
        } else {
          if (existing.inflight > 0) {
            recordOutcome("busy");
            return { kind: "busy" };
          }
          existing.inflight = 1;
          existing.lastUsedAtMs = this.clock();
          existing.state = "busy";
          this.db.markSideSessionState(botId, sessionId, "busy");
          succeeded = true;
          this.markEntryToken(botId, sessionId, tokenInfo);
          recordOutcome("reuse");
          return { kind: "ok", sessionId, ephemeral: existing.ephemeral };
        }
      }

      // Miss — check caps, evict if needed, then spawn.
      const capResult = this.ensureCapacity(botId);
      if (capResult.kind === "err") {
        recordOutcome("capacity");
        return { kind: "capacity" };
      }
      const res = await this.spawnAndRegister(botId, sessionId, false);
      if (res.kind === "ok") {
        succeeded = true;
        this.markEntryToken(botId, sessionId, tokenInfo);
        recordOutcome("spawn");
      }
      return res;
    } finally {
      // Roll back the optimistic per-token reservation on every non-success
      // path. release()/teardown handles the success path's eventual
      // decrement when the caller releases.
      if (tokenInfo && !succeeded) {
        this.releaseTokenSlot(tokenInfo.name);
      }
    }
  }

  /**
   * Stamp `entry.tokenName` so release() knows which token to decrement.
   * The per-token counter has already been incremented in acquire(); this
   * call only ties the entry to the token. No-op if tokenInfo is undefined.
   */
  private markEntryToken(
    botId: string,
    sessionId: string,
    tokenInfo: AcquireTokenInfo | undefined,
  ): void {
    if (!tokenInfo) return;
    const entry = this.entries.get(entryKey(botId, sessionId));
    if (!entry) return;
    entry.tokenName = tokenInfo.name;
  }

  /** Decrement-or-prune helper for the per-token inflight counter. */
  private releaseTokenSlot(tokenName: string): void {
    const cur = this.tokenInflight.get(tokenName) ?? 0;
    if (cur <= 1) this.tokenInflight.delete(tokenName);
    else this.tokenInflight.set(tokenName, cur - 1);
  }

  /** Visible for tests: snapshot of per-token inflight counters. */
  inflightForToken(tokenName: string): number {
    return this.tokenInflight.get(tokenName) ?? 0;
  }

  /**
   * Decrement inflight. If the entry is ephemeral and idle, schedule a
   * background stop. If the entry is stopping and idle, complete teardown.
   */
  release(botId: string, sessionId: string): void {
    const key = entryKey(botId, sessionId);
    const entry = this.entries.get(key);
    if (!entry) return; // No-op on missing — release must be crash-safe.
    entry.inflight = Math.max(0, entry.inflight - 1);
    entry.lastUsedAtMs = this.clock();
    if (entry.tokenName !== null) {
      this.releaseTokenSlot(entry.tokenName);
      entry.tokenName = null;
    }
    if (entry.state === "busy") entry.state = "ready";
    if (entry.state === "ready" && entry.inflight === 0) {
      this.db.markSideSessionState(botId, sessionId, "ready");
    }
    if (entry.ephemeral && entry.inflight === 0) {
      this.scheduleStop(entry, this.config.shutdown.runner_grace_secs * 1000);
    } else if (entry.state === "stopping" && entry.inflight === 0) {
      // Deferred hard-TTL stop completes now that inflight hit zero.
      this.scheduleStop(entry, this.config.shutdown.runner_grace_secs * 1000);
    }
  }

  /**
   * Synchronously stop + forget a specific entry. Public for the admin
   * DELETE endpoint and for the ask handler when it sees a fatal event.
   * Safe to call while the session is in-flight; stopSideSession on the
   * runner handles SIGTERM → SIGKILL escalation.
   */
  async stop(
    botId: string,
    sessionId: string,
    graceMs?: number,
  ): Promise<void> {
    const key = entryKey(botId, sessionId);
    const entry = this.entries.get(key);
    if (!entry) return;
    const grace = graceMs ?? this.config.shutdown.runner_grace_secs * 1000;
    this.scheduleStop(entry, grace);
    await entry.stopPromise;
  }

  listForBot(botId: string): PoolEntrySnapshot[] {
    const out: PoolEntrySnapshot[] = [];
    for (const entry of this.entries.values()) {
      if (entry.botId !== botId) continue;
      out.push({
        sessionId: entry.sessionId,
        ephemeral: entry.ephemeral,
        startedAtMs: entry.startedAtMs,
        lastUsedAtMs: entry.lastUsedAtMs,
        hardExpiresAtMs: entry.hardExpiresAtMs,
        inflight: entry.inflight,
        state: entry.state,
      });
    }
    return out;
  }

  async shutdown(graceMs: number): Promise<void> {
    this.shuttingDown = true;
    this.stopSweeper();
    const stops: Promise<void>[] = [];
    for (const entry of [...this.entries.values()]) {
      this.scheduleStop(entry, graceMs);
      if (entry.stopPromise) stops.push(entry.stopPromise);
    }
    // Also await any background stops (ephemeral auto-teardown) that are
    // already in flight.
    stops.push(...this.pendingBackgroundStops);
    await Promise.allSettled(stops);
  }

  // ---------- internals ----------

  private async spawnAndRegister(
    botId: string,
    sessionId: string,
    ephemeral: boolean,
  ): Promise<AcquireResult> {
    const key = entryKey(botId, sessionId);
    // Pre-register so a concurrent acquire with the same id sees the entry.
    const now = this.clock();
    const hardTtlMs = this.config.agent_api.side_sessions.hard_ttl_ms;
    const entry: PoolEntry = {
      botId,
      sessionId,
      ephemeral,
      startedAtMs: now,
      lastUsedAtMs: now,
      hardExpiresAtMs: now + hardTtlMs,
      inflight: 1,
      state: "starting",
      stopPromise: null,
      tokenName: null,
    };
    this.entries.set(key, entry);
    this.db.upsertSideSession({
      botId,
      sessionId,
      pid: null,
      startedAt: new Date(now).toISOString(),
      lastUsedAt: new Date(now).toISOString(),
      hardExpiresAt: new Date(entry.hardExpiresAtMs).toISOString(),
      state: "starting",
    });

    const bot = this.registry.bot(botId);
    if (!bot) {
      this.entries.delete(key);
      this.db.deleteSideSession(botId, sessionId);
      return { kind: "runner_error", message: `unknown bot '${botId}'` };
    }

    try {
      await bot.runner.startSideSession(sessionId);
    } catch (err) {
      this.entries.delete(key);
      this.db.deleteSideSession(botId, sessionId);
      this.log.warn("side-session spawn failed", {
        bot_id: botId,
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        kind: "runner_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    entry.state = "busy";
    this.db.markSideSessionState(botId, sessionId, "busy");
    this.publishLiveGauge(botId);
    return { kind: "ok", sessionId, ephemeral };
  }

  private ensureCapacity(botId: string): { kind: "ok" } | { kind: "err" } {
    const perBotMax = this.config.agent_api.side_sessions.max_per_bot;
    const globalMax = this.config.agent_api.side_sessions.max_global;

    const forBot = [...this.entries.values()].filter((e) => e.botId === botId);
    const total = this.entries.size;

    if (forBot.length < perBotMax && total < globalMax) {
      return { kind: "ok" };
    }

    // Over a cap — try LRU eviction of idle entries. Prefer bot-local.
    if (forBot.length >= perBotMax) {
      const victim = this.pickLruIdle(forBot);
      if (!victim) return { kind: "err" };
      this.evict(victim, "lru");
      return { kind: "ok" };
    }
    if (total >= globalMax) {
      const victim = this.pickLruIdle([...this.entries.values()]);
      if (!victim) return { kind: "err" };
      this.evict(victim, "lru");
      return { kind: "ok" };
    }
    return { kind: "err" };
  }

  private pickLruIdle(candidates: PoolEntry[]): PoolEntry | null {
    let best: PoolEntry | null = null;
    for (const e of candidates) {
      if (e.inflight > 0) continue;
      if (e.state === "stopping") continue;
      if (!best || e.lastUsedAtMs < best.lastUsedAtMs) best = e;
    }
    return best;
  }

  private evict(entry: PoolEntry, reason: "lru" | "idle" | "hard"): void {
    this.log.info("evicting side-session", {
      bot_id: entry.botId,
      session_id: entry.sessionId,
      reason,
    });
    recordEviction(this.metrics, entry.botId, reason);
    this.scheduleStop(entry, this.config.shutdown.runner_grace_secs * 1000);
  }

  private scheduleStop(entry: PoolEntry, graceMs: number): void {
    if (entry.stopPromise) return;
    entry.state = "stopping";
    this.db.markSideSessionState(entry.botId, entry.sessionId, "stopping");
    // An entry in `stopping` no longer counts as live — republish now so
    // operators see the drop even if the actual subprocess stop takes a
    // few hundred ms to return.
    this.publishLiveGauge(entry.botId);
    const key = entryKey(entry.botId, entry.sessionId);
    const p = (async () => {
      const bot = this.registry.bot(entry.botId);
      if (bot) {
        try {
          await bot.runner.stopSideSession(entry.sessionId, graceMs);
        } catch (err) {
          this.log.warn("side-session stop failed", {
            bot_id: entry.botId,
            session_id: entry.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // If the entry was force-stopped while a token still held inflight
      // (admin DELETE racing an ask handler), decrement here so the per-
      // token counter can't leak past entry deletion. The handler's later
      // release() finds no entry and is a no-op, which is correct.
      if (entry.tokenName !== null) {
        this.releaseTokenSlot(entry.tokenName);
        entry.tokenName = null;
      }
      this.entries.delete(key);
      this.db.deleteSideSession(entry.botId, entry.sessionId);
      this.publishLiveGauge(entry.botId);
    })();
    entry.stopPromise = p;
    this.pendingBackgroundStops.add(p);
    p.finally(() => this.pendingBackgroundStops.delete(p));
  }

  private sweep(): void {
    const now = this.clock();
    const idleTtl = this.config.agent_api.side_sessions.idle_ttl_ms;
    for (const entry of [...this.entries.values()]) {
      if (entry.state === "stopping") continue;
      // Hard TTL first: mark stopping regardless of inflight; release() will
      // complete teardown when inflight hits zero. If inflight is already
      // zero, stop immediately.
      if (now >= entry.hardExpiresAtMs) {
        if (entry.inflight === 0) {
          this.evict(entry, "hard");
        } else {
          // Block new acquires; release() drops inflight → scheduleStop.
          recordEviction(this.metrics, entry.botId, "hard");
          entry.state = "stopping";
          this.db.markSideSessionState(
            entry.botId,
            entry.sessionId,
            "stopping",
          );
          this.publishLiveGauge(entry.botId);
        }
        continue;
      }
      // Idle TTL: only if no turn is in flight.
      if (entry.inflight === 0 && now - entry.lastUsedAtMs > idleTtl) {
        this.evict(entry, "idle");
      }
    }
  }
}
