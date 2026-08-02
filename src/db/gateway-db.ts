import { Database, type Statement } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { logger } from "../log.js";
import type { BotId } from "../config/schema.js";
import type { NormalizedConfigModel } from "../config/v2.js";
import type {
  ConversationRef,
  InboundEvent,
  OutboundOperation,
} from "../platform/types.js";
import { createHash } from "node:crypto";
import { runnerSessionId } from "../conversation/session-key.js";

const log = logger("db");

export interface ConversationSessionRow {
  session_key: string;
  agent_id: string;
  runner_session_id: string;
  runner_type: string;
  provider_state_json: string | null;
  generation: number;
  state: string;
  started_at: string | null;
  last_used_at: string | null;
  hard_expires_at: string | null;
  context_expires_at: string | null;
  last_error: string | null;
}

export interface BuzzCursorPoint {
  created_at: number;
  event_id: string;
}

export interface BuzzCursorState {
  version: 1;
  subscriptions: Record<string, BuzzCursorPoint>;
  channels?: string[];
}

export type EndpointLifecycleState = "active" | "draining" | "disabled";

/**
 * Lock down the DB file + its WAL / SHM siblings to 0600 (owner rw, nobody
 * else). The DB contains every bot token (stored verbatim so we can call
 * the Telegram API), every inbound Telegram payload (message text, user
 * metadata, PII), every agent-API turn row (marker-wrapped prompts
 * including text callers assumed stayed internal), and idempotency keys.
 * Most of that is either a live credential or caller-controlled content we
 * treated as sensitive at ingest time; leaving it world-readable on a
 * multi-user host is the wrong default.
 *
 * Best-effort: chmod can fail on filesystems that don't support POSIX
 * permissions (Windows NTFS, some FUSE mounts, network shares). Log and
 * carry on; the operator can re-run `torana doctor` which also warns on
 * overly-permissive DB files.
 */
function chmodDbFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    try {
      if (existsSync(p)) chmodSync(p, 0o600);
    } catch (err) {
      log.warn("could not chmod db file to 0600", {
        path: p,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Schema-v5 wrapper. Legacy bot/Telegram columns are dual-written for rollback. */
export class GatewayDB {
  private _db: Database;
  private normalizedSchema: boolean;
  private endpointByAgentPlatform = new Map<string, string>();
  private sessionScopeByAgent = new Map<string, string>();
  private sessionScopeOverrides = new Map<string, string>();
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
    markOutboxInFlight: Statement;
    markOutboxSent: Statement;
    markOutboxFailed: Statement;
    markOutboxRetryOrFail: Statement;
    markOutboxRateLimited: Statement;
    getPendingOutbox: Statement;
    getInFlightOutbox: Statement;
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
    getUserIdForChat: Statement;
    listUserChatsByBot: Statement;
    listTurnAttachmentRows: Statement;
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
    this.normalizedSchema = !!this._db
      .query(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='endpoints'",
      )
      .get();
    if (this.normalizedSchema) {
      const mode = this._db.query("PRAGMA auto_vacuum").get() as {
        auto_vacuum: number;
      };
      if (mode.auto_vacuum !== 2) {
        this._db.close();
        throw new Error(
          "schema v5 requires incremental auto-vacuum; rerun the schema-v5 migration maintenance step",
        );
      }
    }
    // Run AFTER the WAL pragma has forced the -wal/-shm sidecars into
    // existence so we lock them all down in one pass. Owner rw / group-
    // world no-access (0600).
    chmodDbFiles(dbPath);
    this.prepareStatements();
    log.info("database ready");
  }

  /** Raw SQL exec — used by tests to seed fixtures. */
  exec(sql: string): void {
    this._db.exec(sql);
  }

  /**
   * Raw `prepare()` escape hatch. Tests use it to assert DB state and to
   * backdate timestamps that no production helper would expose. Never call
   * this from production code — add a typed helper above instead. The
   * leading underscore + "unsafe" prefix is the warning at every call site:
   * the SQL is unparameterized at the API boundary, so any caller that
   * interpolates user-controlled data here introduces SQL injection.
   */
  _unsafeQuery(sql: string): Statement {
    return this._db.prepare(sql);
  }

  private prepareStatements(): void {
    const d = this._db;
    const v5 = this.normalizedSchema;
    this.stmts = {
      insertUpdate: d.prepare(
        v5
          ? `
        INSERT INTO inbound_updates (bot_id, agent_id, telegram_update_id, chat_id, message_id, from_user_id, payload_json, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (bot_id, telegram_update_id) DO NOTHING
      `
          : `
        INSERT INTO inbound_updates (bot_id, telegram_update_id, chat_id, message_id, from_user_id, payload_json, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (bot_id, telegram_update_id) DO NOTHING
      `,
      ),
      getUpdateStatus: d.prepare(
        "SELECT id, status FROM inbound_updates WHERE bot_id = ? AND telegram_update_id = ?",
      ),
      setUpdateStatus: d.prepare(
        "UPDATE inbound_updates SET status = ? WHERE id = ?",
      ),
      createTurn: d.prepare(
        v5
          ? `
        INSERT INTO turns
          (bot_id, agent_id, chat_id, source_update_id, attachment_paths_json,
           conversation_id, session_key, source_platform, source_event_id,
           prompt_text, prompt_markdown, prompt_revision_seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
          : "INSERT INTO turns (bot_id, chat_id, source_update_id, attachment_paths_json) VALUES (?, ?, ?, ?)",
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
        "SELECT id, bot_id, chat_id, source_update_id, first_output_at, source FROM turns WHERE status = 'running'",
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
        v5
          ? `
        INSERT INTO outbox
          (turn_id, bot_id, agent_id, chat_id, kind, telegram_message_id,
           payload_json, endpoint_id, platform, conversation_id,
           operation_kind, external_message_id, signed_payload_json,
           signed_event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
          : "INSERT INTO outbox (turn_id, bot_id, chat_id, kind, telegram_message_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
      ),
      // Mark a row as currently being delivered. Sets a future
      // next_attempt_at so a concurrent processor (or a crash-affected
      // restart) doesn't pick the row up again until the grace window
      // expires — at which point the row auto-recovers via getPendingOutbox.
      markOutboxInFlight: d.prepare(
        "UPDATE outbox SET status = 'in_flight', next_attempt_at = datetime('now', '+' || ? || ' seconds') WHERE id = ? AND status IN ('pending', 'retrying')",
      ),
      markOutboxSent: d.prepare(
        v5
          ? "UPDATE outbox SET status = 'sent', telegram_message_id = COALESCE(?, telegram_message_id), external_message_id = COALESCE(CAST(? AS TEXT), external_message_id) WHERE id = ?"
          : "UPDATE outbox SET status = 'sent', telegram_message_id = COALESCE(?, telegram_message_id) WHERE id = ?",
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
      // Used when Telegram returned 429 with Retry-After. Schedules the
      // retry at the server-asked time but does NOT bump attempt_count —
      // a cooperative attacker who keeps a chat throttled longer than
      // (max_attempts × backoff_cap) would otherwise dead-letter
      // legitimate replies, and the operator alert would fire on a
      // permanent failure that wasn't actually torana's fault.
      markOutboxRateLimited: d.prepare(`
        UPDATE outbox SET
          status = 'retrying',
          next_attempt_at = ?,
          last_error = ?
        WHERE id = ?
      `),
      // 'in_flight' is included so a crash-affected row auto-recovers once
      // its grace-window next_attempt_at expires. Same-process re-entry is
      // already prevented by the OutboxProcessor.processing mutex; this
      // filter handles the cross-restart case.
      getPendingOutbox: d.prepare(
        v5
          ? `
        SELECT o.id, o.turn_id, o.bot_id, o.agent_id, o.chat_id, o.kind,
               o.telegram_message_id, o.payload_json, o.status, o.attempt_count,
               o.endpoint_id, o.platform, o.conversation_id, o.operation_kind,
               o.external_message_id, o.signed_payload_json, o.signed_event_id,
               c.community_id, c.external_conversation_id,
               c.thread_root_id, c.workflow_run_id, c.conversation_type
        FROM outbox o
        JOIN conversations c ON c.id = o.conversation_id
        WHERE o.status IN ('pending', 'retrying', 'in_flight')
          AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= datetime('now'))
        ORDER BY o.id ASC
      `
          : `
        SELECT id, turn_id, bot_id, bot_id AS agent_id, chat_id, kind,
               telegram_message_id, payload_json, status, attempt_count,
               bot_id || '-telegram' AS endpoint_id,
               'telegram' AS platform,
               NULL AS conversation_id,
               kind AS operation_kind,
               CAST(telegram_message_id AS TEXT) AS external_message_id,
               NULL AS signed_payload_json, NULL AS signed_event_id,
               NULL AS community_id,
               CAST(chat_id AS TEXT) AS external_conversation_id,
               NULL AS thread_root_id,
               NULL AS workflow_run_id,
               'direct' AS conversation_type
        FROM outbox
        WHERE status IN ('pending', 'retrying', 'in_flight')
          AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
        ORDER BY id ASC
      `,
      ),
      // Used at startup for operator-visible warnings about crash-affected
      // rows. Returns rows still labelled 'in_flight' regardless of grace.
      getInFlightOutbox: d.prepare(
        v5
          ? `
        SELECT id, turn_id, bot_id, agent_id, chat_id, kind, operation_kind,
               attempt_count, next_attempt_at
        FROM outbox
        WHERE status = 'in_flight'
        ORDER BY id ASC
      `
          : `
        SELECT id, turn_id, bot_id, bot_id AS agent_id, chat_id, kind,
               kind AS operation_kind, attempt_count, next_attempt_at
        FROM outbox
        WHERE status = 'in_flight'
        ORDER BY id ASC
      `,
      ),
      getOutboxRow: d.prepare(
        "SELECT telegram_message_id, status FROM outbox WHERE id = ?",
      ),
      supersededEdit: d.prepare(
        "SELECT id FROM outbox WHERE telegram_message_id = ? AND id > ? AND status = 'sent' LIMIT 1",
      ),
      initWorkerState: d.prepare(
        v5
          ? "INSERT INTO worker_state (bot_id, agent_id) VALUES (?, ?) ON CONFLICT (bot_id) DO UPDATE SET agent_id=excluded.agent_id, status = 'starting', pid = NULL"
          : "INSERT INTO worker_state (bot_id) VALUES (?) ON CONFLICT (bot_id) DO UPDATE SET status = 'starting', pid = NULL",
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
        v5
          ? "INSERT INTO bot_state (bot_id, agent_id) VALUES (?, ?) ON CONFLICT (bot_id) DO UPDATE SET agent_id=excluded.agent_id"
          : "INSERT INTO bot_state (bot_id) VALUES (?) ON CONFLICT (bot_id) DO NOTHING",
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

      allocateSyntheticInbound: d.prepare(
        v5
          ? `
        INSERT INTO inbound_updates (bot_id, agent_id, telegram_update_id, chat_id, message_id, from_user_id, payload_json, status)
        SELECT
          $bot_id,
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
      `
          : `
        INSERT INTO inbound_updates (bot_id, telegram_update_id, chat_id, message_id, from_user_id, payload_json, status)
        SELECT $bot_id, COALESCE(MIN(telegram_update_id), 0) - 1, $chat_id, 0,
               $from_user_id, $payload_json, 'enqueued'
        FROM inbound_updates WHERE bot_id=$bot_id AND telegram_update_id < 0
        RETURNING id
      `,
      ),

      upsertUserChat: d.prepare(
        v5
          ? `
        INSERT INTO user_chats (bot_id, agent_id, telegram_user_id, chat_id, last_inbound_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT (bot_id, telegram_user_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          chat_id = excluded.chat_id,
          last_inbound_at = excluded.last_inbound_at
      `
          : `
        INSERT INTO user_chats (bot_id, telegram_user_id, chat_id, last_inbound_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT (bot_id, telegram_user_id) DO UPDATE SET
          chat_id=excluded.chat_id, last_inbound_at=excluded.last_inbound_at
      `,
      ),
      getLastChatForUser: d.prepare(
        "SELECT chat_id FROM user_chats WHERE bot_id = ? AND telegram_user_id = ?",
      ),
      getUserIdForChat: d.prepare(
        "SELECT telegram_user_id FROM user_chats WHERE bot_id = ? AND chat_id = ? LIMIT 1",
      ),
      listUserChatsByBot: d.prepare(
        "SELECT chat_id FROM user_chats WHERE bot_id = ?",
      ),
      listTurnAttachmentRows: d.prepare(
        "SELECT attachment_paths_json FROM turns WHERE attachment_paths_json IS NOT NULL",
      ),

      getIdempotencyTurn: d.prepare(
        "SELECT turn_id FROM agent_api_idempotency WHERE bot_id = ? AND idempotency_key = ?",
      ),
      insertIdempotency: d.prepare(
        v5
          ? "INSERT INTO agent_api_idempotency (bot_id, agent_id, idempotency_key, turn_id) VALUES (?, ?, ?, ?)"
          : "INSERT INTO agent_api_idempotency (bot_id, idempotency_key, turn_id) VALUES (?, ?, ?)",
      ),
      sweepIdempotency: d.prepare(
        "DELETE FROM agent_api_idempotency WHERE CAST(strftime('%s', created_at) AS INTEGER) * 1000 < ?",
      ),

      upsertSideSession: d.prepare(
        v5
          ? `
        INSERT INTO side_sessions (bot_id, agent_id, session_id, pid, started_at, last_used_at, hard_expires_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (bot_id, session_id) DO UPDATE SET
          pid = excluded.pid,
          last_used_at = excluded.last_used_at,
          hard_expires_at = excluded.hard_expires_at,
          state = excluded.state
      `
          : `
        INSERT INTO side_sessions (bot_id, session_id, pid, started_at, last_used_at, hard_expires_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (bot_id, session_id) DO UPDATE SET
          pid=excluded.pid, last_used_at=excluded.last_used_at,
          hard_expires_at=excluded.hard_expires_at, state=excluded.state
      `,
      ),
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

      insertAskTurnRow: d.prepare(
        v5
          ? `
        INSERT INTO turns
          (bot_id, agent_id, chat_id, source_update_id, status, started_at,
           attachment_paths_json, source, agent_api_token_name,
           conversation_id, session_key, source_platform, source_event_id,
           prompt_text, prompt_markdown, prompt_revision_seq)
        SELECT ?, ?, 0, ?, 'running', datetime('now'), ?, 'agent_api_ask', ?,
               ie.conversation_id, c.session_key, 'agent_api', ie.id, NULL, 0,
               ie.received_seq
        FROM inbound_updates iu
        JOIN inbound_events ie ON ie.endpoint_id = iu.bot_id || '-agent-api'
          AND ie.external_event_id = 'agentapi:' || CAST(ABS(iu.telegram_update_id) AS TEXT)
        JOIN conversations c ON c.id = ie.conversation_id
        WHERE iu.id = ?
        RETURNING id
      `
          : `
        INSERT INTO turns (bot_id, chat_id, source_update_id, status, started_at,
                           attachment_paths_json, source, agent_api_token_name)
        VALUES (?, 0, ?, 'running', datetime('now'), ?, 'agent_api_ask', ?)
        RETURNING id
      `,
      ),
      insertSendTurnRow: d.prepare(
        v5
          ? `
        INSERT INTO turns
          (bot_id, agent_id, chat_id, source_update_id, status,
           attachment_paths_json, source, agent_api_token_name,
           agent_api_source_label, idempotency_key, conversation_id,
           session_key, source_platform, source_event_id, prompt_text,
           prompt_markdown, prompt_revision_seq)
        SELECT ?, ?, ?, ?, 'queued', ?, 'agent_api_send', ?, ?, ?,
               ie.conversation_id, c.session_key, 'agent_api', ie.id, ?, 0,
               ie.received_seq
        FROM inbound_updates iu
        JOIN inbound_events ie ON ie.endpoint_id = iu.bot_id || '-agent-api'
          AND ie.external_event_id = 'agentapi:' || CAST(ABS(iu.telegram_update_id) AS TEXT)
        JOIN conversations c ON c.id = ie.conversation_id
        WHERE iu.id = ?
        RETURNING id
      `
          : `
        INSERT INTO turns (bot_id, chat_id, source_update_id, status,
                           attachment_paths_json, source, agent_api_token_name,
                           agent_api_source_label, idempotency_key)
        VALUES (?, ?, ?, 'queued', ?, 'agent_api_send', ?, ?, ?)
        RETURNING id
      `,
      ),
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

  /** Persist configured endpoints before intake; safe to call on every boot. */
  syncNormalizedConfig(model: NormalizedConfigModel): void {
    if (!this.normalizedSchema) return;
    this.sessionScopeOverrides.clear();
    const upsert = this._db.prepare(`
      INSERT INTO endpoints
        (endpoint_id, agent_id, platform, external_identity, lifecycle_state,
         state_reason)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint_id) DO UPDATE SET
        agent_id=excluded.agent_id,
        platform=excluded.platform,
        external_identity=excluded.external_identity,
        lifecycle_state=CASE
          WHEN excluded.lifecycle_state='disabled' THEN 'disabled'
          WHEN endpoints.lifecycle_state='disabled'
               AND endpoints.state_reason='config_disabled' THEN 'active'
          ELSE endpoints.lifecycle_state
        END,
        state_reason=CASE
          WHEN excluded.lifecycle_state='disabled' THEN 'config_disabled'
          WHEN endpoints.lifecycle_state='disabled'
               AND endpoints.state_reason='config_disabled' THEN NULL
          ELSE endpoints.state_reason
        END,
        updated_at=datetime('now')
    `);
    this.transaction(() => {
      for (const endpoint of model.endpoints) {
        upsert.run(
          endpoint.id,
          endpoint.agentId,
          endpoint.platform,
          endpoint.externalIdentity,
          endpoint.enabled ? "active" : "disabled",
          endpoint.enabled ? null : "config_disabled",
        );
        this.endpointByAgentPlatform.set(
          `${endpoint.agentId}:${endpoint.platform}`,
          endpoint.id,
        );
        this.sessionScopeByAgent.set(
          endpoint.agentId,
          model.sourceVersion === 1 ? "legacy_agent" : model.sessions.scope,
        );
        for (const [externalId, scope] of Object.entries(
          endpoint.sessionScopes ?? {},
        )) {
          this.sessionScopeOverrides.set(
            `${endpoint.id}\u0000${externalId}`,
            scope,
          );
        }
      }
    });
  }

  getEndpointId(agentId: string, platform: string): string {
    if (!this.normalizedSchema) {
      return `${agentId}-${platform === "agent_api" ? "agent-api" : platform}`;
    }
    const key = `${agentId}:${platform}`;
    const configured = this.endpointByAgentPlatform.get(key);
    if (configured) return configured;
    const row = this._db
      .query(
        "SELECT endpoint_id FROM endpoints WHERE agent_id=? AND platform=? ORDER BY endpoint_id LIMIT 1",
      )
      .get(agentId, platform) as { endpoint_id: string } | null;
    if (row) {
      this.endpointByAgentPlatform.set(key, row.endpoint_id);
      return row.endpoint_id;
    }
    const fallback = `${agentId}-${platform === "agent_api" ? "agent-api" : platform}`;
    this._db
      .prepare(
        "INSERT OR IGNORE INTO endpoints (endpoint_id, agent_id, platform) VALUES (?, ?, ?)",
      )
      .run(fallback, agentId, platform);
    this.endpointByAgentPlatform.set(key, fallback);
    return fallback;
  }

  resolveConversation(
    agentId: string,
    conversation: ConversationRef,
    senderId: string | null = null,
  ): { id: number; sessionKey: string | null } {
    const threadRoot = conversation.threadRootId ?? "";
    const workflowRun = conversation.workflowRunId ?? "";
    const existing = this._db
      .query(
        `
        SELECT id, session_key FROM conversations
        WHERE endpoint_id=? AND external_conversation_id=?
          AND thread_root_id=? AND workflow_run_id=?
      `,
      )
      .get(
        conversation.endpointId,
        conversation.channelId,
        threadRoot,
        workflowRun,
      ) as { id: number; session_key: string | null } | null;
    if (existing) return { id: existing.id, sessionKey: existing.session_key };

    const configuredPolicy =
      this.sessionScopeOverrides.get(
        `${conversation.endpointId}\u0000${conversation.channelId}`,
      ) ??
      this.sessionScopeByAgent.get(agentId) ??
      "legacy_agent";
    const policy =
      configuredPolicy === "channel" ? "conversation" : configuredPolicy;
    const keyMaterial = [
      conversation.platform,
      conversation.communityId ?? "",
      conversation.endpointId,
      conversation.channelId,
      threadRoot,
      workflowRun,
    ].join("\u001f");
    const conversationKey = createHash("sha256")
      .update(keyMaterial)
      .digest("hex");
    const sessionMaterial = [
      conversation.platform,
      conversation.communityId ?? "",
      conversation.endpointId,
      conversation.channelId,
      policy === "thread" ? threadRoot : "",
      workflowRun,
    ].join("\u001f");
    const scopedSessionHash = createHash("sha256")
      .update(sessionMaterial)
      .digest("hex");
    const sessionKey =
      policy === "ephemeral"
        ? null
        : policy === "legacy_agent"
          ? `legacy-agent:${agentId}`
          : policy.startsWith("alias:")
            ? `alias:${agentId}:${policy.slice(6)}`
            : `conversation:${scopedSessionHash}`;
    if (sessionKey) {
      this._db
        .prepare(
          `
          INSERT OR IGNORE INTO conversation_sessions
            (session_key, agent_id, runner_session_id, runner_type, state)
          VALUES (?, ?, ?, 'pending', 'stopped')
        `,
        )
        .run(sessionKey, agentId, runnerSessionId(sessionKey));
    }
    this._db
      .prepare(
        `
        INSERT INTO conversations
          (agent_id, endpoint_id, platform, community_id,
           external_conversation_id, thread_root_id, workflow_run_id,
           conversation_type, conversation_key, session_policy, session_key,
           last_sender_id, last_inbound_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(endpoint_id, external_conversation_id, thread_root_id, workflow_run_id)
        DO UPDATE SET last_sender_id=COALESCE(excluded.last_sender_id, last_sender_id),
                      last_inbound_at=datetime('now')
      `,
      )
      .run(
        agentId,
        conversation.endpointId,
        conversation.platform,
        conversation.communityId,
        conversation.channelId,
        threadRoot,
        workflowRun,
        conversation.type,
        conversationKey,
        policy,
        sessionKey,
        senderId,
      );
    const row = this._db
      .query(
        `
        SELECT id, session_key FROM conversations
        WHERE endpoint_id=? AND external_conversation_id=?
          AND thread_root_id=? AND workflow_run_id=?
      `,
      )
      .get(
        conversation.endpointId,
        conversation.channelId,
        threadRoot,
        workflowRun,
      ) as { id: number; session_key: string | null };
    return { id: row.id, sessionKey: row.session_key };
  }

  getInboundEventStatus(
    endpointId: string,
    externalEventId: string,
  ): { id: number; status: string } | null {
    return this._db
      .query(
        "SELECT id, status FROM inbound_events WHERE endpoint_id=? AND external_event_id=?",
      )
      .get(endpointId, externalEventId) as {
      id: number;
      status: string;
    } | null;
  }

  getEndpointState(endpointId: string): {
    endpointId: string;
    agentId: string;
    platform: string;
    externalIdentity: string | null;
    lifecycleState: EndpointLifecycleState;
    stateReason: string | null;
    cursor: BuzzCursorState;
  } | null {
    if (!this.normalizedSchema) return null;
    const row = this._db
      .query(
        `SELECT endpoint_id, agent_id, platform, external_identity,
                lifecycle_state, state_reason, cursor_json
         FROM endpoints WHERE endpoint_id=?`,
      )
      .get(endpointId) as {
      endpoint_id: string;
      agent_id: string;
      platform: string;
      external_identity: string | null;
      lifecycle_state: EndpointLifecycleState;
      state_reason: string | null;
      cursor_json: string | null;
    } | null;
    if (!row) return null;
    return {
      endpointId: row.endpoint_id,
      agentId: row.agent_id,
      platform: row.platform,
      externalIdentity: row.external_identity,
      lifecycleState: row.lifecycle_state,
      stateReason: row.state_reason,
      cursor: parseBuzzCursor(row.cursor_json),
    };
  }

  listExternalEndpoints(): Array<{
    endpointId: string;
    agentId: string;
    platform: string;
    lifecycleState: EndpointLifecycleState;
    stateReason: string | null;
    externalIdentity: string | null;
  }> {
    if (!this.normalizedSchema) return [];
    const rows = this._db
      .query(
        `SELECT endpoint_id, agent_id, platform, lifecycle_state,
                state_reason, external_identity
         FROM endpoints WHERE platform != 'agent_api' ORDER BY endpoint_id`,
      )
      .all() as Array<{
      endpoint_id: string;
      agent_id: string;
      platform: string;
      lifecycle_state: EndpointLifecycleState;
      state_reason: string | null;
      external_identity: string | null;
    }>;
    return rows.map((row) => ({
      endpointId: row.endpoint_id,
      agentId: row.agent_id,
      platform: row.platform,
      lifecycleState: row.lifecycle_state,
      stateReason: row.state_reason,
      externalIdentity: row.external_identity,
    }));
  }

  setEndpointLifecycle(
    endpointId: string,
    state: EndpointLifecycleState,
    reason: string | null,
  ): boolean {
    if (!this.normalizedSchema) return false;
    const result = this._db
      .prepare(
        `UPDATE endpoints SET lifecycle_state=?, state_reason=?,
              updated_at=datetime('now') WHERE endpoint_id=?`,
      )
      .run(state, reason, endpointId);
    return result.changes === 1;
  }

  endpointBacklog(endpointId: string): {
    queued: number;
    running: number;
    outbox: number;
  } {
    if (!this.normalizedSchema) return { queued: 0, running: 0, outbox: 0 };
    const turns = this._db
      .query(
        `SELECT
           SUM(CASE WHEN t.status='queued' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN t.status='running' THEN 1 ELSE 0 END) AS running
         FROM turns t JOIN conversations c ON c.id=t.conversation_id
         WHERE c.endpoint_id=? AND t.status IN ('queued','running')`,
      )
      .get(endpointId) as { queued: number | null; running: number | null };
    const outbox = this._db
      .query(
        `SELECT COUNT(*) AS count FROM outbox WHERE endpoint_id=?
         AND status IN ('pending','retrying','in_flight')`,
      )
      .get(endpointId) as { count: number };
    return {
      queued: Number(turns.queued ?? 0),
      running: Number(turns.running ?? 0),
      outbox: Number(outbox.count),
    };
  }

  deadLetterEndpointPending(endpointId: string, reason: string): void {
    if (!this.normalizedSchema) return;
    this.transactionImmediate(() => {
      this._db
        .prepare(
          `UPDATE turns SET status='dead', completed_at=datetime('now'),
                  error_text=?
           WHERE status='queued' AND conversation_id IN
             (SELECT id FROM conversations WHERE endpoint_id=?)`,
        )
        .run(reason, endpointId);
      this._db
        .prepare(
          `UPDATE inbound_events SET status='dead', status_reason=?
           WHERE id IN (SELECT source_event_id FROM turns
             WHERE status='dead' AND conversation_id IN
               (SELECT id FROM conversations WHERE endpoint_id=?))`,
        )
        .run(reason, endpointId);
      this._db
        .prepare(
          `UPDATE outbox SET status='dead', last_error=? WHERE endpoint_id=?
           AND status IN ('pending','retrying','in_flight')`,
        )
        .run(reason, endpointId);
    });
  }

  setBuzzChannels(endpointId: string, channels: readonly string[]): void {
    if (!this.normalizedSchema) return;
    const state = this.getEndpointState(endpointId);
    if (!state) throw new Error(`unknown endpoint '${endpointId}'`);
    const cursor: BuzzCursorState = {
      ...state.cursor,
      channels: [...new Set(channels)].sort(),
    };
    this._db
      .prepare(
        "UPDATE endpoints SET cursor_json=?, updated_at=datetime('now') WHERE endpoint_id=?",
      )
      .run(JSON.stringify(cursor), endpointId);
  }

  checkpointBuzzCursor(
    endpointId: string,
    scope: string,
    createdAt: number,
    eventId: string,
  ): boolean {
    if (!this.normalizedSchema) return false;
    return this.transactionImmediate(() => {
      const row = this._db
        .query("SELECT lifecycle_state FROM endpoints WHERE endpoint_id=?")
        .get(endpointId) as { lifecycle_state: EndpointLifecycleState } | null;
      if (row?.lifecycle_state !== "active") return false;
      this.advanceBuzzCursor(endpointId, scope, createdAt, eventId);
      return true;
    });
  }

  archiveEndpointChannel(endpointId: string, channelId: string): void {
    if (!this.normalizedSchema) return;
    this._db
      .prepare(
        `UPDATE conversations SET archived=1
         WHERE endpoint_id=? AND external_conversation_id=?`,
      )
      .run(endpointId, channelId);
  }

  recordBuzzInbound(args: {
    event: InboundEvent;
    status: "received" | "control" | "rejected";
    statusReason?: string | null;
    cursorScope: string;
  }):
    | { kind: "inserted"; id: number; receivedSeq: number }
    | { kind: "duplicate"; id: number; status: string } {
    if (!this.normalizedSchema)
      throw new Error("Buzz intake requires normalized schema v5");
    return this.transactionImmediate(() => {
      const existing = this.getInboundEventStatus(
        args.event.endpointId,
        args.event.externalEventId,
      );
      if (existing)
        return { kind: "duplicate", id: existing.id, status: existing.status };

      const conversation = args.event.conversation
        ? this.resolveConversation(
            args.event.agentId,
            args.event.conversation,
            args.event.sender.id,
          )
        : null;
      const seq = this._db
        .query(
          `UPDATE endpoints
           SET next_received_seq=next_received_seq+1,
               updated_at=datetime('now')
           WHERE endpoint_id=? AND lifecycle_state='active'
           RETURNING next_received_seq`,
        )
        .get(args.event.endpointId) as { next_received_seq: number } | null;
      if (!seq) throw new Error("endpoint_not_active");
      const payloadJson = JSON.stringify(args.event.raw);
      const result = this._db
        .prepare(
          `INSERT INTO inbound_events
            (endpoint_id, platform, external_event_id, external_message_id,
             target_external_event_id, workflow_run_id, conversation_id,
             sender_id, event_kind, reply_to_external_id, payload_json,
             payload_sha256, received_seq, status, status_reason)
           VALUES (?, 'buzz', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.event.endpointId,
          args.event.externalEventId,
          args.event.externalMessageId,
          args.event.targetExternalEventId,
          args.event.workflowRunId,
          conversation?.id ?? null,
          args.event.sender.id,
          args.event.kind,
          args.event.replyTo,
          payloadJson,
          createHash("sha256").update(payloadJson).digest("hex"),
          seq.next_received_seq,
          args.status,
          args.statusReason ?? null,
        );
      this.advanceBuzzCursor(
        args.event.endpointId,
        args.cursorScope,
        args.event.occurredAt,
        args.event.externalEventId,
      );
      return {
        kind: "inserted",
        id: Number(result.lastInsertRowid),
        receivedSeq: seq.next_received_seq,
      };
    });
  }

  applyBuzzControlEvent(args: {
    inboundEventId: number;
    rerunOnEdit: boolean;
    includeReactionsInContext: boolean;
    pendingMutationDays: number;
  }): "applied" | "pending" | "ignored" {
    if (!this.normalizedSchema) return "ignored";
    return this.transactionImmediate(() => {
      const mutation = this.getBuzzMutation(args.inboundEventId);
      if (!mutation) return "ignored";
      if (mutation.event_kind === "reaction") {
        this._db
          .prepare("UPDATE inbound_events SET status_reason=? WHERE id=?")
          .run(
            args.includeReactionsInContext
              ? "reaction_session_event"
              : "reaction_ignored_by_configuration",
            args.inboundEventId,
          );
        return "applied";
      }
      if (!mutation.target_external_event_id) return "ignored";
      const target = this._db
        .query(
          `SELECT id, received_seq FROM inbound_events
           WHERE endpoint_id=? AND external_event_id=?`,
        )
        .get(mutation.endpoint_id, mutation.target_external_event_id) as {
        id: number;
        received_seq: number;
      } | null;
      if (!target) {
        this._db
          .prepare(
            `INSERT OR IGNORE INTO pending_event_mutations
              (endpoint_id, target_external_event_id, mutation_event_id,
               mutation_kind, received_seq, expires_at)
             VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
          )
          .run(
            mutation.endpoint_id,
            mutation.target_external_event_id,
            args.inboundEventId,
            mutation.event_kind,
            mutation.received_seq,
            `+${args.pendingMutationDays} days`,
          );
        return "pending";
      }
      return this.applyBuzzMutationToTarget(mutation, target, args.rerunOnEdit);
    });
  }

  private getBuzzMutation(inboundEventId: number): {
    id: number;
    endpoint_id: string;
    target_external_event_id: string | null;
    event_kind: string;
    received_seq: number;
    payload_json: string | null;
  } | null {
    return this._db
      .query(
        `SELECT id, endpoint_id, target_external_event_id, event_kind,
                received_seq, payload_json
         FROM inbound_events WHERE id=? AND platform='buzz'`,
      )
      .get(inboundEventId) as ReturnType<GatewayDB["getBuzzMutation"]>;
  }

  private applyPendingBuzzMutations(
    endpointId: string,
    targetExternalEventId: string,
    rerunOnEdit: boolean,
  ): void {
    const target = this._db
      .query(
        `SELECT id, received_seq FROM inbound_events
         WHERE endpoint_id=? AND external_event_id=?`,
      )
      .get(endpointId, targetExternalEventId) as {
      id: number;
      received_seq: number;
    } | null;
    if (!target) return;
    const pending = this._db
      .query(
        `SELECT mutation_event_id FROM pending_event_mutations
         WHERE endpoint_id=? AND target_external_event_id=?
         ORDER BY received_seq, id`,
      )
      .all(endpointId, targetExternalEventId) as Array<{
      mutation_event_id: number;
    }>;
    for (const row of pending) {
      const mutation = this.getBuzzMutation(row.mutation_event_id);
      if (mutation) {
        this.applyBuzzMutationToTarget(mutation, target, rerunOnEdit, true);
      }
      this._db
        .prepare(
          "DELETE FROM pending_event_mutations WHERE mutation_event_id=?",
        )
        .run(row.mutation_event_id);
    }
  }

  private applyBuzzMutationToTarget(
    mutation: NonNullable<ReturnType<GatewayDB["getBuzzMutation"]>>,
    target: { id: number; received_seq: number },
    rerunOnEdit: boolean,
    bufferedBeforeTarget = false,
  ): "applied" | "ignored" {
    if (!bufferedBeforeTarget && mutation.received_seq <= target.received_seq) {
      this._db
        .prepare(
          "UPDATE inbound_events SET status_reason='stale_mutation' WHERE id=?",
        )
        .run(mutation.id);
      return "ignored";
    }
    const turn = this._db
      .query(
        `SELECT id, status, agent_id, conversation_id, session_key,
                prompt_markdown
         FROM turns WHERE source_event_id=? ORDER BY id LIMIT 1`,
      )
      .get(target.id) as {
      id: number;
      status: string;
      agent_id: string;
      conversation_id: number;
      session_key: string | null;
      prompt_markdown: number;
    } | null;

    if (mutation.event_kind === "message_delete") {
      if (turn?.status === "queued") {
        this._db
          .prepare(
            `UPDATE turns SET status='dead', completed_at=datetime('now'),
                    error_text='source message deleted'
             WHERE id=? AND status='queued'`,
          )
          .run(turn.id);
      }
      this._db
        .prepare(
          "UPDATE inbound_events SET status='dead', status_reason=? WHERE id=?",
        )
        .run(`deleted_by:${mutation.id}`, target.id);
      this._db
        .prepare(
          "UPDATE inbound_events SET status_reason='delete_applied' WHERE id=?",
        )
        .run(mutation.id);
      return "applied";
    }

    if (mutation.event_kind !== "message_edit") return "ignored";
    let content = "";
    try {
      const payload = JSON.parse(mutation.payload_json ?? "null") as {
        content?: unknown;
      } | null;
      if (typeof payload?.content === "string") content = payload.content;
    } catch {
      // An invalid payload was already signature-checked before persistence.
    }
    if (turn?.status === "queued") {
      this._db
        .prepare(
          `UPDATE turns SET prompt_text=?, prompt_revision_seq=?
           WHERE id=? AND status='queued' AND prompt_revision_seq < ?`,
        )
        .run(content, mutation.received_seq, turn.id, mutation.received_seq);
      this._db
        .prepare(
          "UPDATE inbound_events SET status_reason='queued_prompt_updated' WHERE id=?",
        )
        .run(mutation.id);
      return "applied";
    }
    if (turn && rerunOnEdit) {
      this._db
        .prepare(
          `INSERT INTO turns
            (bot_id, agent_id, chat_id, conversation_id, session_key,
             source_platform, source_event_id, retry_of_turn_id, prompt_text,
             prompt_markdown, prompt_revision_seq)
           VALUES (?, ?, 0, ?, ?, 'buzz', ?, ?, ?, ?, ?)`,
        )
        .run(
          turn.agent_id,
          turn.agent_id,
          turn.conversation_id,
          turn.session_key,
          mutation.id,
          turn.id,
          content,
          turn.prompt_markdown,
          mutation.received_seq,
        );
      this._db
        .prepare(
          "UPDATE inbound_events SET status='enqueued', status_reason='explicit_edit_rerun' WHERE id=?",
        )
        .run(mutation.id);
      return "applied";
    }
    this._db
      .prepare("UPDATE inbound_events SET status_reason=? WHERE id=?")
      .run(
        turn ? `edit_notice:${turn.status}` : "edit_notice:no_turn",
        mutation.id,
      );
    return "applied";
  }

  listBuzzEventsByStatus(
    endpointId: string,
    statuses: readonly string[],
  ): Array<{ id: number; status: string; payloadJson: string }> {
    if (!this.normalizedSchema || statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return this._db
      .query(
        `SELECT id, status, payload_json AS payloadJson FROM inbound_events
         WHERE endpoint_id=? AND platform='buzz'
           AND status IN (${placeholders}) ORDER BY received_seq`,
      )
      .all(endpointId, ...statuses) as Array<{
      id: number;
      status: string;
      payloadJson: string;
    }>;
  }

  transitionInboundEvent(
    id: number,
    from: string,
    to: string,
    reason: string | null = null,
  ): boolean {
    if (!this.normalizedSchema) return false;
    const result = this._db
      .prepare(
        "UPDATE inbound_events SET status=?, status_reason=? WHERE id=? AND status=?",
      )
      .run(to, reason, id, from);
    return result.changes === 1;
  }

  private advanceBuzzCursor(
    endpointId: string,
    scope: string,
    createdAt: number,
    eventId: string,
  ): void {
    const state = this.getEndpointState(endpointId);
    if (!state) throw new Error(`unknown endpoint '${endpointId}'`);
    const current = state.cursor.subscriptions[scope];
    if (
      current &&
      (current.created_at > createdAt ||
        (current.created_at === createdAt && current.event_id >= eventId))
    ) {
      return;
    }
    const cursor: BuzzCursorState = {
      ...state.cursor,
      subscriptions: {
        ...state.cursor.subscriptions,
        [scope]: { created_at: createdAt, event_id: eventId },
      },
    };
    this._db
      .prepare("UPDATE endpoints SET cursor_json=? WHERE endpoint_id=?")
      .run(JSON.stringify(cursor), endpointId);
  }

  private insertNormalizedInbound(
    event: InboundEvent,
    status: string,
    payloadJson: string,
  ): number | null {
    if (!event.conversation) return null;
    const existing = this.getInboundEventStatus(
      event.endpointId,
      event.externalEventId,
    );
    if (existing) return null;
    const conversation = this.resolveConversation(
      event.agentId,
      event.conversation,
      event.sender.id,
    );
    const seq = this._db
      .query(
        `
        UPDATE endpoints
        SET next_received_seq=next_received_seq+1, updated_at=datetime('now')
        WHERE endpoint_id=?
        RETURNING next_received_seq
      `,
      )
      .get(event.endpointId) as { next_received_seq: number } | null;
    if (!seq) throw new Error(`unknown endpoint '${event.endpointId}'`);
    const result = this._db
      .prepare(
        `
        INSERT INTO inbound_events
          (endpoint_id, platform, external_event_id, external_message_id,
           target_external_event_id, workflow_run_id, conversation_id,
           sender_id, event_kind, reply_to_external_id, payload_json,
           payload_sha256, received_seq, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        event.endpointId,
        event.platform,
        event.externalEventId,
        event.externalMessageId,
        event.targetExternalEventId,
        event.workflowRunId,
        conversation.id,
        event.sender.id,
        event.kind,
        event.replyTo,
        payloadJson,
        createHash("sha256").update(payloadJson).digest("hex"),
        seq.next_received_seq,
        status,
      );
    return Number(result.lastInsertRowid);
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
    const args = [
      botId,
      ...(this.normalizedSchema ? [botId] : []),
      telegramUpdateId,
      chatId,
      messageId,
      fromUserId,
      payloadJson,
      status,
    ];
    const result = this.stmts.insertUpdate.run(...args);
    if (result.changes === 0) return null;
    if (!this.normalizedSchema) return Number(result.lastInsertRowid);
    const endpointId = this.getEndpointId(botId, "telegram");
    this.insertNormalizedInbound(
      {
        platform: "telegram",
        endpointId,
        agentId: botId,
        communityId: null,
        conversation: {
          platform: "telegram",
          communityId: null,
          endpointId,
          channelId: String(chatId),
          threadRootId: null,
          workflowRunId: null,
          type: "direct",
        },
        externalEventId: String(telegramUpdateId),
        externalMessageId: String(messageId),
        targetExternalEventId: null,
        workflowRunId: null,
        sender: {
          id: fromUserId,
          kind: "unknown",
          displayName: null,
          username: null,
          raw: null,
        },
        kind: "message",
        text: "",
        markdown: false,
        replyTo: null,
        rootEventId: null,
        mentions: [],
        attachments: [],
        occurredAt: 0,
        receivedSeq: 0,
        raw: null,
      },
      status,
      payloadJson,
    );
    return Number(result.lastInsertRowid);
  }

  setUpdateStatus(id: number, status: string): void {
    this.stmts.setUpdateStatus.run(status, id);
    if (!this.normalizedSchema) return;
    const update = this._db
      .query(
        "SELECT bot_id, telegram_update_id FROM inbound_updates WHERE id=?",
      )
      .get(id) as { bot_id: string; telegram_update_id: number } | null;
    if (!update) return;
    const isAgentApi = update.telegram_update_id < 0;
    const endpointId = this.getEndpointId(
      update.bot_id,
      isAgentApi ? "agent_api" : "telegram",
    );
    const externalEventId = isAgentApi
      ? `agentapi:${Math.abs(update.telegram_update_id)}`
      : String(update.telegram_update_id);
    this._db
      .prepare(
        "UPDATE inbound_events SET status=? WHERE endpoint_id=? AND external_event_id=?",
      )
      .run(status, endpointId, externalEventId);
  }

  // --- Turns ---

  createTurn(
    botId: BotId,
    chatId: number,
    sourceUpdateId: number,
    attachmentPaths?: string[],
  ): number {
    if (!this.normalizedSchema) {
      const result = this.stmts.createTurn.run(
        botId,
        chatId,
        sourceUpdateId,
        attachmentPaths ? JSON.stringify(attachmentPaths) : null,
      );
      return Number(result.lastInsertRowid);
    }
    const inbound = this._db
      .query(
        `SELECT telegram_update_id, chat_id, message_id, from_user_id,
                payload_json, status
         FROM inbound_updates WHERE id=?`,
      )
      .get(sourceUpdateId) as {
      telegram_update_id: number;
      chat_id: number;
      message_id: number;
      from_user_id: string;
      payload_json: string;
      status: string;
    } | null;
    if (!inbound) throw new Error(`inbound update ${sourceUpdateId} not found`);
    const endpointId = this.getEndpointId(botId, "telegram");
    let event = this.getInboundEventStatus(
      endpointId,
      String(inbound.telegram_update_id),
    );
    if (!event) {
      this.insertNormalizedInbound(
        {
          platform: "telegram",
          endpointId,
          agentId: botId,
          communityId: null,
          conversation: {
            platform: "telegram",
            communityId: null,
            endpointId,
            channelId: String(inbound.chat_id),
            threadRootId: null,
            workflowRunId: null,
            type: "direct",
          },
          externalEventId: String(inbound.telegram_update_id),
          externalMessageId: String(inbound.message_id),
          targetExternalEventId: null,
          workflowRunId: null,
          sender: {
            id: inbound.from_user_id,
            kind: "unknown",
            displayName: null,
            username: null,
            raw: null,
          },
          kind: "message",
          text: "",
          markdown: false,
          replyTo: null,
          rootEventId: null,
          mentions: [],
          attachments: [],
          occurredAt: 0,
          receivedSeq: 0,
          raw: null,
        },
        inbound.status,
        inbound.payload_json,
      );
      event = this.getInboundEventStatus(
        endpointId,
        String(inbound.telegram_update_id),
      );
    }
    if (!event) throw new Error("normalized inbound event missing");
    const normalized = this._db
      .query(
        `
        SELECT ie.conversation_id, ie.received_seq, c.session_key
        FROM inbound_events ie JOIN conversations c ON c.id=ie.conversation_id
        WHERE ie.id=?
      `,
      )
      .get(event.id) as {
      conversation_id: number;
      received_seq: number;
      session_key: string | null;
    };
    let promptText: string | null = null;
    try {
      const payload = JSON.parse(inbound.payload_json);
      promptText =
        payload?.message?.text ??
        payload?.message?.caption ??
        payload?.prompt ??
        null;
    } catch {
      // Raw payload remains durable even when the legacy parser cannot read it.
    }
    const result = this.stmts.createTurn.run(
      botId,
      botId,
      chatId,
      sourceUpdateId,
      attachmentPaths ? JSON.stringify(attachmentPaths) : null,
      normalized.conversation_id,
      normalized.session_key,
      "telegram",
      event.id,
      promptText,
      0,
      normalized.received_seq,
    );
    return Number(result.lastInsertRowid);
  }

  /** Create a durable turn from a Buzz event already recorded by relay intake. */
  enqueueRecordedBuzzTurn(
    inboundEventId: number,
    agentId: BotId,
    promptText: string,
    rerunOnEdit = false,
  ): number | null {
    if (!this.normalizedSchema) return null;
    return this.transactionImmediate(() => {
      const row = this._db
        .query(
          `SELECT ie.conversation_id, ie.received_seq, ie.status, c.session_key
           FROM inbound_events ie
           JOIN conversations c ON c.id=ie.conversation_id
           WHERE ie.id=? AND ie.endpoint_id IN
             (SELECT endpoint_id FROM endpoints WHERE agent_id=?)`,
        )
        .get(inboundEventId, agentId) as {
        conversation_id: number;
        received_seq: number;
        status: string;
        session_key: string | null;
      } | null;
      if (!row || row.status !== "dispatched") return null;
      const existing = this._db
        .query("SELECT id FROM turns WHERE source_event_id=?")
        .get(inboundEventId) as { id: number } | null;
      if (existing) return existing.id;
      const result = this._db
        .prepare(
          `INSERT INTO turns
            (bot_id, agent_id, chat_id, source_update_id, conversation_id,
             session_key, source_platform, source_event_id, prompt_text,
             prompt_markdown, prompt_revision_seq)
           VALUES (?, ?, 0, NULL, ?, ?, 'buzz', ?, ?, 1, ?)`,
        )
        .run(
          agentId,
          agentId,
          row.conversation_id,
          row.session_key,
          inboundEventId,
          promptText,
          row.received_seq,
        );
      this._db
        .prepare(
          "UPDATE inbound_events SET status='enqueued', status_reason=NULL WHERE id=? AND status='dispatched'",
        )
        .run(inboundEventId);
      const source = this._db
        .query(
          "SELECT endpoint_id, external_event_id FROM inbound_events WHERE id=?",
        )
        .get(inboundEventId) as {
        endpoint_id: string;
        external_event_id: string;
      };
      this.applyPendingBuzzMutations(
        source.endpoint_id,
        source.external_event_id,
        rerunOnEdit,
      );
      return Number(result.lastInsertRowid);
    });
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

  /** Terminally dead-letter a queued normalized turn and its source event. */
  deadLetterTurn(turnId: number, reason: string): boolean {
    if (!this.normalizedSchema) return false;
    const row = this._db
      .query(
        "SELECT source_update_id FROM turns WHERE id=? AND status='queued'",
      )
      .get(turnId) as { source_update_id: number | null } | null;
    if (!row) return false;
    this._db
      .prepare(
        "UPDATE turns SET status='dead', completed_at=datetime('now'), error_text=? WHERE id=? AND status='queued'",
      )
      .run(reason, turnId);
    this.setTurnSourceEventStatus(turnId, "dead");
    if (row.source_update_id === null) return true;
    this.setUpdateStatus(row.source_update_id, "dead");
    const update = this._db
      .query(
        "SELECT bot_id, telegram_update_id FROM inbound_updates WHERE id=?",
      )
      .get(row.source_update_id) as {
      bot_id: string;
      telegram_update_id: number;
    } | null;
    if (update) {
      const endpointId = this.getEndpointId(
        update.bot_id,
        update.telegram_update_id < 0 ? "agent_api" : "telegram",
      );
      const externalEventId =
        update.telegram_update_id < 0
          ? `agentapi:${Math.abs(update.telegram_update_id)}`
          : String(update.telegram_update_id);
      this._db
        .prepare(
          "UPDATE inbound_events SET status_reason=? WHERE endpoint_id=? AND external_event_id=?",
        )
        .run(reason, endpointId, externalEventId);
    }
    return true;
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
    source: string | null;
  }> {
    return this.stmts.getRunningTurns.all() as Array<{
      id: number;
      bot_id: BotId;
      chat_id: number;
      source_update_id: number;
      first_output_at: string | null;
      source: string | null;
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

  getQueuedConversationTurns(): Array<{
    id: number;
    bot_id: BotId;
    chat_id: number;
    source_update_id: number;
    conversation_id: number | null;
    session_key: string | null;
    agent_api_token_name: string | null;
    received_at: string;
    conversation_archived: number;
  }> {
    if (!this.normalizedSchema) return [];
    return this._db
      .query(
        `
        SELECT t.id, t.bot_id, t.chat_id, t.source_update_id,
               t.conversation_id, t.session_key, t.agent_api_token_name,
               COALESCE(ie.received_at, datetime('now')) AS received_at,
               c.archived AS conversation_archived
        FROM turns t
        JOIN conversations c ON c.id=t.conversation_id
        LEFT JOIN inbound_events ie ON ie.id=t.source_event_id
        WHERE t.status='queued' AND t.conversation_id IS NOT NULL
        ORDER BY t.conversation_id ASC, t.id ASC
      `,
      )
      .all() as Array<{
      id: number;
      bot_id: BotId;
      chat_id: number;
      source_update_id: number;
      conversation_id: number | null;
      session_key: string | null;
      agent_api_token_name: string | null;
      received_at: string;
      conversation_archived: number;
    }>;
  }

  getTurnText(turnId: number): string | null {
    if (this.normalizedSchema) {
      const normalized = this._db
        .query("SELECT prompt_text FROM turns WHERE id=?")
        .get(turnId) as { prompt_text: string | null } | null;
      if (
        normalized?.prompt_text !== null &&
        normalized?.prompt_text !== undefined
      ) {
        return normalized.prompt_text;
      }
    }
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

  setTurnSourceEventStatus(turnId: number, status: string): void {
    if (!this.normalizedSchema) return;
    this._db
      .prepare(
        `UPDATE inbound_events SET status=?
         WHERE id=(SELECT source_event_id FROM turns WHERE id=?)`,
      )
      .run(status, turnId);
  }

  getTurnDeliveryContext(turnId: number): {
    agentId: BotId;
    conversation: ConversationRef;
    sourceEventId: string;
    senderId: string;
    traceId: string | null;
    hop: number;
  } | null {
    if (!this.normalizedSchema) return null;
    const row = this._db
      .query(
        `SELECT t.agent_id, c.platform, c.community_id, c.endpoint_id,
                c.external_conversation_id, c.thread_root_id,
                c.workflow_run_id, c.conversation_type,
                ie.external_event_id, ie.sender_id, ie.payload_json
         FROM turns t
         JOIN conversations c ON c.id=t.conversation_id
         JOIN inbound_events ie ON ie.id=t.source_event_id
         WHERE t.id=?`,
      )
      .get(turnId) as {
      agent_id: BotId;
      platform: ConversationRef["platform"];
      community_id: string | null;
      endpoint_id: string;
      external_conversation_id: string;
      thread_root_id: string;
      workflow_run_id: string;
      conversation_type: ConversationRef["type"];
      external_event_id: string;
      sender_id: string;
      payload_json: string | null;
    } | null;
    if (!row) return null;
    let traceId: string | null = null;
    let hop = 0;
    try {
      const payload = JSON.parse(row.payload_json ?? "null") as {
        tags?: string[][];
      } | null;
      for (const tag of payload?.tags ?? []) {
        if (tag[0] === "torana-trace" && tag[1]) traceId = tag[1];
        if (tag[0] === "torana-hop" && /^\d+$/.test(tag[1] ?? "")) {
          hop = Number(tag[1]);
        }
      }
    } catch {
      // Missing diagnostic tags never block delivery; the local budget does.
    }
    return {
      agentId: row.agent_id,
      conversation: {
        platform: row.platform,
        communityId: row.community_id,
        endpointId: row.endpoint_id,
        channelId: row.external_conversation_id,
        threadRootId: row.thread_root_id || null,
        workflowRunId: row.workflow_run_id || null,
        type: row.conversation_type,
      },
      sourceEventId: row.external_event_id,
      senderId: row.sender_id,
      traceId,
      hop,
    };
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
    if (!this.normalizedSchema) {
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
    const endpointId = this.getEndpointId(botId, "telegram");
    const conversation = this.resolveConversation(botId, {
      platform: "telegram",
      communityId: null,
      endpointId,
      channelId: String(chatId),
      threadRootId: null,
      workflowRunId: null,
      type: "direct",
    });
    const result = this.stmts.insertOutbox.run(
      turnId,
      botId,
      botId,
      chatId,
      kind,
      telegramMessageId ?? null,
      payloadJson,
      endpointId,
      "telegram",
      conversation.id,
      kind,
      telegramMessageId !== undefined ? String(telegramMessageId) : null,
      null,
      null,
    );
    return Number(result.lastInsertRowid);
  }

  /** Queue one platform-neutral durable operation with its prebuilt payload. */
  insertOutboundOperation(args: {
    turnId: number | null;
    agentId: string;
    conversation: ConversationRef;
    operation: OutboundOperation;
    payloadJson?: string;
    signedPayloadJson?: string | null;
    signedEventId?: string | null;
  }): number {
    const externalMessageId =
      "externalMessageId" in args.operation
        ? args.operation.externalMessageId
        : null;
    const payloadJson = args.payloadJson ?? JSON.stringify(args.operation);
    if (!this.normalizedSchema) {
      if (args.conversation.platform !== "telegram") {
        throw new Error("schema v3 can queue only Telegram operations");
      }
      const chatId = legacyDecimalOrNull(args.conversation.channelId);
      const messageId = externalMessageId
        ? legacyDecimalOrNull(externalMessageId)
        : null;
      if (chatId === null) {
        throw new Error("schema v3 requires a numeric Telegram chat ID");
      }
      const result = this.stmts.insertOutbox.run(
        args.turnId,
        args.agentId,
        chatId,
        args.operation.kind,
        messageId,
        payloadJson,
      );
      return Number(result.lastInsertRowid);
    }
    const conversation = this.resolveConversation(
      args.agentId,
      args.conversation,
    );
    const legacyChatId =
      args.conversation.platform === "telegram"
        ? legacyDecimalOrNull(args.conversation.channelId)
        : null;
    const legacyMessageId =
      args.conversation.platform === "telegram" && externalMessageId
        ? legacyDecimalOrNull(externalMessageId)
        : null;
    const result = this.stmts.insertOutbox.run(
      args.turnId,
      args.conversation.platform === "telegram" ? args.agentId : null,
      args.agentId,
      legacyChatId,
      args.conversation.platform === "telegram" ? args.operation.kind : null,
      legacyMessageId,
      payloadJson,
      args.conversation.endpointId,
      args.conversation.platform,
      conversation.id,
      args.operation.kind,
      externalMessageId,
      args.signedPayloadJson ?? null,
      args.signedEventId ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Mark a pending/retrying outbox row as currently being delivered.
   * `graceSecs` defines how long until the row auto-recovers if a crash
   * leaves it stuck in `in_flight` — see getPendingOutbox.
   */
  markOutboxInFlight(id: number, graceSecs: number): void {
    this.stmts.markOutboxInFlight.run(graceSecs, id);
  }

  markOutboxSent(id: number, externalMessageId?: string | number): void {
    const telegramMessageId =
      externalMessageId !== undefined &&
      /^-?\d+$/.test(String(externalMessageId))
        ? Number(externalMessageId)
        : null;
    if (this.normalizedSchema) {
      this.stmts.markOutboxSent.run(
        telegramMessageId,
        externalMessageId !== undefined ? String(externalMessageId) : null,
        id,
      );
    } else {
      this.stmts.markOutboxSent.run(telegramMessageId, id);
    }
  }

  /**
   * Returns rows still in `in_flight` state (a crash left them mid-send).
   * Called at gateway startup so the operator sees a warning per affected
   * row before the grace window auto-recovers them.
   */
  getInFlightOutbox(): Array<{
    id: number;
    turn_id: number | null;
    bot_id: BotId | null;
    agent_id: BotId;
    chat_id: number | null;
    kind: string | null;
    operation_kind?: string;
    attempt_count: number;
    next_attempt_at: string | null;
  }> {
    return this.stmts.getInFlightOutbox.all() as Array<{
      id: number;
      turn_id: number | null;
      bot_id: BotId | null;
      agent_id: BotId;
      chat_id: number | null;
      kind: string | null;
      operation_kind?: string;
      attempt_count: number;
      next_attempt_at: string | null;
    }>;
  }

  markOutboxFailed(id: number, error: string): void {
    this.stmts.markOutboxFailed.run(error, id);
  }

  markOutboxDead(id: number, error: string): void {
    this._db
      .prepare(
        "UPDATE outbox SET status='dead', last_error=? WHERE id=? AND status='pending'",
      )
      .run(error, id);
  }

  countRecentConversationalOutbox(args: {
    endpointId: string;
    conversationId?: number;
    since: string;
  }): number {
    const row = this._db
      .query(
        `SELECT COUNT(DISTINCT CASE WHEN turn_id IS NULL THEN -id ELSE turn_id END) AS count FROM outbox
         WHERE endpoint_id=? AND operation_kind IN ('send','forum_comment')
           AND created_at>=?
           ${args.conversationId === undefined ? "" : "AND conversation_id=?"}`,
      )
      .get(
        args.endpointId,
        args.since,
        ...(args.conversationId === undefined ? [] : [args.conversationId]),
      ) as { count: number };
    return Number(row.count);
  }

  hasConversationalOutboxForTurn(turnId: number): boolean {
    if (!this.normalizedSchema) return false;
    return !!this._db
      .query(
        `SELECT 1 FROM outbox
         WHERE turn_id=? AND operation_kind IN ('send','forum_comment') LIMIT 1`,
      )
      .get(turnId);
  }

  countOutboxTrace(traceId: string): number {
    if (!this.normalizedSchema) return 0;
    const row = this._db
      .query(
        `SELECT COUNT(DISTINCT CASE WHEN turn_id IS NULL THEN -id ELSE turn_id END) AS count FROM outbox
         WHERE json_valid(payload_json)
           AND json_extract(payload_json, '$.traceId')=?`,
      )
      .get(traceId) as { count: number };
    return Number(row.count);
  }

  /**
   * Schedule a Retry-After-respecting retry. Does NOT bump attempt_count —
   * a server-asked cooldown should not consume the retry budget that
   * exists for genuine deliverability failures (network, 5xx, etc.).
   */
  markOutboxRateLimited(
    id: number,
    error: string,
    nextAttemptAt: string,
  ): void {
    this.stmts.markOutboxRateLimited.run(nextAttemptAt, error, id);
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
    turn_id: number | null;
    bot_id: BotId | null;
    agent_id: BotId;
    chat_id: number | null;
    kind: string | null;
    telegram_message_id: number | null;
    payload_json: string;
    status: string;
    attempt_count: number;
    endpoint_id: string;
    platform: "telegram" | "buzz" | "agent_api";
    conversation_id: number | null;
    operation_kind: string;
    external_message_id: string | null;
    signed_payload_json: string | null;
    signed_event_id: string | null;
    community_id: string | null;
    external_conversation_id: string;
    thread_root_id: string | null;
    workflow_run_id: string | null;
    conversation_type:
      | "direct"
      | "stream"
      | "forum"
      | "workflow"
      | "group"
      | "api";
  }> {
    const rows = this.stmts.getPendingOutbox.all() as ReturnType<
      GatewayDB["getPendingOutbox"]
    >;
    if (!this.normalizedSchema) return rows;
    const deliverable = new Set(
      (
        this._db
          .query(
            `SELECT endpoint_id FROM endpoints
             WHERE lifecycle_state IN ('active', 'draining')`,
          )
          .all() as Array<{ endpoint_id: string }>
      ).map((row) => row.endpoint_id),
    );
    return rows.filter((row) => deliverable.has(row.endpoint_id));
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
    this.stmts.initWorkerState.run(
      ...(this.normalizedSchema ? [botId, botId] : [botId]),
    );
  }

  // Runtime allowlist of columns each dynamicUpdate-capable table accepts.
  // SQLite identifiers are not bind targets, so column names below are
  // interpolated into the UPDATE string. Static types are erased at runtime —
  // without this allowlist, an attacker-controlled key reaching this path
  // could become arbitrary SQL.
  private static readonly UPDATABLE_COLUMNS: Record<
    string,
    ReadonlySet<string>
  > = {
    worker_state: new Set([
      "pid",
      "generation",
      "status",
      "started_at",
      "last_event_at",
      "last_ready_at",
      "consecutive_failures",
      "last_error",
    ]),
    stream_state: new Set([
      "active_telegram_message_id",
      "active_external_message_id",
      "buffer_text",
      "last_flushed_at",
      "segment_index",
    ]),
  };

  private dynamicUpdate(
    table: string,
    whereCol: string,
    whereVal: string | number,
    updates: Record<string, string | number | null>,
  ): void {
    const allowed = GatewayDB.UPDATABLE_COLUMNS[table];
    if (!allowed) {
      throw new Error(
        `dynamicUpdate: no allowlist registered for table ${table}`,
      );
    }
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(updates)) {
      if (!allowed.has(k)) {
        throw new Error(
          `dynamicUpdate: column ${JSON.stringify(k)} is not updatable on ${table}`,
        );
      }
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) {
      throw new Error(`dynamicUpdate: empty update for table ${table}`);
    }
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
    active_external_message_id?: string | null;
    buffer_text: string;
    last_flushed_at: string | null;
    segment_index: number;
  } | null {
    return this.stmts.getStreamState.get(turnId) as {
      turn_id: number;
      active_telegram_message_id: number | null;
      active_external_message_id?: string | null;
      buffer_text: string;
      last_flushed_at: string | null;
      segment_index: number;
    } | null;
  }

  updateStreamState(
    turnId: number,
    updates: Partial<{
      active_telegram_message_id: number | null;
      active_external_message_id: string | null;
      buffer_text: string;
      last_flushed_at: string;
      segment_index: number;
    }>,
  ): void {
    const dualWrite = {
      ...updates,
      ...(this.normalizedSchema &&
      Object.prototype.hasOwnProperty.call(
        updates,
        "active_telegram_message_id",
      )
        ? {
            active_external_message_id:
              updates.active_telegram_message_id === null ||
              updates.active_telegram_message_id === undefined
                ? null
                : String(updates.active_telegram_message_id),
          }
        : {}),
    };
    this.dynamicUpdate(
      "stream_state",
      "turn_id",
      turnId,
      dualWrite as Record<string, string | number | null>,
    );
  }

  // --- Bot state (polling offset, disabled flag) ---

  initBotState(botId: BotId): void {
    if (this.normalizedSchema) this.getEndpointId(botId, "telegram");
    this.stmts.initBotState.run(
      ...(this.normalizedSchema ? [botId, botId] : [botId]),
    );
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
    this.transaction(() => {
      this.stmts.setBotOffset.run(lastUpdateId, botId);
      if (this.normalizedSchema) {
        this._db
          .prepare(
            "UPDATE endpoints SET cursor_json=?, updated_at=datetime('now') WHERE endpoint_id=?",
          )
          .run(
            JSON.stringify({
              kind: "telegram_offset",
              last_update_id: lastUpdateId,
            }),
            this.getEndpointId(botId, "telegram"),
          );
      }
    });
  }

  setBotDisabled(botId: BotId, reason: string): void {
    this.transaction(() => {
      this.stmts.setBotDisabled.run(reason, botId);
      if (this.normalizedSchema) {
        this._db
          .prepare(
            "UPDATE endpoints SET lifecycle_state='disabled', state_reason=?, updated_at=datetime('now') WHERE endpoint_id=?",
          )
          .run(reason, this.getEndpointId(botId, "telegram"));
      }
    });
  }

  clearBotDisabled(botId: BotId): void {
    this.transaction(() => {
      this.stmts.clearBotDisabled.run(botId);
      if (this.normalizedSchema) {
        this._db
          .prepare(
            "UPDATE endpoints SET lifecycle_state='active', state_reason=NULL, updated_at=datetime('now') WHERE endpoint_id=?",
          )
          .run(this.getEndpointId(botId, "telegram"));
      }
    });
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
    this.stmts.upsertUserChat.run(
      ...(this.normalizedSchema
        ? [botId, botId, telegramUserId, chatId]
        : [botId, telegramUserId, chatId]),
    );
    if (!this.normalizedSchema) return;
    const endpointId = this.getEndpointId(botId, "telegram");
    const conversation = this.resolveConversation(botId, {
      platform: "telegram",
      communityId: null,
      endpointId,
      channelId: String(chatId),
      threadRootId: null,
      workflowRunId: null,
      type: "direct",
    });
    this._db
      .prepare(
        `
        INSERT INTO user_conversations
          (agent_id, platform, external_user_id, conversation_id, last_inbound_at)
        VALUES (?, 'telegram', ?, ?, datetime('now'))
        ON CONFLICT(agent_id, platform, external_user_id) DO UPDATE SET
          conversation_id=excluded.conversation_id,
          last_inbound_at=excluded.last_inbound_at
      `,
      )
      .run(botId, telegramUserId, conversation.id);
  }

  getLastChatForUser(
    botId: BotId,
    telegramUserId: string,
  ): { chat_id: number } | null {
    return this.stmts.getLastChatForUser.get(botId, telegramUserId) as {
      chat_id: number;
    } | null;
  }

  /**
   * Inverse of {@link getLastChatForUser}: given a (bot_id, chat_id),
   * return the most-recently-seen telegram_user_id for that chat. Used by
   * the agent-API `send` ACL re-check when the caller passed chat_id only.
   */
  getUserIdForChat(botId: BotId, chatId: number): string | null {
    const row = this.stmts.getUserIdForChat.get(botId, chatId) as {
      telegram_user_id: string;
    } | null;
    return row?.telegram_user_id ?? null;
  }

  listUserChatsByBot(botId: BotId): Array<{ chat_id: number }> {
    return this.stmts.listUserChatsByBot.all(botId) as Array<{
      chat_id: number;
    }>;
  }

  /**
   * Every turn that still has a non-null attachment_paths_json blob.
   * Used by the agent-API attachment GC to compute the live-set of
   * referenced files before sweeping orphans. Returns the raw JSON; the
   * caller does the parse + flatten so a malformed row doesn't poison
   * the whole sweep.
   */
  listTurnAttachmentRows(): Array<{ attachment_paths_json: string }> {
    return this.stmts.listTurnAttachmentRows.all() as Array<{
      attachment_paths_json: string;
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

  getConversationSession(sessionKey: string): ConversationSessionRow | null {
    if (!this.normalizedSchema) return null;
    return this._db
      .query("SELECT * FROM conversation_sessions WHERE session_key=?")
      .get(sessionKey) as ConversationSessionRow | null;
  }

  persistConversationSession(args: {
    sessionKey: string;
    agentId: string;
    runnerSessionId: string;
    runnerType: string;
    providerState: Record<string, unknown> | null;
    state: "starting" | "ready" | "busy" | "stopping" | "stopped";
    startedAt?: string | null;
    hardExpiresAt?: string | null;
    contextExpiresAt?: string | null;
    lastError?: string | null;
  }): void {
    if (!this.normalizedSchema) return;
    this._db
      .prepare(
        `
        INSERT INTO conversation_sessions
          (session_key, agent_id, runner_session_id, runner_type,
           provider_state_json, state, started_at, last_used_at,
           hard_expires_at, context_expires_at, last_error)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          runner_session_id=excluded.runner_session_id,
          runner_type=excluded.runner_type,
          provider_state_json=excluded.provider_state_json,
          state=excluded.state,
          started_at=COALESCE(excluded.started_at, started_at),
          last_used_at=datetime('now'),
          hard_expires_at=excluded.hard_expires_at,
          context_expires_at=excluded.context_expires_at,
          last_error=excluded.last_error
      `,
      )
      .run(
        args.sessionKey,
        args.agentId,
        args.runnerSessionId,
        args.runnerType,
        args.providerState === null ? null : JSON.stringify(args.providerState),
        args.state,
        args.startedAt ?? null,
        args.hardExpiresAt ?? null,
        args.contextExpiresAt ?? null,
        args.lastError ?? null,
      );
  }

  updateConversationSessionState(
    sessionKey: string,
    state: "starting" | "ready" | "busy" | "stopping" | "stopped",
  ): void {
    if (!this.normalizedSchema) return;
    this._db
      .prepare(
        "UPDATE conversation_sessions SET state=?, last_used_at=datetime('now') WHERE session_key=?",
      )
      .run(state, sessionKey);
  }

  updateConversationSessionProviderState(
    sessionKey: string,
    state: Record<string, unknown>,
    contextExpiresAt: string,
  ): void {
    if (!this.normalizedSchema) return;
    this._db
      .prepare(
        "UPDATE conversation_sessions SET provider_state_json=?, context_expires_at=?, last_used_at=datetime('now') WHERE session_key=?",
      )
      .run(JSON.stringify(state), contextExpiresAt, sessionKey);
  }

  resetConversationSession(sessionKey: string): void {
    if (!this.normalizedSchema) return;
    this._db
      .prepare(
        "UPDATE conversation_sessions SET provider_state_json=NULL, generation=generation+1, state='stopped', started_at=NULL, hard_expires_at=NULL, context_expires_at=NULL, last_error=NULL WHERE session_key=?",
      )
      .run(sessionKey);
  }

  setConversationSessionError(sessionKey: string, reason: string): void {
    if (!this.normalizedSchema) return;
    this._db
      .prepare(
        "UPDATE conversation_sessions SET last_error=?, last_used_at=datetime('now') WHERE session_key=?",
      )
      .run(reason || null, sessionKey);
  }

  deadLetterNextQueuedSessionTurn(
    sessionKey: string,
    reason: string,
  ): number | null {
    if (!this.normalizedSchema) return null;
    const row = this._db
      .query(
        "SELECT id FROM turns WHERE session_key=? AND status='queued' ORDER BY id LIMIT 1",
      )
      .get(sessionKey) as { id: number } | null;
    if (!row) return null;
    this.deadLetterTurn(row.id, reason);
    return row.id;
  }

  conversationSessionBindingCount(sessionKey: string): number {
    if (!this.normalizedSchema) return 0;
    const row = this._db
      .query(
        "SELECT COUNT(*) AS count FROM conversations WHERE session_key=? AND archived=0",
      )
      .get(sessionKey) as { count: number };
    return Number(row.count);
  }

  conversationSessionQueueDepth(sessionKey: string): number {
    if (!this.normalizedSchema) return 0;
    const row = this._db
      .query(
        "SELECT COUNT(*) AS count FROM turns WHERE session_key=? AND status IN ('queued','running')",
      )
      .get(sessionKey) as { count: number };
    return Number(row.count);
  }

  conversationQueueDepth(conversationId: number): number {
    if (!this.normalizedSchema) return 0;
    const row = this._db
      .query(
        "SELECT COUNT(*) AS count FROM turns WHERE conversation_id=? AND status IN ('queued','running')",
      )
      .get(conversationId) as { count: number };
    return Number(row.count);
  }

  agentQueueDepth(agentId: string): number {
    if (!this.normalizedSchema) return this.getMailboxDepth(agentId as BotId);
    const row = this._db
      .query(
        "SELECT COUNT(*) AS count FROM turns WHERE agent_id=? AND status IN ('queued','running')",
      )
      .get(agentId) as { count: number };
    return Number(row.count);
  }

  findObservedConversationTarget(
    agentId: string,
    target: {
      endpointId: string;
      externalConversationId: string;
      threadRootId?: string;
      workflowRunId?: string;
    },
  ): {
    id: number;
    sessionKey: string | null;
    platform: string;
    externalConversationId: string;
  } | null {
    if (!this.normalizedSchema) return null;
    const row = this._db
      .query(
        `
        SELECT c.id, c.session_key, c.platform, c.external_conversation_id
        FROM conversations c
        JOIN endpoints e ON e.endpoint_id=c.endpoint_id
        WHERE c.agent_id=? AND c.endpoint_id=?
          AND c.external_conversation_id=?
          AND c.thread_root_id=? AND c.workflow_run_id=?
          AND c.archived=0 AND e.lifecycle_state IN ('active','draining')
      `,
      )
      .get(
        agentId,
        target.endpointId,
        target.externalConversationId,
        target.threadRootId ?? "",
        target.workflowRunId ?? "",
      ) as {
      id: number;
      session_key: string | null;
      platform: string;
      external_conversation_id: string;
    } | null;
    return row
      ? {
          id: row.id,
          sessionKey: row.session_key,
          platform: row.platform,
          externalConversationId: row.external_conversation_id,
        }
      : null;
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
      ...(this.normalizedSchema ? [row.botId] : []),
      row.sessionId,
      row.pid,
      row.startedAt,
      row.lastUsedAt,
      row.hardExpiresAt,
      row.state,
    );
    if (!this.normalizedSchema) return;
    const sessionKey = `agentapi:${row.botId}:${row.sessionId}`;
    const runnerSessionId = createHash("sha256")
      .update(sessionKey)
      .digest("hex");
    this._db
      .prepare(
        `
        INSERT INTO conversation_sessions
          (session_key, agent_id, runner_session_id, runner_type,
           provider_state_json, state, started_at, last_used_at,
           hard_expires_at)
        VALUES (?, ?, ?, 'agent_api_legacy', ?, ?, ?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          provider_state_json=excluded.provider_state_json,
          state=excluded.state,
          last_used_at=excluded.last_used_at,
          hard_expires_at=excluded.hard_expires_at
      `,
      )
      .run(
        sessionKey,
        row.botId,
        runnerSessionId,
        JSON.stringify({ version: 1, pid: row.pid }),
        row.state,
        row.startedAt,
        row.lastUsedAt,
        row.hardExpiresAt,
      );
  }

  markSideSessionState(
    botId: BotId,
    sessionId: string,
    state: "starting" | "ready" | "busy" | "stopping" | "stopped",
  ): void {
    this.stmts.markSideSessionState.run(state, botId, sessionId);
    if (this.normalizedSchema) {
      this._db
        .prepare(
          "UPDATE conversation_sessions SET state=?, last_used_at=datetime('now') WHERE session_key=?",
        )
        .run(state, `agentapi:${botId}:${sessionId}`);
    }
  }

  deleteSideSession(botId: BotId, sessionId: string): void {
    this.stmts.deleteSideSession.run(botId, sessionId);
    if (this.normalizedSchema) {
      this._db
        .prepare(
          "DELETE FROM conversation_sessions WHERE session_key=? AND runner_type='agent_api_legacy'",
        )
        .run(`agentapi:${botId}:${sessionId}`);
    }
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
    if (this.normalizedSchema) {
      this._db
        .prepare(
          "UPDATE conversation_sessions SET state='stopped' WHERE runner_type='agent_api_legacy'",
        )
        .run();
    }
  }

  markAllConversationSessionsStopped(): void {
    if (!this.normalizedSchema) return;
    this._db
      .prepare(
        "UPDATE conversation_sessions SET state='stopped' WHERE state!='stopped'",
      )
      .run();
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
    sessionKey?: string;
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
      const attachmentJson = args.attachmentPaths.length
        ? JSON.stringify(args.attachmentPaths)
        : null;
      const row = this.stmts.insertAskTurnRow.get(
        ...(this.normalizedSchema
          ? [
              args.botId,
              args.botId,
              inboundId,
              attachmentJson,
              args.tokenName,
              inboundId,
            ]
          : [args.botId, inboundId, attachmentJson, args.tokenName]),
      ) as { id: number };
      if (this.normalizedSchema && args.sessionKey) {
        this._db
          .prepare("UPDATE turns SET session_key=? WHERE id=?")
          .run(args.sessionKey, row.id);
      }
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
    targetConversation?: {
      id: number;
      sessionKey: string | null;
      platform: string;
    };
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

      const attachmentJson = args.attachmentPaths.length
        ? JSON.stringify(args.attachmentPaths)
        : null;
      const turnRow = this.stmts.insertSendTurnRow.get(
        ...(this.normalizedSchema
          ? [
              args.botId,
              args.botId,
              args.chatId,
              inboundId,
              attachmentJson,
              args.tokenName,
              args.sourceLabel,
              args.idempotencyKey,
              args.markerWrappedText,
              inboundId,
            ]
          : [
              args.botId,
              args.chatId,
              inboundId,
              attachmentJson,
              args.tokenName,
              args.sourceLabel,
              args.idempotencyKey,
            ]),
      ) as { id: number };

      if (this.normalizedSchema && args.targetConversation) {
        this._db
          .prepare(
            "UPDATE turns SET conversation_id=?, session_key=?, source_platform=? WHERE id=?",
          )
          .run(
            args.targetConversation.id,
            args.targetConversation.sessionKey,
            args.targetConversation.platform,
            turnRow.id,
          );
      }

      this.stmts.insertIdempotency.run(
        ...(this.normalizedSchema
          ? [args.botId, args.botId, args.idempotencyKey, turnRow.id]
          : [args.botId, args.idempotencyKey, turnRow.id]),
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
    if (!this.normalizedSchema) return row.id;
    const legacy = this._db
      .query("SELECT telegram_update_id FROM inbound_updates WHERE id=?")
      .get(row.id) as { telegram_update_id: number };
    const endpointId = this.getEndpointId(args.botId, "agent_api");
    this.insertNormalizedInbound(
      {
        platform: "agent_api",
        endpointId,
        agentId: args.botId,
        communityId: null,
        conversation: {
          platform: "agent_api",
          communityId: null,
          endpointId,
          channelId:
            args.chatId === 0 ? "legacy" : `chat:${String(args.chatId)}`,
          threadRootId: null,
          workflowRunId: null,
          type: "api",
        },
        externalEventId: `agentapi:${Math.abs(legacy.telegram_update_id)}`,
        externalMessageId: null,
        targetExternalEventId: null,
        workflowRunId: null,
        sender: {
          id: args.fromUserId,
          kind: "service",
          displayName: null,
          username: null,
          raw: null,
        },
        kind: "message",
        text: "",
        markdown: false,
        replyTo: null,
        rootEventId: null,
        mentions: [],
        attachments: [],
        occurredAt: 0,
        receivedSeq: 0,
        raw: null,
      },
      "enqueued",
      args.payloadJson,
    );
    return row.id;
  }

  close(): void {
    this._db.close();
    log.info("database closed");
  }
}

function parseBuzzCursor(raw: string | null): BuzzCursorState {
  if (!raw) return { version: 1, subscriptions: {} };
  try {
    const value = JSON.parse(raw) as Partial<BuzzCursorState>;
    if (
      value.version === 1 &&
      value.subscriptions &&
      typeof value.subscriptions === "object"
    ) {
      return {
        version: 1,
        subscriptions: value.subscriptions,
        ...(Array.isArray(value.channels)
          ? {
              channels: value.channels.filter(
                (item) => typeof item === "string",
              ),
            }
          : {}),
      };
    }
  } catch {
    // Treat malformed legacy cursor data as empty; doctor will surface relay
    // replay state once the endpoint reconnects.
  }
  return { version: 1, subscriptions: {} };
}

function legacyDecimalOrNull(value: string): number | null {
  if (!/^-?[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
