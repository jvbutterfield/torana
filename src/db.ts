import { Database, type Statement } from "bun:sqlite";
import { logger } from "./log.js";
import type { PersonaName } from "./config.js";

const log = logger("db");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS inbound_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona TEXT NOT NULL,
  telegram_update_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  from_user_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'received',
  UNIQUE(persona, telegram_update_id)
);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  source_update_id INTEGER NOT NULL REFERENCES inbound_updates(id),
  status TEXT NOT NULL DEFAULT 'queued',
  attachment_paths_json TEXT,
  started_at TEXT,
  completed_at TEXT,
  worker_generation INTEGER,
  first_output_at TEXT,
  last_output_at TEXT,
  error_text TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  persona TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  telegram_message_id INTEGER,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS worker_state (
  persona TEXT PRIMARY KEY,
  pid INTEGER,
  generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'starting',
  started_at TEXT,
  last_event_at TEXT,
  last_ready_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS stream_state (
  turn_id INTEGER PRIMARY KEY REFERENCES turns(id),
  active_telegram_message_id INTEGER,
  buffer_text TEXT NOT NULL DEFAULT '',
  last_flushed_at TEXT,
  segment_index INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_turns_persona_status ON turns(persona, status);
CREATE INDEX IF NOT EXISTS idx_outbox_status_next ON outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_inbound_persona_status ON inbound_updates(persona, status);
`;

export class GatewayDB {
  private _db: Database;

  // Cached prepared statements
  private stmts!: {
    insertUpdate: Statement;
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
    initStreamState: Statement;
    getStreamState: Statement;
    mailboxDepth: Statement;
    lastTurnAt: Statement;
  };

  constructor(dbPath: string) {
    log.info("opening database", { path: dbPath });
    this._db = new Database(dbPath, { create: true });
    this._db.exec("PRAGMA journal_mode=WAL");
    this._db.exec("PRAGMA synchronous=NORMAL");
    this._db.exec("PRAGMA foreign_keys=ON");
    this._db.exec(SCHEMA_SQL);
    this.prepareStatements();
    log.info("database ready");
  }

  private prepareStatements() {
    const d = this._db;
    this.stmts = {
      insertUpdate: d.prepare(`
        INSERT INTO inbound_updates (persona, telegram_update_id, chat_id, message_id, from_user_id, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (persona, telegram_update_id) DO NOTHING
      `),
      setUpdateStatus: d.prepare("UPDATE inbound_updates SET status = ? WHERE id = ?"),
      createTurn: d.prepare("INSERT INTO turns (persona, chat_id, source_update_id, attachment_paths_json) VALUES (?, ?, ?, ?)"),
      startTurn: d.prepare("UPDATE turns SET status = 'running', started_at = datetime('now'), worker_generation = ? WHERE id = ?"),
      completeTurn: d.prepare("UPDATE turns SET status = ?, completed_at = datetime('now'), error_text = ? WHERE id = ?"),
      interruptTurn: d.prepare("UPDATE turns SET status = 'interrupted', completed_at = datetime('now'), error_text = ? WHERE id = ?"),
      setTurnFirstOutput: d.prepare("UPDATE turns SET first_output_at = COALESCE(first_output_at, datetime('now')), last_output_at = datetime('now') WHERE id = ?"),
      setTurnLastOutput: d.prepare("UPDATE turns SET last_output_at = datetime('now') WHERE id = ?"),
      getRunningTurns: d.prepare("SELECT id, persona, chat_id, source_update_id, first_output_at FROM turns WHERE status = 'running'"),
      getQueuedTurns: d.prepare("SELECT id, chat_id, source_update_id FROM turns WHERE persona = ? AND status = 'queued' ORDER BY id ASC"),
      getTurnText: d.prepare("SELECT payload_json FROM inbound_updates WHERE id = (SELECT source_update_id FROM turns WHERE id = ?)"),
      getTurnAttachments: d.prepare("SELECT attachment_paths_json FROM turns WHERE id = ?"),
      getTurnSourceUpdateId: d.prepare("SELECT source_update_id FROM turns WHERE id = ?"),
      requeueTurn: d.prepare("UPDATE turns SET status = 'queued', started_at = NULL, worker_generation = NULL WHERE id = ?"),
      cancelTurnOutbox: d.prepare("UPDATE outbox SET status = 'failed', last_error = ? WHERE turn_id = ? AND status IN ('pending', 'retrying')"),
      insertOutbox: d.prepare("INSERT INTO outbox (turn_id, persona, chat_id, kind, telegram_message_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)"),
      markOutboxSent: d.prepare("UPDATE outbox SET status = 'sent', telegram_message_id = COALESCE(?, telegram_message_id) WHERE id = ?"),
      markOutboxFailed: d.prepare("UPDATE outbox SET status = 'failed', last_error = ? WHERE id = ?"),
      markOutboxRetryOrFail: d.prepare(`
        UPDATE outbox SET
          status = CASE WHEN attempt_count + 1 >= ? THEN 'failed' ELSE 'retrying' END,
          attempt_count = attempt_count + 1,
          next_attempt_at = CASE WHEN attempt_count + 1 >= ? THEN next_attempt_at ELSE ? END,
          last_error = ?
        WHERE id = ?
      `),
      getPendingOutbox: d.prepare(`
        SELECT id, turn_id, persona, chat_id, kind, telegram_message_id, payload_json, status, attempt_count
        FROM outbox
        WHERE status IN ('pending', 'retrying')
          AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
        ORDER BY id ASC
      `),
      getOutboxRow: d.prepare("SELECT telegram_message_id, status FROM outbox WHERE id = ?"),
      supersededEdit: d.prepare("SELECT id FROM outbox WHERE telegram_message_id = ? AND id > ? AND status = 'sent' LIMIT 1"),
      initWorkerState: d.prepare("INSERT INTO worker_state (persona) VALUES (?) ON CONFLICT (persona) DO UPDATE SET status = 'starting', pid = NULL"),
      getWorkerState: d.prepare("SELECT * FROM worker_state WHERE persona = ?"),
      incWorkerGen: d.prepare("UPDATE worker_state SET generation = generation + 1 WHERE persona = ?"),
      getWorkerGen: d.prepare("SELECT generation FROM worker_state WHERE persona = ?"),
      resetAllWorkers: d.prepare("UPDATE worker_state SET status = 'starting', pid = NULL"),
      initStreamState: d.prepare("INSERT OR REPLACE INTO stream_state (turn_id, active_telegram_message_id, buffer_text, last_flushed_at, segment_index) VALUES (?, NULL, '', NULL, 0)"),
      getStreamState: d.prepare("SELECT * FROM stream_state WHERE turn_id = ?"),
      mailboxDepth: d.prepare("SELECT COUNT(*) as count FROM turns WHERE persona = ? AND status IN ('queued', 'running')"),
      lastTurnAt: d.prepare("SELECT completed_at FROM turns WHERE persona = ? AND status IN ('completed', 'failed') ORDER BY id DESC LIMIT 1"),
    };
  }

  // --- Inbound updates ---

  insertUpdate(persona: PersonaName, telegramUpdateId: number, chatId: number, messageId: number, fromUserId: string, payloadJson: string): number | null {
    const result = this.stmts.insertUpdate.run(persona, telegramUpdateId, chatId, messageId, fromUserId, payloadJson);
    if (result.changes === 0) return null;
    return Number(result.lastInsertRowid);
  }

  setUpdateStatus(id: number, status: string) {
    this.stmts.setUpdateStatus.run(status, id);
  }

  // --- Turns ---

  createTurn(persona: PersonaName, chatId: number, sourceUpdateId: number, attachmentPaths?: string[]): number {
    const result = this.stmts.createTurn.run(persona, chatId, sourceUpdateId, attachmentPaths ? JSON.stringify(attachmentPaths) : null);
    return Number(result.lastInsertRowid);
  }

  startTurn(turnId: number, workerGeneration: number) {
    this.stmts.startTurn.run(workerGeneration, turnId);
  }

  completeTurn(turnId: number, errorText?: string) {
    this.stmts.completeTurn.run(errorText ? "failed" : "completed", errorText ?? null, turnId);
  }

  interruptTurn(turnId: number, reason: string) {
    this.stmts.interruptTurn.run(reason, turnId);
  }

  setTurnFirstOutput(turnId: number) {
    this.stmts.setTurnFirstOutput.run(turnId);
  }

  setTurnLastOutput(turnId: number) {
    this.stmts.setTurnLastOutput.run(turnId);
  }

  getRunningTurns(): Array<{ id: number; persona: PersonaName; chat_id: number; source_update_id: number; first_output_at: string | null }> {
    return this.stmts.getRunningTurns.all() as any;
  }

  getQueuedTurns(persona: PersonaName): Array<{ id: number; chat_id: number; source_update_id: number }> {
    return this.stmts.getQueuedTurns.all(persona) as any;
  }

  getTurnText(turnId: number): string | null {
    const row = this.stmts.getTurnText.get(turnId) as any;
    if (!row) return null;
    const payload = JSON.parse(row.payload_json);
    return payload?.message?.text ?? null;
  }

  getTurnAttachments(turnId: number): string[] {
    const row = this.stmts.getTurnAttachments.get(turnId) as any;
    if (!row?.attachment_paths_json) return [];
    return JSON.parse(row.attachment_paths_json);
  }

  getTurnSourceUpdateId(turnId: number): number | null {
    const row = this.stmts.getTurnSourceUpdateId.get(turnId) as any;
    return row?.source_update_id ?? null;
  }

  requeueTurn(turnId: number) {
    this.stmts.requeueTurn.run(turnId);
  }

  /**
   * Cancel any pending/retrying outbox items for a turn.
   * Called alongside requeueTurn during crash recovery so stale "thinking..."
   * placeholders that were never delivered don't get sent after restart,
   * which would produce a duplicate placeholder alongside the new one that
   * startTurn sends for the re-queued turn.
   */
  cancelPendingOutboxForTurn(turnId: number) {
    this.stmts.cancelTurnOutbox.run("turn re-queued after restart", turnId);
  }

  // --- Outbox ---

  insertOutbox(turnId: number, persona: PersonaName, chatId: number, kind: "send" | "edit", payloadJson: string, telegramMessageId?: number): number {
    const result = this.stmts.insertOutbox.run(turnId, persona, chatId, kind, telegramMessageId ?? null, payloadJson);
    return Number(result.lastInsertRowid);
  }

  markOutboxSent(id: number, telegramMessageId?: number) {
    this.stmts.markOutboxSent.run(telegramMessageId ?? null, id);
  }

  markOutboxFailed(id: number, error: string) {
    this.stmts.markOutboxFailed.run(error, id);
  }

  /** Single UPDATE with CASE — no extra SELECT needed. Caller passes maxAttempts. */
  markOutboxRetrying(id: number, error: string, nextAttemptAt: string, maxAttempts: number) {
    this.stmts.markOutboxRetryOrFail.run(maxAttempts, maxAttempts, nextAttemptAt, error, id);
  }

  getPendingOutbox(): Array<{
    id: number; turn_id: number; persona: PersonaName; chat_id: number;
    kind: string; telegram_message_id: number | null; payload_json: string;
    status: string; attempt_count: number;
  }> {
    return this.stmts.getPendingOutbox.all() as any;
  }

  getOutboxRow(id: number): { telegram_message_id: number | null; status: string } | null {
    return this.stmts.getOutboxRow.get(id) as any;
  }

  hasSupersedingEdit(telegramMessageId: number | null, afterId: number): boolean {
    if (!telegramMessageId) return false;
    return !!this.stmts.supersededEdit.get(telegramMessageId, afterId);
  }

  // --- Worker state ---

  initWorkerState(persona: PersonaName) {
    this.stmts.initWorkerState.run(persona);
  }

  private dynamicUpdate(table: string, whereCol: string, whereVal: string | number, updates: Record<string, string | number | null>) {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(updates)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(whereVal);
    this._db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${whereCol} = ?`).run(...vals);
  }

  updateWorkerState(persona: PersonaName, updates: Partial<{
    pid: number | null; generation: number; status: string; started_at: string;
    last_event_at: string; last_ready_at: string; consecutive_failures: number;
    last_error: string | null;
  }>) {
    this.dynamicUpdate("worker_state", "persona", persona, updates as Record<string, string | number | null>);
  }

  getWorkerState(persona: PersonaName): {
    persona: string; pid: number | null; generation: number; status: string;
    started_at: string | null; last_event_at: string | null; consecutive_failures: number;
    last_error: string | null;
  } | null {
    return this.stmts.getWorkerState.get(persona) as any;
  }

  incrementWorkerGeneration(persona: PersonaName): number {
    this.stmts.incWorkerGen.run(persona);
    const row = this.stmts.getWorkerGen.get(persona) as any;
    return row.generation;
  }

  resetAllWorkerStates() {
    this.stmts.resetAllWorkers.run();
  }

  // --- Stream state ---

  initStreamState(turnId: number) {
    this.stmts.initStreamState.run(turnId);
  }

  getStreamState(turnId: number): {
    turn_id: number; active_telegram_message_id: number | null;
    buffer_text: string; last_flushed_at: string | null; segment_index: number;
  } | null {
    return this.stmts.getStreamState.get(turnId) as any;
  }

  updateStreamState(turnId: number, updates: Partial<{
    active_telegram_message_id: number | null; buffer_text: string;
    last_flushed_at: string; segment_index: number;
  }>) {
    this.dynamicUpdate("stream_state", "turn_id", turnId, updates as Record<string, string | number | null>);
  }

  // --- Metrics ---

  getMailboxDepth(persona: PersonaName): number {
    const row = this.stmts.mailboxDepth.get(persona) as any;
    return row.count;
  }

  getLastTurnAt(persona: PersonaName): string | null {
    const row = this.stmts.lastTurnAt.get(persona) as any;
    return row?.completed_at ?? null;
  }

  close() {
    this._db.close();
    log.info("database closed");
  }
}
