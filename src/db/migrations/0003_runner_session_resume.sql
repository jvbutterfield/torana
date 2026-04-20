-- 0003 — Persist runner session identifiers across gateway restarts.
--
-- Codex stores its conversation as a `thread_id` returned in the first
-- turn's `thread.started` event. Without persistence the gateway loses
-- the id on restart and the next turn starts a fresh thread. This
-- migration adds a column to remember the most recently captured
-- thread_id per bot so `codex exec resume <id>` can be issued on the
-- first turn after restart.
--
-- Claude Code resumes via `--continue`, which reads the on-disk session
-- file maintained by the CLI itself; no extra state is needed there.

ALTER TABLE worker_state ADD COLUMN codex_thread_id TEXT;

PRAGMA user_version = 3;
