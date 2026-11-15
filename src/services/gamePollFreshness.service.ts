import {
  getScheduledGameByCalendarEvent,
  listUpcomingLeagueGames,
  upsertScheduledGame,
  type ScheduledGameInput,
} from '../db/repos/scheduledGames.repo.js';
import type { ScheduledGame, Team } from '../db/types.js';
import { getEvent, type CalendarEvent } from '../google/calendar.js';
import { fetchLchbMatchDetails, fetchSchedulePage } from '../schedule/parser.js';
import { syncScheduledGame } from './scheduleImport.service.js';

export interface GamePollFreshnessContext {
  leaguePages: Map<string, Promise<ScheduledGameInput[]>>;
}

export function createGamePollFreshnessContext(): GamePollFreshnessContext {
  return { leaguePages: new Map() };
}

function storedDate(game: ScheduledGame): string {
  return game.game_date instanceof Date
    ? game.game_date.toISOString().slice(0, 10)
    : String(game.game_date).slice(0, 10);
}

function leaguePage(context: GamePollFreshnessContext, game: ScheduledGame): Promise<ScheduledGameInput[]> {
  const key = `${game.source}:${game.team}:${game.source_url}`;
  const existing = context.leaguePages.get(key);
  if (existing) return existing;
  const request = fetchSchedulePage(game.source_url, game.team);
  context.leaguePages.set(key, request);
  return request;
}

/**
 * Перед опросом повторно читает источник конкретного матча и обновляет БД + Calendar.
 * Ошибка означает, что актуальность не подтверждена и опрос отправлять нельзя.
 */
export async function refreshScheduledGameForPoll(
  game: ScheduledGame,
  context: GamePollFreshnessContext = createGamePollFreshnessContext(),
): Promise<ScheduledGame> {
  if (game.source === 'CALENDAR') return game;
  let input: ScheduledGameInput;
  if (game.source === 'LCHB') {
    if (!game.details_url) throw new Error('у матча ЛЧБ нет ссылки для проверки');
    const details = await fetchLchbMatchDetails(game.details_url, storedDate(game));
    input = {
      source: 'LCHB',
      source_url: game.source_url,
      external_id: game.external_id,
      team: game.team,
      team_a: game.team_a,
      team_b: game.team_b,
      game_date: details.gameDate,
      game_time: details.gameTime,
      location: details.location,
      details_url: game.details_url,
      calendar_event_id: game.calendar_event_id ?? undefined,
    };
  } else {
    const current = (await leaguePage(context, game))
      .find((candidate) => candidate.external_id === game.external_id);
    if (!current) throw new Error('матч МЛБЛ больше не найден в актуальном расписании');
    input = { ...current, calendar_event_id: game.calendar_event_id ?? undefined };
  }
  const updated = await upsertScheduledGame(input);
  await syncScheduledGame(updated);
  if (!updated.game_time) throw new Error(`${game.source} не опубликовала время матча`);
  return updated;
}

/** Итог синхронизации лиг перед повторным чтением Google Calendar. */
export interface LeagueCalendarRefreshResult {
  knownLeagueEventIds: Set<string>;
  verifiedEventIds: Set<string>;
  errors: string[];
}

/**
 * Сначала обновляет события лиг в Google Calendar. После этого вызывающий код
 * обязан заново прочитать Calendar и формировать опрос только из него.
 */
export async function refreshLeagueCalendarsBeforePolls(
  context: GamePollFreshnessContext = createGamePollFreshnessContext(),
): Promise<LeagueCalendarRefreshResult> {
  const result: LeagueCalendarRefreshResult = {
    knownLeagueEventIds: new Set(), verifiedEventIds: new Set(), errors: [],
  };
  for (const game of await listUpcomingLeagueGames()) {
    if (game.calendar_event_id) result.knownLeagueEventIds.add(game.calendar_event_id);
    try {
      const updated = await refreshScheduledGameForPoll(game, context);
      if (updated.calendar_event_id) result.verifiedEventIds.add(updated.calendar_event_id);
    } catch (err) {
      result.errors.push(`${game.team_a} — ${game.team_b}: ${(err as Error).message}`);
    }
  }
  return result;
}

/**
 * Для точечной/ручной отправки: синхронизировать лигу, затем обязательно
 * перечитать событие из Google Calendar. Результат никогда не строится из БД.
 */
export async function readFreshCalendarGameForPoll(
  team: Team,
  eventId: string,
  context: GamePollFreshnessContext = createGamePollFreshnessContext(),
): Promise<CalendarEvent> {
  const game = await getScheduledGameByCalendarEvent(team, eventId);
  if (game && game.source !== 'CALENDAR') await refreshScheduledGameForPoll(game, context);
  const event = await getEvent(team, eventId);
  if (!event) throw new Error('событие больше не существует в Google Calendar');
  const leagueEvent = event.importedSource === 'LCHB' || event.importedSource === 'MLBL';
  if (leagueEvent && !game) throw new Error('событие лиги не связано с записью расписания');
  if (event.tags.TYPE !== 'GAME' && event.tags.TYPE !== 'FRIENDLY') {
    throw new Error('событие больше не помечено как игра в Google Calendar');
  }
  return event;
}
