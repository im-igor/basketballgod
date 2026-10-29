import { createHash } from 'node:crypto';
import { budgetTransaction, query } from '../db/pool.js';
import { listScheduledGamesInRange, getScheduledGameByExternalId, upsertScheduledGame,
  adoptCalendarScheduledGame, recomputeScheduleConflicts } from '../db/repos/scheduledGames.repo.js';
import { listScheduleSources } from '../db/repos/scheduleSources.repo.js';
import { fetchSchedulePage } from '../schedule/parser.js';
import { importCalendarSchedule } from './calendarScheduleImport.service.js';
import { scheduledMatchupKey } from '../domain/schedule.js';
import { listPlayers } from '../db/repos/players.repo.js';
import { getTariffs } from '../db/repos/tariffs.repo.js';
import { gameStatsRef } from '../gamefee/parser.js';
import { validateGame, type GamePlan } from './gameFee.service.js';
import type { CalendarEvent } from '../google/calendar.js';
import type { Game, ScheduledGame } from '../db/types.js';

export const STABILITY_MS = 30 * 60_000;
const dateOf = (value: string | Date) => value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
export function sourcePeriod(month: number, year: number) {
  const from = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
  return { from, to };
}
export function planFingerprint(plan: GamePlan): string {
  return createHash('sha256').update(JSON.stringify({
    ...plan, participants: [...plan.participants].sort((a, b) => a.matched_player_id! - b.matched_player_id!),
  })).digest('hex');
}
function sameIdentity(url: string | null, game: ScheduledGame): boolean {
  if (!url || game.source === 'CALENDAR') return false;
  try {
    const ref = gameStatsRef(url);
    return ref.source === game.source && ref.externalId === game.external_id;
  } catch { return false; }
}
export interface StatsCheck { game: ScheduledGame; plan?: GamePlan; ready: boolean; error: string | null }

interface SourceFailure { team: 'RED' | 'BLACK'; message: string }

/** Обновляет локальное расписание и наблюдения, без внешних записей и начислений. */
async function inspectAutomaticGameStats(
  month: number, year: number, now = new Date(), reader = validateGame,
): Promise<{ checks: StatsCheck[]; sourceErrors: SourceFailure[] }> {
  const sourceErrors: SourceFailure[] = [];
  const { from, to } = sourcePeriod(month, year);
  // История запрашивается заново: матч мог впервые появиться уже завершённым.
  // Здесь нет записей в Google Calendar, Telegram и начислений.
  const sources = await listScheduleSources(true);
  for (const source of sources) {
    try {
    const candidates = await fetchSchedulePage(source.url, source.team, { from, to });
    for (const candidate of candidates) {
      const existing = await getScheduledGameByExternalId(source.source, candidate.external_id);
      if (!existing) {
        const manual = (await listScheduledGamesInRange(source.team, from, to)).filter((g) =>
          g.source === 'CALENDAR' && dateOf(g.game_date) === candidate.game_date &&
          scheduledMatchupKey(g.team_a, g.team_b) === scheduledMatchupKey(candidate.team_a, candidate.team_b));
        if (manual.length > 1) throw new Error('Несколько календарных записей матча; сначала устрани дубли');
        if (manual.length === 1) await adoptCalendarScheduledGame(manual[0]!.id, source.source, candidate.external_id);
      }
      await upsertScheduledGame(candidate);
    }
    } catch (err) { sourceErrors.push({ team: source.team, message: `${source.source}: ${(err as Error).message}` }); }
  }
  if (sources.length) await recomputeScheduleConflicts();
  const rows = (await Promise.all(['RED', 'BLACK'].map((team) =>
    listScheduledGamesInRange(team as 'RED' | 'BLACK', from, to)))).flat();
  const roster = await listPlayers();
  const tariffs = await getTariffs();
  const results: StatsCheck[] = [];
  for (const game of rows) {
    let plan: GamePlan | undefined;
    let error: string | null = null;
    try {
      if (!game.present_in_source) throw new Error('Матч исчез из источника; проверь отмену или перенос');
      if (dateOf(game.game_date) >= now.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' })) {
        throw new Error('Матч ещё не завершился или сыгран сегодня');
      }
      if (game.source === 'CALENDAR' || !game.details_url) throw new Error('Нет ссылки лиги на протокол; внеси игру вручную');
      const ref = gameStatsRef(game.details_url);
      if (ref.source !== game.source || ref.externalId !== game.external_id) throw new Error('ID протокола не совпадает с расписанием');
      if (game.coach_conflict && game.coach_present === null) throw new Error('Не решён конфликт тренера');
      const result = await reader(game.details_url, game.team, dateOf(game.game_date), roster, tariffs, true);
      if (!result.ok) throw new Error(result.errors.join('; '));
      const verified = result.plan;
      plan = verified;
      const normalize = (s: string) => s.toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
      if (plan.date !== dateOf(game.game_date) ||
          ![game.team_a, game.team_b].some((name) => normalize(name) === normalize(verified.teamName)) ||
          ![game.team_a, game.team_b].some((name) => normalize(name) === normalize(verified.opponent ?? ''))) {
        throw new Error('Дата или команды протокола отличаются от расписания');
      }
      if (!Number.isSafeInteger(plan.fee) || plan.fee < 0) throw new Error('Некорректная сумма взноса');
    } catch (err) { error = (err as Error).message; plan = undefined; }
    const fingerprint = plan ? planFingerprint(plan) : null;
    const { rows: saved } = await query<{ stable_since: string | Date | null }>(
      `insert into game_stats_checks (scheduled_game_id, fingerprint, stable_since, checked_at, plan, error)
       values ($1,$2,$3,$3,$4,$5)
       on conflict (scheduled_game_id) do update set
         stable_since = case when game_stats_checks.fingerprint = excluded.fingerprint
           then game_stats_checks.stable_since else excluded.stable_since end,
         fingerprint = excluded.fingerprint, checked_at = excluded.checked_at,
         plan = excluded.plan, error = excluded.error returning stable_since`,
      [game.id, fingerprint, now.toISOString(), plan ? JSON.stringify(plan) : null, error],
    );
    const stable = saved[0]?.stable_since;
    const ready = !!plan && !!stable && now.getTime() - new Date(stable).getTime() >= STABILITY_MS;
    results.push({ game, plan, ready, error: error ?? (ready ? null : 'Ожидается повторная одинаковая проверка через 30 минут') });
  }
  return { checks: results, sourceErrors };
}

