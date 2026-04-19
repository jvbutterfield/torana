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
import { logger, type Logger } from "../log.js";

export interface SideSessionPoolOptions {
  config: Config;
  db: GatewayDB;
  registry: BotRegistry;
  clock?: () => number;
  /** Sweep cadence (ms). Default 60_000. Overridable for tests. */
  sweepIntervalMs?: number;
}

export type AcquireResult =
  | { kind: "ok"; sessionId: string; ephemeral: boolean }
  | { kind: "capacity" }
  | { kind: "busy" }
  | { kind: "runner_error"; message: string }
  | { kind: "gateway_shutting_down" }
  | { kind: "runner_does_not_support_side_sessions" };

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
}

function entryKey(botId: string, sessionId: string): string {
  return `${botId}\u0000${sessionId}`;
}

export class SideSessionPool {
  private config: Config;
  private db: GatewayDB;
  private registry: BotRegistry;
  private clock: () => number;
  private log: Logger = logger("agent-api.pool");
  private entries = new Map<string, PoolEntry>();
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
    this.clock = opts.clock ?? Date.now;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60_000;

    // Startup reconciliation: any rows the prior process left are orphans.
    this.db.markAllSideSessionsStopped();
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
   * typically in a finally block.
   */
  async acquire(botId: string, sessionId: string | null): Promise<AcquireResult> {
    if (this.shuttingDown) return { kind: "gateway_shutting_down" };

    const bot = this.registry.bot(botId);
    if (!bot) return { kind: "runner_error", message: `unknown bot '${botId}'` };
    if (!bot.runner.supportsSideSessions()) {
      return { kind: "runner_does_not_support_side_sessions" };
    }

    // Ephemeral path — mint a UUID and take the fresh-spawn branch.
    if (sessionId === null) {
      const minted = `eph-${randomUUID()}`;
      return this.spawnAndRegister(botId, minted, true);
    }

    const key = entryKey(botId, sessionId);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.state === "stopping") {
        // Treat as miss — the entry is on its way out.
        this.entries.delete(key);
      } else {
        if (existing.inflight > 0) {
          return { kind: "busy" };
        }
        existing.inflight = 1;
        existing.lastUsedAtMs = this.clock();
        existing.state = "busy";
        this.db.markSideSessionState(botId, sessionId, "busy");
        return { kind: "ok", sessionId, ephemeral: existing.ephemeral };
      }
    }

    // Miss — check caps, evict if needed, then spawn.
    const capResult = this.ensureCapacity(botId);
    if (capResult.kind === "err") return { kind: "capacity" };
    return this.spawnAndRegister(botId, sessionId, false);
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
  async stop(botId: string, sessionId: string, graceMs?: number): Promise<void> {
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
    this.scheduleStop(entry, this.config.shutdown.runner_grace_secs * 1000);
  }

  private scheduleStop(entry: PoolEntry, graceMs: number): void {
    if (entry.stopPromise) return;
    entry.state = "stopping";
    this.db.markSideSessionState(entry.botId, entry.sessionId, "stopping");
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
      this.entries.delete(key);
      this.db.deleteSideSession(entry.botId, entry.sessionId);
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
          entry.state = "stopping";
          this.db.markSideSessionState(entry.botId, entry.sessionId, "stopping");
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
