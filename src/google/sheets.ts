import { env } from '../config/env.js';
import { sheetsClient } from './auth.js';
import { normalizeLogin } from '../util/args.js';
import type { Team } from '../db/types.js';

/**
 * Чтение и запись листа `Players` в Google-таблице — источника правды по игрокам.
 *
 * Колонки (диапазон A:I, строка 1 — заголовок, данные с A2):
 *   № | name | tg_login | employee | team | active | active_from | active_to | notes
 *
 * Форматы (round-trip с импортёром scripts/import-players):
 *   employee → TRUE/FALSE, active → YES/NO, даты → RU dd.mm.yyyy.
 * Внутри храним даты как ISO `YYYY-MM-DD` (или null).
 */

const TAB = 'Players';
const READ_RANGE = `${TAB}!A2:I`;
const WRITE_START = `${TAB}!A2`;
const CLEAR_RANGE = `${TAB}!A2:I`;

export interface SheetPlayer {
  name: string;
  tg_login: string;
  is_employee: boolean;
  team: Team;
  active: boolean;
  active_from: string | null; // ISO YYYY-MM-DD
  active_to: string | null; // ISO YYYY-MM-DD
  notes: string | null;
}

/** dd.mm.yyyy → ISO YYYY-MM-DD (или null). */
export function ruDateToISO(s: string | undefined | null): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}`;
}

/** ISO YYYY-MM-DD (или Date) → dd.mm.yyyy (или ''). */
export function isoToRu(v: string | Date | null | undefined): string {
  if (!v) return '';
  if (v instanceof Date) {
    const dd = String(v.getDate()).padStart(2, '0');
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}.${v.getFullYear()}`;
  }
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

function sheetId(): string {
  if (!env.GOOGLE_SHEET_ID) throw new Error('Не задан GOOGLE_SHEET_ID в .env');
  return env.GOOGLE_SHEET_ID;
}

function parseRow(row: string[]): SheetPlayer | null {
  const [, name, tgLogin, employee, team, active, activeFrom, activeTo, notes] = row;
  if (!name || !tgLogin || (team !== 'RED' && team !== 'BLACK')) return null;
  return {
    name: name.trim(),
    tg_login: normalizeLogin(tgLogin),
    is_employee: (employee ?? '').trim().toUpperCase() === 'TRUE',
    team: team as Team,
    active: (active ?? '').trim().toUpperCase() === 'YES',
    active_from: ruDateToISO(activeFrom),
    active_to: ruDateToISO(activeTo),
    notes: notes?.trim() || null,
  };
}

function toRow(p: SheetPlayer, num: number): string[] {
  return [
    String(num),
    p.name,
    p.tg_login,
    p.is_employee ? 'TRUE' : 'FALSE',
    p.team,
    p.active ? 'YES' : 'NO',
    isoToRu(p.active_from),
    isoToRu(p.active_to),
    p.notes ?? '',
  ];
}

/** Прочитать всех игроков из листа (валидные строки). */
export async function readPlayersSheet(): Promise<SheetPlayer[]> {
  const sheets = sheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId(),
    range: READ_RANGE,
  });
  const rows = (res.data.values ?? []) as string[][];
  return rows.map(parseRow).filter((p): p is SheetPlayer => p !== null);
}

/** Найти игрока в листе по tg_login (без учёта регистра). */
export async function findPlayerInSheet(login: string): Promise<SheetPlayer | null> {
  const target = normalizeLogin(login).toLowerCase();
  const players = await readPlayersSheet();
  return players.find((p) => p.tg_login.toLowerCase() === target) ?? null;
}

