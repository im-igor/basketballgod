/** Парсинг аргументов текстовых команд бота. */
import type { Team } from '../db/types.js';

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

/** Дата ДД.ММ.ГГГГ → ISO YYYY-MM-DD, иначе null. */
function ruDateToISO(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface BudgetGameArg {
  url: string;
  date: string | null; // ISO | null
}

export interface BudgetArgs {
  team: Team;
  month: number;
  year: number;
  games: BudgetGameArg[];
}

const BUDGET_FORMAT = 'Укажи команду RED/BLACK, месяц и год бюджета; затем ссылки на игры и при необходимости даты ДД.ММ.ГГГГ';

/**
 * Разбор полей импорта игр в админке: обязательны команда, месяц, год; далее — необязательные
 * пары «ссылка [дата]». Дата относится к ближайшей предыдущей ссылке.
 */
export function parseBudgetArgs(text: string): { value?: BudgetArgs; error?: string } {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const teamRaw = (parts[0] ?? '').toUpperCase();
  if (teamRaw !== 'RED' && teamRaw !== 'BLACK') {
    return { error: BUDGET_FORMAT };
  }
  const month = Number(parts[1]);
  const year = Number(parts[2]);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { error: `Укажи месяц 1–12. ${BUDGET_FORMAT}` };
  }
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return { error: `Укажи год. ${BUDGET_FORMAT}` };
  }

  const games: BudgetGameArg[] = [];
  for (const tok of parts.slice(3)) {
    if (/^https?:\/\//i.test(tok)) {
      games.push({ url: tok, date: null });
      continue;
    }
    const iso = ruDateToISO(tok);
    if (iso) {
      const last = games[games.length - 1];
      if (!last) return { error: `Дата ${tok} указана до ссылки на игру` };
      last.date = iso;
      continue;
    }
    return { error: `Непонятный аргумент: ${tok} (ожидалась ссылка или дата ДД.ММ.ГГГГ)` };
  }

  return { value: { team: teamRaw as Team, month, year, games } };
}
