import { z } from 'zod';

/**
 * Парсинг тегов из описания события календаря, например:
 *   TYPE=TRAINING
 *   GYM=PAID
 *   COACH=PAID
 *   INVOLVED=ALL_BLACK
 *   REFEREE_PRICE=3500
 *   NOTES="Товарищеский матч"
 */

export const EventTagsSchema = z.object({
  TYPE: z.enum(['TRAINING', 'GAME', 'FRIENDLY']).optional(),
  GYM: z.enum(['PAID', 'FREE']).optional(),
  COACH: z.enum(['PAID', 'FREE']).optional(),
  INVOLVED: z
    .enum(['ALL_RED', 'ALL_BLACK', 'PLAYED_RED', 'PLAYED_BLACK', 'PLAYED_MIXED'])
    .optional(),
  REFEREE_PRICE: z.coerce.number().optional(),
  NOTES: z.string().optional(),
});

export type EventTags = z.infer<typeof EventTagsSchema>;

const LINE_RE = /^([A-Z_]+)\s*=\s*("([^"]*)"|.*)$/;

export function parseTags(description: string | null | undefined): EventTags {
  const raw: Record<string, string> = {};
  if (description) {
    for (const line of description.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = LINE_RE.exec(trimmed);
      if (!m) continue;
      const key = m[1]!;
      // m[3] — содержимое кавычек, иначе m[2] как есть.
      const value = (m[3] !== undefined ? m[3] : m[2] ?? '').trim();
      raw[key] = value;
    }
  }
  const parsed = EventTagsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}
