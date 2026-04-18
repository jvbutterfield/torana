import { Database, type Statement } from "bun:sqlite";
import { logger } from "../log.js";
import type { BotId } from "../config/schema.js";

const log = logger("db");

/** Wrapper around the SQLite state. Keyed on bot_id throughout (v1 schema). */
export class GatewayDB {
  private _db: Database;
  private stmts!: {
    insertUpdate: Statement;
    getUpdateStatus: Statement;
    setUpdateStatus: Statement;
    createTurn: Statement;
    startTurn: Statement;
    completeTurn: Statement;
    interruptTurn: Statement;
    markTurnDead: Statement;
    setTurnFirstOutput: Statement;
    setTurnLastOutput: Statement;
    getRunningTurns: Statement;
    getQueuedTurns: Statement;
    getTurnText: Statement;
    getTurnAttachments: Statement;
    getTurnSourceUpdateId: Statement;
    requeueTurn: Statement;
    cancelTurnOutbox: Statement;
    insertOutbox: Statement;
    markOutboxSent: Statement;
    markOutboxFailed: Statement;
    markOutboxRetryOrFail: Statement;
    getPendingOutbox: Statement;
    getOutboxRow: Statement;
    supersededEdit: Statement;
    initWorkerState: Statement;
    getWorkerState: Statement;
    incWorkerGen: Statement;
    getWorkerGen: Statement;
    resetAllWorkers: Statement;
    initStreamState: Statement;
    getStreamState: Statement;
    mailboxDepth: Statement;
    lastTurnAt: Statement;
    initBotState: Statement;
    getBotState: Statement;
    setBotOffset: Statement;
    setBotDisabled: Statement;
    clearBotDisabled: Statement;
  };

  constructor(dbPath: string) {
    log.info("opening database", { path: dbPath });
    this._db = new Database(dbPath, { create: true });
    this._db.exec("PRAGMA journal_mode=WAL");
    this._db.exec("PRAGMA busy_timeout=5000");
    this._db.exec("PRAGMA synchronous=NORMAL");
    this._db.exec("PRAGMA foreign_keys=ON");
    this.prepareStatements();
    log.info("database ready");
  }

  /** Test-only hook so tests can apply schema.sql without a migration run. */
  exec(sql: string): void {
    this._db.exec(sql);
  }

  /** Direct query access for utility code (e.g. doctor checks). */
  query(sql: string): Statement {
    return this._db.prepare(sql);
  }

