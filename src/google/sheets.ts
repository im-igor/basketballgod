import { env } from '../config/env.js';
import { sheetsClient } from './auth.js';
import { isoToRu } from '../domain/dates.js';
import type { Team } from '../db/types.js';

/**
 * Односторонняя выгрузка БД → Google-таблица.
 *
 * Источник правды — Postgres; таблица нужна только как витрина «показать
 * человеку без доступа к админке». Обратного чтения нет и быть не должно:
 * иначе устаревший лист молча перезапишет базу. Людям таблицу шарим с правами
 * «Читатель», сервис-аккаунту нужен «Редактор» (он в неё пишет).
 *
 * Вкладки: `Players` (A:I), `tariffs` (A:B), `cron` (A:B), `Tags` (A:C).
 * Форматы: employee → TRUE/FALSE, active → YES/NO, даты → RU dd.mm.yyyy.
 */

const TAB = 'Players';
const PLAYERS_RANGE = `${TAB}!A:I`;

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

const PLAYERS_HEADER = [
  '№',
  'ФИО',
  'tg_login',
  'employee',
  'team',
  'active',
  'active_from',
  'active_to',
  'notes',
];

function sheetId(): string {
  if (!env.GOOGLE_SHEET_ID) throw new Error('Не задан GOOGLE_SHEET_ID в .env');
  return env.GOOGLE_SHEET_ID;
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

/** Перезаписать вкладку `Players` целиком (заголовок + строки). */
export async function writePlayersSheet(players: SheetPlayer[]): Promise<void> {
  const sheets = sheetsClient();
  const id = sheetId();
  // Сначала чистим прежние данные (на случай удалённых строк), затем пишем заново.
  await sheets.spreadsheets.values.clear({ spreadsheetId: id, range: PLAYERS_RANGE });
  const values = [PLAYERS_HEADER, ...players.map((p, i) => toRow(p, i + 1))];
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${TAB}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

// ── Транспонированные вкладки-конфиги (колонка A — ключ, B — значение) ──────

/**
 * Перезаписать вкладку «ключ→значение» (A:B). Пишем пары в заданном порядке,
 * предварительно очистив прежнее содержимое (на случай удалённых строк).
 */
async function writeKeyValueTab(tab: string, pairs: [string, string][]): Promise<void> {
  const sheets = sheetsClient();
  const id = sheetId();
  await sheets.spreadsheets.values.clear({ spreadsheetId: id, range: `${tab}!A:B` });
  if (pairs.length === 0) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: pairs.map(([k, v]) => [k, v]) },
  });
}

/** Записать тарифы в вкладку `tariffs` (A=ключ, B=значение). */
export async function writeTariffsToSheet(t: {
  gym_paid_price: number;
  locker_rent_price: number;
  coach_per_session: number;
  coach_per_game: number;
  referee_default: number;
}): Promise<void> {
  await writeKeyValueTab('tariffs', [
    ['gym_paid_price', String(t.gym_paid_price)],
    ['locker_rent_price', String(t.locker_rent_price)],
    ['coach_per_session', String(t.coach_per_session)],
    ['coach_per_game', String(t.coach_per_game)],
    ['referee_default', String(t.referee_default)],
  ]);
}

/** Записать расписание в вкладку `cron` (A=ключ, B=значение). null → пустая ячейка. */
export async function writeCronToSheet(c: {
  timezone: string | null;
  poll_training_weekday: number | null;
  poll_training_time: string | null;
  poll_training_horizon_days: number | null;
  poll_game_weekday: number | null;
  poll_game_time: string | null;
  poll_game_horizon_days: number | null;
  fixation_day: number | null;
  fixation_time: string | null;
  budget_day: number | null;
  budget_time: string | null;
  schedule_import_enabled: boolean;
  schedule_import_interval_minutes: number;
  schedule_import_send_polls: boolean;
}): Promise<void> {
  const s = (v: string | number | null): string => (v === null ? '' : String(v));
  await writeKeyValueTab('cron', [
    ['timezone', s(c.timezone)],
    ['poll_training_weekday', s(c.poll_training_weekday)],
    ['poll_training_time', s(c.poll_training_time)],
    ['poll_training_horizon_days', s(c.poll_training_horizon_days)],
    ['poll_game_weekday', s(c.poll_game_weekday)],
    ['poll_game_time', s(c.poll_game_time)],
    ['poll_game_horizon_days', s(c.poll_game_horizon_days)],
    ['fixation_day', s(c.fixation_day)],
    ['fixation_time', s(c.fixation_time)],
    ['budget_day', s(c.budget_day)],
    ['budget_time', s(c.budget_time)],
    ['schedule_import_enabled', String(c.schedule_import_enabled)],
    ['schedule_import_interval_minutes', s(c.schedule_import_interval_minutes)],
    ['schedule_import_send_polls', String(c.schedule_import_send_polls)],
  ]);
}

// ── Справочник тегов (вкладка `Tags`, A:C — key/value/description) ──────────

const TAGS_TAB = 'Tags';

export interface SheetTag {
  tag_key: string;
  tag_value: string;
  description: string | null;
}

/** Перезаписать вкладку `Tags` (с заголовком). */
export async function writeTagsToSheet(tags: SheetTag[]): Promise<void> {
  const sheets = sheetsClient();
  const id = sheetId();
  await sheets.spreadsheets.values.clear({ spreadsheetId: id, range: `${TAGS_TAB}!A:C` });
  const values = [
    ['key', 'value', 'description'],
    ...tags.map((t) => [t.tag_key, t.tag_value, t.description ?? '']),
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${TAGS_TAB}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}
