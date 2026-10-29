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
    .enum(['ALL_RED', 'ALL_BLACK', 'MIXED', 'PLAYED_RED', 'PLAYED_BLACK', 'PLAYED_MIXED'])
    .optional(),
  REFEREE_PRICE: z.coerce.number().optional(),
  NOTES: z.string().optional(),
});

export type EventTags = z.infer<typeof EventTagsSchema>;

// Ключ матчим регистронезависимо; значения нормализуем ниже (кроме NOTES).
const LINE_RE = /^([A-Za-z_]+)\s*=\s*("([^"]*)"|.*)$/;

/**
 * Описание события из Google может прийти как rich-text HTML — его создаёт
 * визуальный редактор календаря. Встречается два вида: теги в HTML-таблице
 * (<table>…<td>KEY=VALUE</td>…) и через <br> (KEY=VALUE<br>KEY=VALUE). В обоих
 * реальных переводов строк нет, и построчный парсер их не видит. Приводим такой
 * HTML к простому виду KEY=VALUE по строкам: границы блоков/переносов → перевод
 * строки, остальные теги вырезаем, основные html-сущности раскодируем. Простой
 * текстовый формат (KEY=VALUE с \n) этим не меняется.
 */
function htmlToLines(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}

export function parseTags(description: string | null | undefined): EventTags {
  const raw: Record<string, string> = {};
  if (description) {
    for (const line of htmlToLines(description).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = LINE_RE.exec(trimmed);
      if (!m) continue;
      const key = m[1]!.toUpperCase();
      // m[3] — содержимое кавычек, иначе m[2] как есть.
      const value = (m[3] !== undefined ? m[3] : m[2] ?? '').trim();
      // NOTES — свободный текст, регистр сохраняем; остальные теги (enum/число) нормализуем в верхний регистр.
      raw[key] = key === 'NOTES' ? value : value.toUpperCase();
    }
  }
  const parsed = EventTagsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}