  private prepareStatements(): void {
    const d = this._db;
    this.stmts = {
      insertUpdate: d.prepare(`
        INSERT INTO inbound_updates (bot_id, telegram_update_id, chat_id, message_id, from_user_id, payload_json, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (bot_id, telegram_update_id) DO NOTHING
      `),
      getUpdateStatus: d.prepare(
        "SELECT id, status FROM inbound_updates WHERE bot_id = ? AND telegram_update_id = ?",
      ),
      setUpdateStatus: d.prepare("UPDATE inbound_updates SET status = ? WHERE id = ?"),
      createTurn: d.prepare(
        "INSERT INTO turns (bot_id, chat_id, source_update_id, attachment_paths_json) VALUES (?, ?, ?, ?)",
      ),
      startTurn: d.prepare(
        "UPDATE turns SET status = 'running', started_at = datetime('now'), worker_generation = ? WHERE id = ?",
      ),
      completeTurn: d.prepare(
        "UPDATE turns SET status = ?, completed_at = datetime('now'), error_text = ? WHERE id = ?",
      ),
      interruptTurn: d.prepare(
        "UPDATE turns SET status = 'interrupted', completed_at = datetime('now'), error_text = ? WHERE id = ?",
      ),
      markTurnDead: d.prepare(
        "UPDATE turns SET status = 'dead', completed_at = datetime('now'), error_text = ? WHERE id = ?",
      ),
      setTurnFirstOutput: d.prepare(
        "UPDATE turns SET first_output_at = COALESCE(first_output_at, datetime('now')), last_output_at = datetime('now') WHERE id = ?",
      ),
      setTurnLastOutput: d.prepare(
        "UPDATE turns SET last_output_at = datetime('now') WHERE id = ?",
      ),
      getRunningTurns: d.prepare(
        "SELECT id, bot_id, chat_id, source_update_id, first_output_at FROM turns WHERE status = 'running'",
      ),
      getQueuedTurns: d.prepare(
        "SELECT id, chat_id, source_update_id FROM turns WHERE bot_id = ? AND status = 'queued' ORDER BY id ASC",
      ),
      getTurnText: d.prepare(
        "SELECT payload_json FROM inbound_updates WHERE id = (SELECT source_update_id FROM turns WHERE id = ?)",
      ),
      getTurnAttachments: d.prepare(
        "SELECT attachment_paths_json FROM turns WHERE id = ?",
      ),
      getTurnSourceUpdateId: d.prepare(
        "SELECT source_update_id FROM turns WHERE id = ?",
      ),
      requeueTurn: d.prepare(
        "UPDATE turns SET status = 'queued', started_at = NULL, worker_generation = NULL WHERE id = ?",
      ),
      cancelTurnOutbox: d.prepare(
        "UPDATE outbox SET status = 'failed', last_error = ? WHERE turn_id = ? AND status IN ('pending', 'retrying')",
      ),
      insertOutbox: d.prepare(
        "INSERT INTO outbox (turn_id, bot_id, chat_id, kind, telegram_message_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
      ),
      markOutboxSent: d.prepare(
        "UPDATE outbox SET status = 'sent', telegram_message_id = COALESCE(?, telegram_message_id) WHERE id = ?",
      ),
      markOutboxFailed: d.prepare(
        "UPDATE outbox SET status = 'failed', last_error = ? WHERE id = ?",
      ),
      markOutboxRetryOrFail: d.prepare(`
        UPDATE outbox SET
          status = CASE WHEN attempt_count + 1 >= ? THEN 'dead' ELSE 'retrying' END,
          attempt_count = attempt_count + 1,
          next_attempt_at = CASE WHEN attempt_count + 1 >= ? THEN next_attempt_at ELSE ? END,
          last_error = ?
        WHERE id = ?
      `),
      getPendingOutbox: d.prepare(`
        SELECT id, turn_id, bot_id, chat_id, kind, telegram_message_id, payload_json, status, attempt_count
        FROM outbox
        WHERE status IN ('pending', 'retrying')
          AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
        ORDER BY id ASC
      `),
      getOutboxRow: d.prepare(
        "SELECT telegram_message_id, status FROM outbox WHERE id = ?",
      ),
      supersededEdit: d.prepare(
        "SELECT id FROM outbox WHERE telegram_message_id = ? AND id > ? AND status = 'sent' LIMIT 1",
      ),
      initWorkerState: d.prepare(
        "INSERT INTO worker_state (bot_id) VALUES (?) ON CONFLICT (bot_id) DO UPDATE SET status = 'starting', pid = NULL",
      ),
      getWorkerState: d.prepare("SELECT * FROM worker_state WHERE bot_id = ?"),
      incWorkerGen: d.prepare(
        "UPDATE worker_state SET generation = generation + 1 WHERE bot_id = ?",
      ),
      getWorkerGen: d.prepare("SELECT generation FROM worker_state WHERE bot_id = ?"),
      resetAllWorkers: d.prepare(
        "UPDATE worker_state SET status = 'starting', pid = NULL",
      ),
      initStreamState: d.prepare(
        "INSERT OR REPLACE INTO stream_state (turn_id, active_telegram_message_id, buffer_text, last_flushed_at, segment_index) VALUES (?, NULL, '', NULL, 0)",
      ),
      getStreamState: d.prepare("SELECT * FROM stream_state WHERE turn_id = ?"),
      mailboxDepth: d.prepare(
        "SELECT COUNT(*) as count FROM turns WHERE bot_id = ? AND status IN ('queued', 'running')",
      ),
      lastTurnAt: d.prepare(
        "SELECT completed_at FROM turns WHERE bot_id = ? AND status IN ('completed', 'failed') ORDER BY id DESC LIMIT 1",
      ),
      initBotState: d.prepare(
        "INSERT INTO bot_state (bot_id) VALUES (?) ON CONFLICT (bot_id) DO NOTHING",
      ),
      getBotState: d.prepare("SELECT * FROM bot_state WHERE bot_id = ?"),
      setBotOffset: d.prepare(
        "UPDATE bot_state SET last_update_id = ?, updated_at = datetime('now') WHERE bot_id = ?",
      ),
      setBotDisabled: d.prepare(
        "UPDATE bot_state SET disabled = 1, disabled_reason = ?, updated_at = datetime('now') WHERE bot_id = ?",
      ),
      clearBotDisabled: d.prepare(
        "UPDATE bot_state SET disabled = 0, disabled_reason = NULL, updated_at = datetime('now') WHERE bot_id = ?",
      ),
    };
  }

  transaction<T>(fn: () => T): T {
    const tx = this._db.transaction(fn);
    return tx();
  }

  // --- Inbound updates ---

  /** Look up a pre-existing dedup row for (bot_id, telegram_update_id). */
  getInboundUpdateStatus(
    botId: BotId,
    telegramUpdateId: number,
  ): { id: number; status: string } | null {
    return this.stmts.getUpdateStatus.get(botId, telegramUpdateId) as
      | { id: number; status: string }
      | null;
  }

