// Detached listeners for ask requests that hit timeout_ms while the runner
// is still busy. When a 202 response goes out, the pool entry MUST stay
// locked (inflight=1) because the subprocess is still mid-turn — releasing
// would let a subsequent acquire on the same session_id succeed but then
// fail sendSideTurn with busy.
//
// The orphan listener watches for the terminal event (done|error|fatal),
// applies it to the DB row, then calls pool.release.
//
// Invariant: for every acquire, exactly one of (handler finally, orphan
// listener onTerminal) calls release. Never both, never neither.

import type { GatewayDB } from "../db/gateway-db.js";
import type { SideSessionPool } from "./pool.js";
import type {
  AgentRunner,
  RunnerEvent,
  RunnerSession,
} from "../runner/types.js";
import type { Metrics } from "../metrics.js";
import { logger } from "../log.js";
import { recordOrphanResolution, type OrphanResolution } from "./metrics.js";

interface Registration {
  botId: string;
  sessionId: string;
  turnId: number;
  unsubs: Array<() => void>;
  backstopTimer: ReturnType<typeof setTimeout> | null;
  resolved: boolean;
  onRelease?: () => void;
}

export class OrphanListenerManager {
  private log = logger("agent-api.orphan");
  private regs = new Map<string, Registration>();

  constructor(
    private db: GatewayDB,
    private pool: SideSessionPool,
    private metrics?: Metrics,
  ) {}

  attach(opts: {
    session?: RunnerSession;
    /** @deprecated Compatibility input; new code passes `session`. */
    runner?: AgentRunner;
    botId: string;
    sessionId: string;
    turnId: number;
    /** Backstop — if no terminal event within this window, force-release. */
    backstopMs?: number;
    /**
     * Teardown that must happen on exactly the same schedule as the pool
     * release this listener owns — currently revoking the turn's Buzz
     * capability. Runs on every exit: terminal event, backstop, and
     * shutdown. Must be idempotent; must not throw.
     *
     * The handler cannot do this itself. Once a 202 goes out the turn is
     * still running, so tearing down in the handler's `finally` would strip
     * the agent's capability mid-turn.
     */
    onRelease?: () => void;
  }): void {
    const { botId, sessionId, turnId } = opts;
    const session =
      opts.session ??
      (opts.runner
        ? legacySessionView(opts.runner, sessionId)
        : (() => {
            throw new Error("orphan listener requires a runner session");
          })());
    const key = `${botId}\u0000${sessionId}\u0000${turnId}`;
    if (this.regs.has(key)) return;

    const reg: Registration = {
      botId,
      sessionId,
      turnId,
      unsubs: [],
      backstopTimer: null,
      resolved: false,
      onRelease: opts.onRelease,
    };
    this.regs.set(key, reg);

    const onTerminal = (
      ev: RunnerEvent,
      source: "done" | "error" | "fatal",
      outcome: OrphanResolution = source,
    ) => {
      if (reg.resolved) return;
      reg.resolved = true;
      for (const u of reg.unsubs) {
        try {
          u();
        } catch {
          /* ok */
        }
      }
      if (reg.backstopTimer) clearTimeout(reg.backstopTimer);
      this.applyTerminalToDb(turnId, source, ev);
      recordOrphanResolution(this.metrics, botId, outcome);
      this.runOnRelease(reg);
      try {
        this.pool.release(botId, sessionId);
      } catch (err) {
        this.log.warn("orphan release failed", {
          bot_id: botId,
          session_id: sessionId,
          turn_id: turnId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.regs.delete(key);
    };

    // Buffer text_delta into final_text for the case where done lacks it.
    let buffer = "";
    reg.unsubs.push(
      session.on("text_delta", (ev) => {
        if ("turnId" in ev && ev.turnId === String(turnId)) buffer += ev.text;
      }),
    );
    reg.unsubs.push(
      session.on("done", (ev) => {
        const final =
          "finalText" in ev && typeof ev.finalText === "string"
            ? ev.finalText
            : buffer;
        onTerminal({ ...ev, finalText: final } as RunnerEvent, "done");
      }),
    );
    reg.unsubs.push(session.on("error", (ev) => onTerminal(ev, "error")));
    reg.unsubs.push(session.on("fatal", (ev) => onTerminal(ev, "fatal")));

    const backstop = opts.backstopMs ?? 60 * 60 * 1000;
    reg.backstopTimer = setTimeout(() => {
      if (reg.resolved) return;
      this.log.warn("orphan backstop tripped — force-releasing", {
        bot_id: botId,
        session_id: sessionId,
        turn_id: turnId,
      });
      onTerminal(
        {
          kind: "error",
          turnId: String(turnId),
          message: "orphan backstop — no terminal event",
          retriable: false,
        },
        "error",
        "backstop",
      );
    }, backstop);
    (reg.backstopTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Force-release every pending registration. Called from main.ts shutdown
   * so pool.shutdown can drain without waiting on runners that may never
   * emit terminals.
   */
  shutdown(): void {
    for (const [key, reg] of [...this.regs.entries()]) {
      if (reg.resolved) continue;
      reg.resolved = true;
      for (const u of reg.unsubs) {
        try {
          u();
        } catch {
          /* ok */
        }
      }
      if (reg.backstopTimer) clearTimeout(reg.backstopTimer);
      this.runOnRelease(reg);
      try {
        this.pool.release(reg.botId, reg.sessionId);
      } catch {
        /* ok */
      }
      this.regs.delete(key);
    }
  }

  /**
   * Always call this BEFORE `pool.release`. Releasing first makes the
   * session available to the next acquire, which may mint a fresh
   * capability against the same runner session id — a revoke landing after
   * that would delete the *new* turn's capability file, not this turn's.
   */
  private runOnRelease(reg: Registration): void {
    if (!reg.onRelease) return;
    try {
      reg.onRelease();
    } catch (err) {
      this.log.warn("orphan release hook failed", {
        bot_id: reg.botId,
        session_id: reg.sessionId,
        turn_id: reg.turnId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private applyTerminalToDb(
    turnId: number,
    source: "done" | "error" | "fatal",
    ev: RunnerEvent,
  ): void {
    try {
      if (source === "done") {
        const done = ev as Extract<RunnerEvent, { kind: "done" }>;
        this.db.setTurnFinalText(
          turnId,
          done.finalText ?? "",
          done.usage ? JSON.stringify(done.usage) : null,
          done.durationMs ?? null,
        );
      } else if (source === "error") {
        const errev = ev as Extract<RunnerEvent, { kind: "error" }>;
        this.db.completeTurn(turnId, errev.message);
      } else {
        const fatal = ev as Extract<RunnerEvent, { kind: "fatal" }>;
        this.db.completeTurn(turnId, fatal.message);
      }
    } catch (err) {
      this.log.warn("orphan db update failed", {
        turn_id: turnId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function legacySessionView(
  runner: AgentRunner,
  sessionId: string,
): Pick<RunnerSession, "on"> {
  return {
    on: (event, handler) => runner.onSide(sessionId, event, handler),
  };
}
