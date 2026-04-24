// Zod schemas for agent-api request bodies + regex constants reused by
// handlers, CLI, and client.

import { z } from "zod";

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SOURCE_LABEL_RE = /^[a-z0-9_-]{1,64}$/;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * A caller-supplied `text` on `POST /v1/bots/:id/send` is wrapped in
 * `[system-message from "<source>"]\n\n<text>` before being fed to the
 * runner. If `text` itself contains a second, line-starting
 * `[system-message from "..."]` header, the runner (or an LLM downstream)
 * sees two indistinguishable envelopes and can be instructed that content
 * further down originated from a different, possibly more-trusted `source`
 * than the one the caller's token actually authorises. Reject any such
 * text.
 *
 * Match is anchored on a line boundary to avoid flagging incidental prose
 * (e.g. docs / debug output that quotes the marker syntax inline). Also
 * catches the leading-whitespace variant and the raw-newline / carriage-
 * return variants.
 */
export const MARKER_INJECTION_RE =
  /(^|\r?\n)[ \t]*\[system-message from "/i;

export const AskBodySchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(64 * 1024),
    session_id: z.string().regex(SESSION_ID_RE).optional(),
    timeout_ms: z.coerce.number().int().min(1000).max(300_000).optional(),
  })
  .strict();

export type AskBody = z.infer<typeof AskBodySchema>;

export const SendBodySchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(64 * 1024)
      .refine((s) => !MARKER_INJECTION_RE.test(s), {
        message:
          "text must not contain a line starting with `[system-message from \"` — that framing is reserved for the gateway-generated marker and allowing it from callers would let a send caller spoof a second, differently-attributed marker to the runner",
      }),
    source: z.string().regex(SOURCE_LABEL_RE),
    user_id: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
    chat_id: z.coerce.number().int().optional(),
  })
  .strict()
  .refine((b) => !!b.user_id || b.chat_id !== undefined, {
    message: "either user_id or chat_id required",
    path: ["user_id"],
  });

export type SendBody = z.infer<typeof SendBodySchema>;

export function validateIdempotencyKey(
  key: string | null,
):
  | { ok: true; key: string }
  | { ok: false; code: "missing_idempotency_key" | "invalid_idempotency_key" } {
  if (!key) return { ok: false, code: "missing_idempotency_key" };
  if (!IDEMPOTENCY_KEY_RE.test(key))
    return { ok: false, code: "invalid_idempotency_key" };
  return { ok: true, key };
}
