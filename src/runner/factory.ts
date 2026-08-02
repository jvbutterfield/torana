import type { LocalAttachment as Attachment } from "../platform/types.js";
import type {
  AgentRunner,
  AgentRunnerFactory,
  CreateRunnerSessionOptions,
  RunnerEventHandler,
  RunnerEventKind,
  RunnerSession,
  RunnerSessionCapabilities,
  SendTurnResult,
  TurnId,
  Unsubscribe,
} from "./types.js";

class LegacyRunnerSession implements RunnerSession {
  readonly id: string;
  private runner: AgentRunner;

  constructor(runner: AgentRunner, id: string) {
    this.runner = runner;
    this.id = id;
  }

  sendTurn(
    turnId: TurnId,
    text: string,
    attachments: Attachment[],
  ): SendTurnResult {
    return this.runner.sendSideTurn(this.id, turnId, text, attachments);
  }

  async cancel(): Promise<void> {
    await this.runner.stopSideSession(this.id);
  }

  async reset(): Promise<void> {
    await this.runner.stopSideSession(this.id);
  }

  async stop(graceMs?: number): Promise<void> {
    await this.runner.stopSideSession(this.id, graceMs);
  }

  on<E extends RunnerEventKind>(
    event: E,
    handler: RunnerEventHandler<E>,
  ): Unsubscribe {
    return this.runner.onSide(this.id, event, handler);
  }
}

/**
 * Migration adapter over the existing runner implementations. Conversation
 * code uses only the generic factory/session contract; the old side-session
 * methods remain an implementation detail until the runners are simplified.
 */
export class LegacyAgentRunnerFactory implements AgentRunnerFactory {
  private runner: AgentRunner;
  private capabilities: RunnerSessionCapabilities;

  constructor(runner: AgentRunner, capabilities: RunnerSessionCapabilities) {
    this.runner = runner;
    this.capabilities = capabilities;
  }

  sessionCapabilities(): RunnerSessionCapabilities {
    return this.capabilities;
  }

  async createSession(
    options: CreateRunnerSessionOptions,
  ): Promise<RunnerSession> {
    await this.runner.startSideSession(options.sessionKey, {
      resumeState: options.resumeState,
      onResumeStateChanged: options.onResumeStateChanged,
      managed: true,
    });
    return new LegacyRunnerSession(this.runner, options.sessionKey);
  }
}
