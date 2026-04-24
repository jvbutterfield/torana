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
    getCodexThreadId: Statement;
    setCodexThreadId: Statement;
    initStreamState: Statement;
    getStreamState: Statement;
    mailboxDepth: Statement;
    lastTurnAt: Statement;
    initBotState: Statement;
    getBotState: Statement;
    setBotOffset: Statement;
    setBotDisabled: Statement;
    clearBotDisabled: Statement;
    getExpiredAttachmentTurns: Statement;
    clearTurnAttachments: Statement;
    // Agent API additions
    allocateSyntheticInbound: Statement;
    upsertUserChat: Statement;
    getLastChatForUser: Statement;
    listUserChatsByBot: Statement;
    getIdempotencyTurn: Statement;
    insertIdempotency: Statement;
    sweepIdempotency: Statement;
    upsertSideSession: Statement;
    markSideSessionState: Statement;
    deleteSideSession: Statement;
    listSideSessions: Statement;
    markAllSideSessionsStopped: Statement;
    insertAskTurnRow: Statement;
    insertSendTurnRow: Statement;
    setTurnFinalText: Statement;
    getTurnExtended: Statement;
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

  /** Raw SQL exec — used by tests to seed fixtures. */
  exec(sql: string): void {
    this._db.exec(sql);
  }

  /** Prepare a raw statement — used by tests to assert DB state. */
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
      setUpdateStatus: d.prepare(
        "UPDATE inbound_updates SET status = ? WHERE id = ?",
      ),
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
      getWorkerGen: d.prepare(
        "SELECT generation FROM worker_state WHERE bot_id = ?",
      ),
      resetAllWorkers: d.prepare(
        "UPDATE worker_state SET status = 'starting', pid = NULL",
      ),
      getCodexThreadId: d.prepare(
        "SELECT codex_thread_id FROM worker_state WHERE bot_id = ?",
      ),
      setCodexThreadId: d.prepare(
        "UPDATE worker_state SET codex_thread_id = ? WHERE bot_id = ?",
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
      getExpiredAttachmentTurns: d.prepare(`
        SELECT id, attachment_paths_json FROM turns
        WHERE attachment_paths_json IS NOT NULL
          AND completed_at IS NOT NULL
          AND CAST(strftime('%s', completed_at) AS INTEGER) <= CAST(strftime('%s', 'now') AS INTEGER) - ?
        ORDER BY id ASC
        LIMIT 500
      `),
      clearTurnAttachments: d.prepare(
        "UPDATE turns SET attachment_paths_json = NULL WHERE id = ?",
      ),

      // --- Agent API ---

      allocateSyntheticInbound: d.prepare(`
        INSERT INTO inbound_updates (bot_id, telegram_update_id, chat_id, message_id, from_user_id, payload_json, status)
        SELECT
          $bot_id,
          COALESCE(MIN(telegram_update_id), 0) - 1,
          $chat_id,
          0,
          $from_user_id,
          $payload_json,
          'enqueued'
        FROM inbound_updates
        WHERE bot_id = $bot_id AND telegram_update_id < 0
        RETURNING id
      `),

      upsertUserChat: d.prepare(`
        INSERT INTO user_chats (bot_id, telegram_user_id, chat_id, last_inbound_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT (bot_id, telegram_user_id) DO UPDATE SET
          chat_id = excluded.chat_id,
          last_inbound_at = excluded.last_inbound_at
      `),
      getLastChatForUser: d.prepare(
        "SELECT chat_id FROM user_chats WHERE bot_id = ? AND telegram_user_id = ?",
      ),
      listUserChatsByBot: d.prepare(
        "SELECT chat_id FROM user_chats WHERE bot_id = ?",
      ),

      getIdempotencyTurn: d.prepare(
        "SELECT turn_id FROM agent_api_idempotency WHERE bot_id = ? AND idempotency_key = ?",
      ),
      insertIdempotency: d.prepare(
        "INSERT INTO agent_api_idempotency (bot_id, idempotency_key, turn_id) VALUES (?, ?, ?)",
      ),
      sweepIdempotency: d.prepare(
        "DELETE FROM agent_api_idempotency WHERE CAST(strftime('%s', created_at) AS INTEGER) * 1000 < ?",
      ),

      upsertSideSession: d.prepare(`
        INSERT INTO side_sessions (bot_id, session_id, pid, started_at, last_used_at, hard_expires_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (bot_id, session_id) DO UPDATE SET
          pid = excluded.pid,
          last_used_at = excluded.last_used_at,
          hard_expires_at = excluded.hard_expires_at,
          state = excluded.state
      `),
      markSideSessionState: d.prepare(
        "UPDATE side_sessions SET state = ?, last_used_at = datetime('now') WHERE bot_id = ? AND session_id = ?",
      ),
      deleteSideSession: d.prepare(
        "DELETE FROM side_sessions WHERE bot_id = ? AND session_id = ?",
      ),
      listSideSessions: d.prepare(
        "SELECT bot_id, session_id, pid, started_at, last_used_at, hard_expires_at, state FROM side_sessions WHERE bot_id = ?",
      ),
      markAllSideSessionsStopped: d.prepare(
        "UPDATE side_sessions SET state = 'stopped' WHERE state != 'stopped'",
      ),

      insertAskTurnRow: d.prepare(`
        INSERT INTO turns (bot_id, chat_id, source_update_id, status, started_at,
                           attachment_paths_json, source, agent_api_token_name)
        VALUES (?, 0, ?, 'running', datetime('now'), ?, 'agent_api_ask', ?)
        RETURNING id
      `),
      insertSendTurnRow: d.prepare(`
        INSERT INTO turns (bot_id, chat_id, source_update_id, status,
                           attachment_paths_json, source, agent_api_token_name,
                           agent_api_source_label, idempotency_key)
        VALUES (?, ?, ?, 'queued', ?, 'agent_api_send', ?, ?, ?)
        RETURNING id
      `),
      setTurnFinalText: d.prepare(`
        UPDATE turns SET
          status = 'completed',
          final_text = ?,
          usage_json = ?,
          duration_ms = ?,
          completed_at = datetime('now')
        WHERE id = ?
      `),
      getTurnExtended: d.prepare(`
        SELECT t.id, t.bot_id, t.chat_id, t.source_update_id, t.status,
               t.started_at, t.completed_at, t.first_output_at, t.last_output_at,
               t.error_text, t.source, t.agent_api_token_name,
               t.agent_api_source_label, t.final_text, t.idempotency_key,
               t.usage_json, t.duration_ms,
               iu.payload_json AS inbound_payload_json
        FROM turns t
        LEFT JOIN inbound_updates iu ON t.source_update_id = iu.id
        WHERE t.id = ?
      `),
    };
  }

  transaction<T>(fn: () => T): T {
    const tx = this._db.transaction(fn);
    return tx();
  }

  /**
   * Like {@link transaction} but uses `BEGIN IMMEDIATE`, acquiring the write
   * lock up-front. Prevents two concurrent writers from both reading the same
   * `MIN(...)` and computing the same next synthetic id. Used by agent-API
   * insert helpers.
   */
  transactionImmediate<T>(fn: () => T): T {
    const tx = this._db.transaction(fn) as unknown as {
      (): T;
      immediate(): T;
    };
    return tx.immediate();
  }

  // --- Inbound updates ---

  /** Look up a pre-existing dedup row for (bot_id, telegram_update_id). */
  getInboundUpdateStatus(
    botId: BotId,
    telegramUpdateId: number,
  ): { id: number; status: string } | null {
    return this.stmts.getUpdateStatus.get(botId, telegramUpdateId) as {
      id: number;
      status: string;
    } | null;
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
    const row = this.stmts.getTurnText.get(turnId) as {
      payload_json: string;
    } | null;
    if (!row) return null;
    try {
      const payload = JSON.parse(row.payload_json);
      // Agent-API send rows store the marker-wrapped prompt on the
      // synthetic inbound payload — return that verbatim so the dispatch
      // loop can feed it to the main runner.
      if (payload?.kind === "send" && typeof payload.prompt === "string") {
        return payload.prompt;
      }
      return payload?.message?.text ?? payload?.message?.caption ?? null;
    } catch {
      return null;
    }
  }

  getTurnAttachments(turnId: number): string[] {
    const row = this.stmts.getTurnAttachments.get(turnId) as {
      attachment_paths_json: string | null;
    } | null;
    if (!row?.attachment_paths_json) return [];
    try {
      return JSON.parse(row.attachment_paths_json) as string[];
    } catch {
      return [];
    }
  }

  getTurnSourceUpdateId(turnId: number): number | null {
    const row = this.stmts.getTurnSourceUpdateId.get(turnId) as {
      source_update_id: number;
    } | null;
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
    return this.stmts.getOutboxRow.get(id) as {
      telegram_message_id: number | null;
      status: string;
    } | null;
  }

  hasSupersedingEdit(
    telegramMessageId: number | null,
    afterId: number,
  ): boolean {
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

  /**
   * Most recently captured Codex thread_id for the bot, or null if the bot
   * has never captured one. Used by CodexRunner to issue
   * `codex exec resume <id>` on the first turn after a gateway restart.
   */
  getCodexThreadId(botId: BotId): string | null {
    const row = this.stmts.getCodexThreadId.get(botId) as {
      codex_thread_id: string | null;
    } | null;
    return row?.codex_thread_id ?? null;
  }

  /**
   * Persist (or clear) the Codex thread_id for the bot. Pass null after
   * `reset()` so the next turn starts a fresh Codex session.
   */
  setCodexThreadId(botId: BotId, threadId: string | null): void {
    this.stmts.setCodexThreadId.run(threadId, botId);
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
    const row = this.stmts.lastTurnAt.get(botId) as {
      completed_at: string;
    } | null;
    return row?.completed_at ?? null;
  }

  /**
   * Find completed turns whose attachment paths are older than `retentionSecs`
   * seconds. Caller is responsible for deleting the files and then calling
   * {@link clearTurnAttachments} to mark them swept.
   */
  getExpiredAttachmentTurns(
    retentionSecs: number,
  ): Array<{ id: number; attachment_paths_json: string }> {
    return this.stmts.getExpiredAttachmentTurns.all(retentionSecs) as Array<{
      id: number;
      attachment_paths_json: string;
    }>;
  }

  clearTurnAttachments(turnId: number): void {
    this.stmts.clearTurnAttachments.run(turnId);
  }

  // --- Agent API ---

  /**
   * Record (or refresh) the most recent authorized chat for a (bot, user).
   * Called from processUpdate so send calls can look up `chat_id` by
   * `telegram_user_id` later.
   */
  upsertUserChat(botId: BotId, telegramUserId: string, chatId: number): void {
    this.stmts.upsertUserChat.run(botId, telegramUserId, chatId);
  }

  getLastChatForUser(
    botId: BotId,
    telegramUserId: string,
  ): { chat_id: number } | null {
    return this.stmts.getLastChatForUser.get(botId, telegramUserId) as {
      chat_id: number;
    } | null;
  }

  listUserChatsByBot(botId: BotId): Array<{ chat_id: number }> {
    return this.stmts.listUserChatsByBot.all(botId) as Array<{
      chat_id: number;
    }>;
  }

  getIdempotencyTurn(botId: BotId, key: string): number | null {
    const row = this.stmts.getIdempotencyTurn.get(botId, key) as {
      turn_id: number;
    } | null;
    return row?.turn_id ?? null;
  }

  /** Delete idempotency rows created before `thresholdMs` (ms since epoch). */
  sweepIdempotency(thresholdMs: number): number {
    const res = this.stmts.sweepIdempotency.run(thresholdMs);
    return Number(res.changes ?? 0);
  }

  upsertSideSession(row: {
    botId: BotId;
    sessionId: string;
    pid: number | null;
    startedAt: string;
    lastUsedAt: string;
    hardExpiresAt: string;
    state: "starting" | "ready" | "busy" | "stopping" | "stopped";
  }): void {
    this.stmts.upsertSideSession.run(
      row.botId,
      row.sessionId,
      row.pid,
      row.startedAt,
      row.lastUsedAt,
      row.hardExpiresAt,
      row.state,
    );
  }

  markSideSessionState(
    botId: BotId,
    sessionId: string,
    state: "starting" | "ready" | "busy" | "stopping" | "stopped",
  ): void {
    this.stmts.markSideSessionState.run(state, botId, sessionId);
  }

  deleteSideSession(botId: BotId, sessionId: string): void {
    this.stmts.deleteSideSession.run(botId, sessionId);
  }

  listSideSessions(botId: BotId): Array<{
    bot_id: string;
    session_id: string;
    pid: number | null;
    started_at: string;
    last_used_at: string;
    hard_expires_at: string;
    state: string;
  }> {
    return this.stmts.listSideSessions.all(botId) as Array<{
      bot_id: string;
      session_id: string;
      pid: number | null;
      started_at: string;
      last_used_at: string;
      hard_expires_at: string;
      state: string;
    }>;
  }

  markAllSideSessionsStopped(): void {
    this.stmts.markAllSideSessionsStopped.run();
  }

  /**
   * Insert an agent-API `ask` turn. Creates a synthetic inbound row + a
   * `turns` row with status='running' (never 'queued' — the ask handler
   * drives the turn directly). Uses BEGIN IMMEDIATE.
   */
  insertAskTurn(args: {
    botId: BotId;
    tokenName: string;
    sessionId: string;
    textPreview: string;
    attachmentPaths: string[];
  }): number {
    return this.transactionImmediate(() => {
      const inboundId = this.allocateSyntheticInbound({
        botId: args.botId,
        chatId: 0,
        fromUserId: `agent_api:${args.tokenName}`,
        payloadJson: JSON.stringify({
          kind: "ask",
          session_id: args.sessionId,
          text_preview: args.textPreview.slice(0, 200),
        }),
      });
      const row = this.stmts.insertAskTurnRow.get(
        args.botId,
        inboundId,
        args.attachmentPaths.length
          ? JSON.stringify(args.attachmentPaths)
          : null,
        args.tokenName,
      ) as { id: number };
      return row.id;
    });
  }

  /**
   * Insert an agent-API `send` turn. Idempotency lookup runs inside the
   * same transaction; if the key was already used, returns the prior turn id
   * with `replay: true` and does not touch `turns`/`inbound_updates`.
   */
  insertSendTurn(args: {
    botId: BotId;
    tokenName: string;
    chatId: number;
    markerWrappedText: string;
    idempotencyKey: string;
    sourceLabel: string;
    attachmentPaths: string[];
  }): { replay: boolean; turnId: number } {
    return this.transactionImmediate(() => {
      const existing = this.stmts.getIdempotencyTurn.get(
        args.botId,
        args.idempotencyKey,
      ) as { turn_id: number } | null;
      if (existing) return { replay: true, turnId: existing.turn_id };

      const inboundId = this.allocateSyntheticInbound({
        botId: args.botId,
        chatId: args.chatId,
        fromUserId: `agent_api:${args.tokenName}`,
        payloadJson: JSON.stringify({
          kind: "send",
          source: args.sourceLabel,
          idempotency_key: args.idempotencyKey,
          prompt: args.markerWrappedText,
        }),
      });

      const turnRow = this.stmts.insertSendTurnRow.get(
        args.botId,
        args.chatId,
        inboundId,
        args.attachmentPaths.length
          ? JSON.stringify(args.attachmentPaths)
          : null,
        args.tokenName,
        args.sourceLabel,
        args.idempotencyKey,
      ) as { id: number };

      this.stmts.insertIdempotency.run(
        args.botId,
        args.idempotencyKey,
        turnRow.id,
      );

      return { replay: false, turnId: turnRow.id };
    });
  }

  setTurnFinalText(
    turnId: number,
    finalText: string,
    usageJson: string | null,
    durationMs: number | null,
  ): void {
    this.stmts.setTurnFinalText.run(finalText, usageJson, durationMs, turnId);
  }

  getTurnExtended(turnId: number): {
    id: number;
    bot_id: string;
    chat_id: number;
    source_update_id: number;
    status: string;
    started_at: string | null;
    completed_at: string | null;
    first_output_at: string | null;
    last_output_at: string | null;
    error_text: string | null;
    source: string | null;
    agent_api_token_name: string | null;
    agent_api_source_label: string | null;
    final_text: string | null;
    idempotency_key: string | null;
    usage_json: string | null;
    duration_ms: number | null;
    inbound_payload_json: string | null;
  } | null {
    return this.stmts.getTurnExtended.get(turnId) as ReturnType<
      GatewayDB["getTurnExtended"]
    >;
  }

  private allocateSyntheticInbound(args: {
    botId: BotId;
    chatId: number;
    fromUserId: string;
    payloadJson: string;
  }): number {
    const row = this.stmts.allocateSyntheticInbound.get({
      $bot_id: args.botId,
      $chat_id: args.chatId,
      $from_user_id: args.fromUserId,
      $payload_json: args.payloadJson,
    }) as { id: number } | null;
    if (!row) {
      throw new Error(
        "allocateSyntheticInbound returned no row — DB in unexpected state",
      );
    }
    return row.id;
  }

  close(): void {
    this._db.close();
    log.info("database closed");
  }
}