export async function checkAutomaticGameStats(
  month: number, year: number, now = new Date(), reader = validateGame,
): Promise<StatsCheck[]> {
  const result = await inspectAutomaticGameStats(month, year, now, reader);
  if (result.sourceErrors.length) throw new Error(result.sourceErrors.map((e) => e.message).join('; '));
  return result.checks;
}

/** Сверяет весь прошлый месяц. При одном пробеле ничего не записывает. */
export async function importAutomaticGameStats(month: number, year: number, events: CalendarEvent[], verifyOnly = false): Promise<void> {
  const { from, to } = sourcePeriod(month, year);
  for (const team of ['RED', 'BLACK'] as const) {
    const calendar = await importCalendarSchedule(team, new Date(from), new Date(to),
      async () => events.filter((e) => e.team === team));
    if (calendar.errors.length) throw new Error(`Нет проверенного протокола: ${calendar.errors.join('; ')}`);
  }
  const { checks, sourceErrors } = await inspectAutomaticGameStats(month, year);
  await budgetTransaction(async (client) => {
    const published = await client.query('select id from budgets where month=$1 and year=$2 and message_id is not null', [month, year]);
    if (!verifyOnly && published.rows.length) throw new Error('Опубликованный бюджет нельзя менять');
    const existing = (await client.query<Game>('select * from games')).rows;
    const errors: string[] = [];
    const additions: GamePlan[] = [];
    for (const failure of sourceErrors) {
      const calendarGames = events.filter((e) => e.team === failure.team &&
        (e.tags.TYPE === 'GAME' || e.tags.TYPE === 'FRIENDLY'));
      const known = checks.filter((c) => c.game.team === failure.team);
      const manualCoverage = calendarGames.length > 0 && calendarGames.every((e) =>
        existing.filter((g) => g.event_uid === e.uid && g.month === month && g.year === year &&
          !(g as Game & { automatic_stats_fingerprint?: string }).automatic_stats_fingerprint).length === 1) &&
        known.every((c) => existing.filter((g) => (sameIdentity(g.stat_url,c.game) ||
          (c.game.calendar_event_id && g.event_uid === c.game.calendar_event_id)) &&
          g.month === month && g.year === year &&
          !(g as Game & { automatic_stats_fingerprint?: string }).automatic_stats_fingerprint).length === 1);
      if (!manualCoverage) errors.push(`${failure.message}. Для ручного расчёта свяжи каждую известную игру с проверенным составом`);
    }
    for (const g of existing.filter((g) => g.month === month && g.year === year &&
      (g as Game & { automatic_stats_fingerprint?: string }).automatic_stats_fingerprint)) {
      if (!checks.some((c) => sameIdentity(g.stat_url, c.game))) {
        errors.push(`Игра #${g.id}: исчезла из расписания прошлого месяца; проверь перенос или отмену`);
      }
    }
    const matchups = new Set<string>();
    for (const c of checks) {
      const key = `${c.game.team}:${dateOf(c.game.game_date)}:` +
        [c.game.team_a.trim().toLowerCase(), c.game.team_b.trim().toLowerCase()].sort().join(':');
      if (matchups.has(key)) errors.push(`${c.game.team} ${dateOf(c.game.game_date)}: дубли матча в расписании`);
      matchups.add(key);
    }
    for (const check of checks) {
      const matches = existing.filter((g) => sameIdentity(g.stat_url, check.game) ||
        (check.game.calendar_event_id && g.event_uid === check.game.calendar_event_id));
      if (matches.length > 1) { errors.push(`Матч #${check.game.external_id}: несколько начислений`); continue; }
      if (matches.length === 1) {
        const g = matches[0]!;
        if (g.month !== month || g.year !== year) errors.push(`Матч #${check.game.external_id} уже отнесён к другому бюджету`);
        const fingerprint = (g as Game & { automatic_stats_fingerprint?: string }).automatic_stats_fingerprint;
        if (fingerprint && (!check.ready || !check.plan || fingerprint !== planFingerprint(check.plan))) {
          errors.push(`Матч #${check.game.external_id}: протокол или тариф изменился; проверь и исправь игру вручную`);
        }
        // Ручной ввод остаётся явным решением администратора; автоматизация его не заменяет.
        continue;
      }
      if (!check.ready || !check.plan) errors.push(`${check.game.team} ${dateOf(check.game.game_date)} #${check.game.external_id}: ${check.error}`);
      else additions.push(check.plan);
    }
    for (const event of events.filter((e) => e.tags.TYPE === 'GAME' || e.tags.TYPE === 'FRIENDLY')) {
      if (!checks.some((c) => c.game.calendar_event_id === event.uid) &&
          !existing.some((g) => g.event_uid === event.uid && g.month === month && g.year === year)) {
        errors.push(`${event.summary}: нет проверенного протокола или связанной ручной игры`);
      }
    }
    if (errors.length) throw new Error(`Статистика игр не готова. ${errors.join('; ')}`);
    if (verifyOnly && additions.length) throw new Error('Появились новые игры. Пересобери и проверь бюджет');
    for (const plan of additions) {
      await client.query(
        `insert into games (event_uid,team,opponent,played_on,stat_url,fee_per_player,participants,coach_present,judge,month,year,automatic_stats_fingerprint)
         values ($1,$2,$3,$4,$5,$6,$7,$8,false,$9,$10,$11)`,
        [plan.calendarEventId, plan.team, plan.opponent, plan.date, plan.url, plan.fee,
          JSON.stringify(plan.participants), plan.coachPresent, month, year, planFingerprint(plan)],
      );
    }
  });
}

/** Сохранённые результаты для админки: открытие страницы не обращается к сайтам. */
export async function listAutomaticStatsStatus(month: number, year: number) {
  const { from, to } = sourcePeriod(month, year);
  return (await query<{ team: string; external_id: string; game_date: string | Date;
    error: string | null; checked_at: string | Date | null; stable_since: string | Date | null; plan: GamePlan | null }>(
    `select s.team,s.external_id,s.game_date,c.error,c.checked_at,c.stable_since,c.plan
     from scheduled_games s left join game_stats_checks c on c.scheduled_game_id=s.id
     where s.game_date >= $1 and s.game_date < $2 order by s.game_date,s.id`, [from,to])).rows;
}