  insertUpdate(
    botId: BotId,
    telegramUpdateId: number,
    chatId: number,
    messageId: number,
    fromUserId: string,
    payloadJson: string,
    status: "received" | "enqueued" | "rejected" = "received",
  ): number | null {
    const result = this.stmts.insertUpdate.run(
      botId,
      telegramUpdateId,
      chatId,
      messageId,
      fromUserId,
      payloadJson,
      status,
    );
    if (result.changes === 0) return null;
    return Number(result.lastInsertRowid);
  }

  setUpdateStatus(id: number, status: string): void {
    this.stmts.setUpdateStatus.run(status, id);
  }

  // --- Turns ---

  createTurn(
    botId: BotId,
    chatId: number,
    sourceUpdateId: number,
    attachmentPaths?: string[],
  ): number {
    const result = this.stmts.createTurn.run(
      botId,
      chatId,
      sourceUpdateId,
      attachmentPaths ? JSON.stringify(attachmentPaths) : null,
    );
    return Number(result.lastInsertRowid);
  }

  startTurn(turnId: number, workerGeneration: number): void {
    this.stmts.startTurn.run(workerGeneration, turnId);
  }

  completeTurn(turnId: number, errorText?: string): void {
    this.stmts.completeTurn.run(
      errorText ? "failed" : "completed",
      errorText ?? null,
      turnId,
    );
  }

  interruptTurn(turnId: number, reason: string): void {
    this.stmts.interruptTurn.run(reason, turnId);
  }

  markTurnDead(turnId: number, reason: string): void {
    this.stmts.markTurnDead.run(reason, turnId);
  }

  setTurnFirstOutput(turnId: number): void {
    this.stmts.setTurnFirstOutput.run(turnId);
  }

  setTurnLastOutput(turnId: number): void {
    this.stmts.setTurnLastOutput.run(turnId);
  }

  getRunningTurns(): Array<{
    id: number;
    bot_id: BotId;
    chat_id: number;
    source_update_id: number;
    first_output_at: string | null;
  }> {
    return this.stmts.getRunningTurns.all() as Array<{
      id: number;
      bot_id: BotId;
      chat_id: number;
      source_update_id: number;
      first_output_at: string | null;
    }>;
  }

  getQueuedTurns(
    botId: BotId,
  ): Array<{ id: number; chat_id: number; source_update_id: number }> {
    return this.stmts.getQueuedTurns.all(botId) as Array<{
      id: number;
      chat_id: number;
      source_update_id: number;
    }>;
  }

  getTurnText(turnId: number): string | null {
    const row = this.stmts.getTurnText.get(turnId) as { payload_json: string } | null;
    if (!row) return null;
    try {
      const payload = JSON.parse(row.payload_json);
      return payload?.message?.text ?? payload?.message?.caption ?? null;
    } catch {
      return null;
    }
  }

  getTurnAttachments(turnId: number): string[] {
    const row = this.stmts.getTurnAttachments.get(turnId) as
      | { attachment_paths_json: string | null }
      | null;
    if (!row?.attachment_paths_json) return [];
    try {
      return JSON.parse(row.attachment_paths_json) as string[];
    } catch {
      return [];
    }
  }

  getTurnSourceUpdateId(turnId: number): number | null {
    const row = this.stmts.getTurnSourceUpdateId.get(turnId) as
      | { source_update_id: number }
      | null;
    return row?.source_update_id ?? null;
  }

  requeueTurn(turnId: number): void {
    this.stmts.requeueTurn.run(turnId);
  }

  /** Cancel pending/retrying outbox items for a turn — used by crash recovery. */
  cancelPendingOutboxForTurn(turnId: number): void {
    this.stmts.cancelTurnOutbox.run("turn re-queued after restart", turnId);
  }

  // --- Outbox ---

  insertOutbox(
    turnId: number,
    botId: BotId,
    chatId: number,
    kind: "send" | "edit",
    payloadJson: string,
    telegramMessageId?: number,
  ): number {
    const result = this.stmts.insertOutbox.run(
      turnId,
      botId,
      chatId,
      kind,
      telegramMessageId ?? null,
      payloadJson,
    );
    return Number(result.lastInsertRowid);
  }

  markOutboxSent(id: number, telegramMessageId?: number): void {
    this.stmts.markOutboxSent.run(telegramMessageId ?? null, id);
  }

  markOutboxFailed(id: number, error: string): void {
    this.stmts.markOutboxFailed.run(error, id);
  }

  markOutboxRetrying(
    id: number,
    error: string,
    nextAttemptAt: string,
    maxAttempts: number,
  ): void {
    this.stmts.markOutboxRetryOrFail.run(
      maxAttempts,
      maxAttempts,
      nextAttemptAt,
      error,
      id,
    );
  }

