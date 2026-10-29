import { listEvents, type CalendarEvent } from '../google/calendar.js';
import { env } from '../config/env.js';
import type { Team } from '../db/types.js';
import {
  getScheduledGameByCalendarEvent, listScheduledGamesInRange, reconcileScheduledGamePoll,
  setScheduledGameCalendarEventId, upsertScheduledGame,
  setScheduledGameCoachPresent, recomputeScheduleConflicts,
} from '../db/repos/scheduledGames.repo.js';
import type { ScheduledGameInput } from '../db/repos/scheduledGames.repo.js';
import { scheduledMatchupKey } from '../domain/schedule.js';

export interface CalendarScheduleImportResult {
  found: number;
  newGames: number;
  saved: number;
  errors: string[];
}

/** В расписание попадают только явно помеченные игры, а не тренировки и личные события. */
export function calendarGameInput(event: CalendarEvent): ScheduledGameInput | null {
  if (event.tags.TYPE !== 'GAME' && event.tags.TYPE !== 'FRIENDLY') return null;
  const title = event.summary.replace(/^Игра\s+/iu, '').trim();
  // Дефисы внутри названий (Транснефть-Технологии, Yandex-2) сохраняются.
  const teams = title.split(/\s+(?:[-–—]|vs\.?)\s+/iu);
  if (teams.length !== 2 || teams.some((name) => !name.trim())) {
    throw new Error('Для импорта укажи название «Игра Команда 1 - Команда 2»');
  }
  let date = event.start.slice(0, 10);
  let time: string | null = null;
  if (event.startDateTime) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: env.TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(event.start));
    const value = (key: string) => parts.find((p) => p.type === key)!.value;
    date = `${value('year')}-${value('month')}-${value('day')}`;
    time = `${value('hour')}:${value('minute')}`;
  }
  return {
    source: 'CALENDAR', source_url: 'https://calendar.google.com/',
    external_id: `${event.team}:${event.uid}`, team: event.team,
    team_a: teams[0]!.trim(), team_b: teams[1]!.trim(),
    game_date: date, game_time: time, location: event.location, details_url: null,
    calendar_event_id: event.uid,
  };
}

/** Читаем календарь в БД, не переписывая вручную созданные Google-события. */
export async function importCalendarSchedule(
  team: Team,
  from: Date,
  to: Date,
  reader: typeof listEvents = listEvents,
): Promise<CalendarScheduleImportResult> {
  const result: CalendarScheduleImportResult = { found: 0, newGames: 0, saved: 0, errors: [] };
  const events = await reader(team, from, to);
  for (const event of events) {
    try {
      const linked = await getScheduledGameByCalendarEvent(team, event.uid);
      // События, которыми управляет импорт лиги, обратно не импортируем.
      if (event.importedSource || (linked && linked.source !== 'CALENDAR')) continue;
      const input = calendarGameInput(event);
      if (!input) continue;
      result.found++;
      const nextDate = new Date(`${input.game_date}T00:00:00Z`);
      nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      const candidates = (await listScheduledGamesInRange(team, input.game_date, nextDate.toISOString().slice(0, 10)))
        .filter((g) => g.id !== linked?.id
          && scheduledMatchupKey(g.team_a, g.team_b) === scheduledMatchupKey(input.team_a, input.team_b)
          && (g.game_time ? String(g.game_time).slice(0, 5) : null) === input.game_time);
      if (!linked && candidates.length) {
        if (candidates.length !== 1 || candidates[0]!.calendar_event_id) {
          throw new Error('Матч уже есть в расписании: проверь возможный дубль календаря');
        }
        await setScheduledGameCalendarEventId(candidates[0]!.id, event.uid);
      } else {
        const row = await upsertScheduledGame(input);
        if (!linked) {
          if (event.tags.COACH) await setScheduledGameCoachPresent(row.id, event.tags.COACH === 'PAID');
          result.newGames++;
        }
      }
      await reconcileScheduledGamePoll(team, event.uid);
      result.saved++;
    } catch (err) {
      result.errors.push(`${event.summary}: ${(err as Error).message}`);
    }
  }
  await recomputeScheduleConflicts();
  return result;
}
