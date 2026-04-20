// Zod schemas for agent-api request bodies + regex constants reused by
// handlers, CLI, and client.

import { z } from "zod";

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SOURCE_LABEL_RE = /^[a-z0-9_-]{1,64}$/;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

export const AskBodySchema = z
  .object({
    text: z.string().min(1).max(64 * 1024),
    session_id: z.string().regex(SESSION_ID_RE).optional(),
    timeout_ms: z.coerce.number().int().min(1000).max(300_000).optional(),
  })
  .strict();

export type AskBody = z.infer<typeof AskBodySchema>;

export const InjectBodySchema = z
  .object({
    text: z.string().min(1).max(64 * 1024),
    source: z.string().regex(SOURCE_LABEL_RE),
    user_id: z.string().regex(/^\d{1,20}$/).optional(),
    chat_id: z.coerce.number().int().optional(),
  })
  .strict()
  .refine((b) => !!b.user_id || b.chat_id !== undefined, {
    message: "either user_id or chat_id required",
    path: ["user_id"],
  });

export type InjectBody = z.infer<typeof InjectBodySchema>;

export function validateIdempotencyKey(
  key: string | null,
):
  | { ok: true; key: string }
  | { ok: false; code: "missing_idempotency_key" | "invalid_idempotency_key" } {
  if (!key) return { ok: false, code: "missing_idempotency_key" };
  if (!IDEMPOTENCY_KEY_RE.test(key)) return { ok: false, code: "invalid_idempotency_key" };
  return { ok: true, key };
}