  getPendingOutbox(): Array<{
    id: number;
    turn_id: number;
    bot_id: BotId;
    chat_id: number;
    kind: string;
    telegram_message_id: number | null;
    payload_json: string;
    status: string;
    attempt_count: number;
  }> {
    return this.stmts.getPendingOutbox.all() as Array<{
      id: number;
      turn_id: number;
      bot_id: BotId;
      chat_id: number;
      kind: string;
      telegram_message_id: number | null;
      payload_json: string;
      status: string;
      attempt_count: number;
    }>;
  }

  getOutboxRow(
    id: number,
  ): { telegram_message_id: number | null; status: string } | null {
    return this.stmts.getOutboxRow.get(id) as
      | { telegram_message_id: number | null; status: string }
      | null;
  }

  hasSupersedingEdit(telegramMessageId: number | null, afterId: number): boolean {
    if (!telegramMessageId) return false;
    return !!this.stmts.supersededEdit.get(telegramMessageId, afterId);
  }

  // --- Worker state ---

  initWorkerState(botId: BotId): void {
    this.stmts.initWorkerState.run(botId);
  }

  private dynamicUpdate(
    table: string,
    whereCol: string,
    whereVal: string | number,
    updates: Record<string, string | number | null>,
  ): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(updates)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(whereVal);
    this._db
      .prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${whereCol} = ?`)
      .run(...vals);
  }

  updateWorkerState(
    botId: BotId,
    updates: Partial<{
      pid: number | null;
      generation: number;
      status: string;
      started_at: string;
      last_event_at: string;
      last_ready_at: string;
      consecutive_failures: number;
      last_error: string | null;
    }>,
  ): void {
    this.dynamicUpdate(
      "worker_state",
      "bot_id",
      botId,
      updates as Record<string, string | number | null>,
    );
  }

  getWorkerState(botId: BotId): {
    bot_id: string;
    pid: number | null;
    generation: number;
    status: string;
    started_at: string | null;
    last_event_at: string | null;
    consecutive_failures: number;
    last_error: string | null;
  } | null {
    return this.stmts.getWorkerState.get(botId) as {
      bot_id: string;
      pid: number | null;
      generation: number;
      status: string;
      started_at: string | null;
      last_event_at: string | null;
      consecutive_failures: number;
      last_error: string | null;
    } | null;
  }

  incrementWorkerGeneration(botId: BotId): number {
    this.stmts.incWorkerGen.run(botId);
    const row = this.stmts.getWorkerGen.get(botId) as { generation: number };
    return row.generation;
  }

  resetAllWorkerStates(): void {
    this.stmts.resetAllWorkers.run();
  }

  // --- Stream state ---

  initStreamState(turnId: number): void {
    this.stmts.initStreamState.run(turnId);
  }

  getStreamState(turnId: number): {
    turn_id: number;
    active_telegram_message_id: number | null;
    buffer_text: string;
    last_flushed_at: string | null;
    segment_index: number;
  } | null {
    return this.stmts.getStreamState.get(turnId) as {
      turn_id: number;
      active_telegram_message_id: number | null;
      buffer_text: string;
      last_flushed_at: string | null;
      segment_index: number;
    } | null;
  }

  updateStreamState(
    turnId: number,
    updates: Partial<{
      active_telegram_message_id: number | null;
      buffer_text: string;
      last_flushed_at: string;
      segment_index: number;
    }>,
  ): void {
    this.dynamicUpdate(
      "stream_state",
      "turn_id",
      turnId,
      updates as Record<string, string | number | null>,
    );
  }

  // --- Bot state (polling offset, disabled flag) ---

  initBotState(botId: BotId): void {
    this.stmts.initBotState.run(botId);
  }

  getBotState(botId: BotId): {
    bot_id: string;
    last_update_id: number | null;
    disabled: number;
    disabled_reason: string | null;
    updated_at: string;
  } | null {
    return this.stmts.getBotState.get(botId) as {
      bot_id: string;
      last_update_id: number | null;
      disabled: number;
      disabled_reason: string | null;
      updated_at: string;
    } | null;
  }

  setBotLastUpdateId(botId: BotId, lastUpdateId: number): void {
    this.stmts.setBotOffset.run(lastUpdateId, botId);
  }

  setBotDisabled(botId: BotId, reason: string): void {
    this.stmts.setBotDisabled.run(reason, botId);
  }

  clearBotDisabled(botId: BotId): void {
    this.stmts.clearBotDisabled.run(botId);
  }

  // --- Metrics / observability ---

  getMailboxDepth(botId: BotId): number {
    const row = this.stmts.mailboxDepth.get(botId) as { count: number };
    return row.count;
  }

  getLastTurnAt(botId: BotId): string | null {
    const row = this.stmts.lastTurnAt.get(botId) as
      | { completed_at: string }
      | null;
    return row?.completed_at ?? null;
  }

  close(): void {
    this._db.close();
    log.info("database closed");
  }
}