/** Перезаписать весь список игроков (строка заголовка не трогается). */
export async function writePlayersSheet(players: SheetPlayer[]): Promise<void> {
  const sheets = sheetsClient();
  const id = sheetId();
  // Сначала чистим прежние данные (на случай удалённых строк), затем пишем заново.
  await sheets.spreadsheets.values.clear({ spreadsheetId: id, range: CLEAR_RANGE });
  if (players.length === 0) return;
  const values = players.map((p, i) => toRow(p, i + 1));
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: WRITE_START,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

/**
 * Добавить или обновить игрока в листе. Ключ поиска — `origLogin`
 * (отдельно от полей, чтобы можно было переименовать сам tg_login).
 * Если строки нет — добавляется новая.
 */
export async function upsertPlayerInSheet(
  origLogin: string | null,
  fields: Partial<SheetPlayer> & { tg_login: string; name?: string; team?: Team },
): Promise<SheetPlayer> {
  const players = await readPlayersSheet();
  const key = normalizeLogin(origLogin ?? fields.tg_login).toLowerCase();
  const idx = players.findIndex((p) => p.tg_login.toLowerCase() === key);

  const next: SheetPlayer =
    idx >= 0
      ? { ...players[idx]!, ...fields, tg_login: normalizeLogin(fields.tg_login) }
      : {
          name: fields.name ?? '',
          tg_login: normalizeLogin(fields.tg_login),
          is_employee: fields.is_employee ?? false,
          team: fields.team ?? 'RED',
          active: fields.active ?? true,
          active_from: fields.active_from ?? null,
          active_to: fields.active_to ?? null,
          notes: fields.notes ?? null,
        };

  if (idx >= 0) players[idx] = next;
  else players.push(next);

  await writePlayersSheet(players);
  return next;
}

/** Удалить игрока из листа по tg_login. Возвращает true, если строка была найдена. */
export async function deletePlayerFromSheet(login: string): Promise<boolean> {
  const target = normalizeLogin(login).toLowerCase();
  const players = await readPlayersSheet();
  const filtered = players.filter((p) => p.tg_login.toLowerCase() !== target);
  if (filtered.length === players.length) return false;
  await writePlayersSheet(filtered);
  return true;
}

// ── Транспонированные вкладки-конфиги (колонка A — ключ, B — значение) ──────

/** Прочитать вкладку «ключ→значение» (диапазон A:B) в объект (ключи в нижнем регистре). */
async function readKeyValueTab(tab: string): Promise<Record<string, string>> {
  const sheets = sheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId(),
    range: `${tab}!A:B`,
  });
  const rows = (res.data.values ?? []) as string[][];
  const map: Record<string, string> = {};
  for (const [key, value] of rows) {
    if (!key) continue;
    map[key.trim().toLowerCase()] = (value ?? '').trim();
  }
  return map;
}

export interface SheetTariffs {
  gym_paid_price?: number;
  locker_rent_price?: number;
  coach_per_session?: number;
  coach_per_game?: number;
  referee_default?: number;
}

/** Тарифы из вкладки `tariffs` (A=ключ, B=значение). Битые/пустые значения — undefined. */
export async function readTariffsFromSheet(): Promise<SheetTariffs> {
  const map = await readKeyValueTab('tariffs');
  const num = (key: string): number | undefined => {
    const raw = map[key];
    if (!raw) return undefined;
    const n = Number(raw.replace(/\s+/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    gym_paid_price: num('gym_paid_price'),
    locker_rent_price: num('locker_rent_price'),
    coach_per_session: num('coach_per_session'),
    coach_per_game: num('coach_per_game'),
    referee_default: num('referee_default'),
  };
}

export interface SheetCronConfig {
  timezone?: string;
  poll_weekday?: number;
  poll_time?: string;
  fixation_day?: number;
  fixation_time?: string;
  budget_day?: number;
  budget_time?: string;
}

/** Расписание из вкладки `cron` (A=ключ, B=значение). Отсутствующее — undefined. */
export async function readCronConfigFromSheet(): Promise<SheetCronConfig> {
  const map = await readKeyValueTab('cron');
  const int = (key: string): number | undefined => {
    const n = Number(map[key]);
    return Number.isInteger(n) ? n : undefined;
  };
  return {
    timezone: map['timezone'] || undefined,
    poll_weekday: int('poll_weekday'),
    poll_time: map['poll_time'] || undefined,
    fixation_day: int('fixation_day'),
    fixation_time: map['fixation_time'] || undefined,
    budget_day: int('budget_day'),
    budget_time: map['budget_time'] || undefined,
  };
}
