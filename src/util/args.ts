/** Парсинг аргументов текстовых команд бота. */

export function normalizeLogin(raw: string): string {
  const v = raw.trim();
  return v.startsWith('@') ? v : `@${v}`;
}

export function parseMonthYear(
  text: string,
  fallback: { month: number; year: number },
): { month: number; year: number } | null {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  const month = Number(parts[0]);
  const year = parts[1] ? Number(parts[1]) : fallback.year;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return null;
  return { month, year };
}

export function extractUrls(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((t) => /^https?:\/\//i.test(t));
}
