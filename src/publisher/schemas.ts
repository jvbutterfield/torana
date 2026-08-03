import { z } from "zod";

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

const safeContent = z
  .string()
  .min(1)
  .refine((value) => {
    for (const character of value) {
      const point = character.codePointAt(0)!;
      if (
        (point < 32 && point !== 9 && point !== 10 && point !== 13) ||
        point === 127
      ) {
        return false;
      }
    }
    return true;
  }, "content contains a disallowed control character");

export const PublishBodySchema = z
  .object({
    content: safeContent,
    source: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    severity: z.enum(["info", "warning", "error"]),
  })
  .strict();

export const PublisherStatusBodySchema = z
  .object({ idempotency_key: z.string().regex(IDEMPOTENCY_KEY) })
  .strict();

export type PublishBody = z.infer<typeof PublishBodySchema>;
