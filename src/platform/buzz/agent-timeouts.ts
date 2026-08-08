// Per-agent timeout overrides for Desktop-managed agents (R11.3 / R14.6).
//
// Gateway configuration carries one turn timeout for the whole process
// (`worker_tuning.turn_timeout_secs`), which is right for YAML agents: the
// operator wrote them and can edit that number. A Desktop-managed agent
// carries its own requested timeouts, already clamped into the harness
// ceilings at projection time, and those have to reach the dispatch timer and
// the idle sweep without turning into a second configuration system.
//
// This is a lookup, not a source of truth. The row is the truth; entries here
// are written when an agent is created or restored and dropped when it is
// removed, so a lookup miss simply means "not a provisioned agent — use the
// gateway default", which is exactly the behaviour a YAML agent needs.

import type { AppliedTimeouts } from "./provisioned-agents.js";

export class AgentTimeoutRegistry {
  readonly #byAgent = new Map<string, AppliedTimeouts>();

  set(agentId: string, applied: AppliedTimeouts): void {
    this.#byAgent.set(agentId, applied);
  }

  get(agentId: string): AppliedTimeouts | null {
    return this.#byAgent.get(agentId) ?? null;
  }

  delete(agentId: string): boolean {
    return this.#byAgent.delete(agentId);
  }

  get size(): number {
    return this.#byAgent.size;
  }

  /**
   * Turn timeout in milliseconds for one agent, falling back to the gateway
   * default. Returns the fallback unchanged for any agent with no override, so
   * callers never need to know which kind of agent they are dispatching for.
   */
  turnTimeoutMsFor(agentId: string, fallbackMs: number): number {
    const applied = this.#byAgent.get(agentId);
    return applied ? applied.turnTimeoutSecs * 1000 : fallbackMs;
  }
}
