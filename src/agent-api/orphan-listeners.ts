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
import type { AgentRunner, RunnerEvent } from "../runner/types.js";
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
    runner: AgentRunner;
    botId: string;
    sessionId: string;
    turnId: number;
    /** Backstop — if no terminal event within this window, force-release. */
    backstopMs?: number;
  }): void {
    const { runner, botId, sessionId, turnId } = opts;
    const key = `${botId}\u0000${sessionId}\u0000${turnId}`;
    if (this.regs.has(key)) return;

    const reg: Registration = {
      botId,
      sessionId,
      turnId,
      unsubs: [],
      backstopTimer: null,
      resolved: false,
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
      runner.onSide(sessionId, "text_delta", (ev) => {
        if ("turnId" in ev && ev.turnId === String(turnId)) buffer += ev.text;
      }),
    );
    reg.unsubs.push(
      runner.onSide(sessionId, "done", (ev) => {
        const final =
          "finalText" in ev && typeof ev.finalText === "string" ? ev.finalText : buffer;
        onTerminal(
          { ...ev, finalText: final } as RunnerEvent,
          "done",
        );
      }),
    );
    reg.unsubs.push(
      runner.onSide(sessionId, "error", (ev) => onTerminal(ev, "error")),
    );
    reg.unsubs.push(
      runner.onSide(sessionId, "fatal", (ev) => onTerminal(ev, "fatal")),
    );

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
      try {
        this.pool.release(reg.botId, reg.sessionId);
      } catch {
        /* ok */
      }
      this.regs.delete(key);
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
