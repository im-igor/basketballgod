import { calendarClient } from './auth.js';
import { parseTags, type EventTags } from './tags.js';
import { env } from '../config/env.js';
import type { Team } from '../db/types.js';
import { createHash } from 'node:crypto';

export interface CalendarEvent {
  uid: string;
  team: Team;
  summary: string;
  location: string | null;
  start: string; // ISO
  startDateTime: boolean; // true если со временем, false если на весь день
  tags: EventTags;
}

function mapEvent(team: Team, ev: {
  id?: string | null;
  summary?: string | null;
  location?: string | null;
  description?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
}): CalendarEvent | null {
  const start = ev.start?.dateTime ?? ev.start?.date;
  if (!start || !ev.id) return null;
  return {
    uid: ev.id,
    team,
    summary: ev.summary ?? '(без названия)',
    location: ev.location ?? null,
    start,
    startDateTime: Boolean(ev.start?.dateTime),
    tags: parseTags(ev.description),
  };
}

/** События одной команды в окне [timeMin, timeMax). */
export async function listEvents(
  team: Team,
  timeMin: Date,
  timeMax: Date,
): Promise<CalendarEvent[]> {
  const calendar = calendarClient();
  const res = await calendar.events.list({
    calendarId: env.calendars[team],
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  });
  const items = res.data.items ?? [];
  return items.map((ev) => mapEvent(team, ev)).filter((e): e is CalendarEvent => e !== null);
}

/** События обеих команд в окне. */
export async function listAllEvents(timeMin: Date, timeMax: Date): Promise<CalendarEvent[]> {
  const [red, black] = await Promise.all([
    listEvents('RED', timeMin, timeMax),
    listEvents('BLACK', timeMin, timeMax),
  ]);
  return [...red, ...black].sort((a, b) => a.start.localeCompare(b.start));
}

export interface ScheduledCalendarEvent {
  source: 'LCHB' | 'MLBL';
  externalId: string;
  team: Team;
  teamA: string;
  teamB: string;
  gameDate: string;
  gameTime: string | null;
  location: string | null;
  sourceUrl: string;
  detailsUrl: string | null;
  calendarEventId: string | null;
  coachPresent: boolean | null;
  coachConflict: boolean;
}

/** Стабильный допустимый Google event id: повторный импорт не создаёт дубликат. */
function importedEventId(event: ScheduledCalendarEvent): string {
  return `bbg${createHash('sha256')
    .update(`${event.source}:${event.externalId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function nextIsoDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function calendarBody(event: ScheduledCalendarEvent) {
  const involved = event.team === 'RED' ? 'ALL_RED' : 'ALL_BLACK';
  const unresolved = event.coachConflict && event.coachPresent === null;
  const coachExpected = event.coachPresent !== false && !unresolved;
  const prefix = unresolved ? '⚠️ КОНФЛИКТ ТРЕНЕРА · ' :
    event.coachConflict && event.coachPresent === true ? '✅ ТРЕНЕР ЗДЕСЬ · ' :
      event.coachPresent === false ? '🚫 БЕЗ ТРЕНЕРА · ' : '';
  const description = [
    'TYPE=GAME',
    'GYM=FREE',
    `COACH=${coachExpected ? 'PAID' : 'FREE'}`,
    `INVOLVED=${involved}`,
    `NOTES="Импортировано из ${event.source}"`,
    `COACH_CONFLICT=${event.coachConflict ? 'YES' : 'NO'}`,
    `COACH_STATUS=${unresolved ? 'REVIEW' : coachExpected ? 'EXPECTED' : 'ABSENT'}`,
    '',
    `Источник: ${event.detailsUrl ?? event.sourceUrl}`,
  ].join('\n');
  const common = {
    summary: `Игра ${prefix}${event.teamA} - ${event.teamB}`,
    description,
    location: event.location ?? undefined,
    // 11 — красный (не решено), 10 — зелёный (тренер назначен), 8 — серый (без тренера).
    colorId: unresolved ? '11' : event.coachConflict && event.coachPresent === true ? '10' :
      event.coachPresent === false ? '8' : undefined,
    extendedProperties: {
      private: {
        basketballgodSource: event.source,
        basketballgodExternalId: event.externalId,
        basketballgodTeam: event.team,
      },
    },
  };
  if (!event.gameTime) {
    return {
      ...common,
      start: { date: event.gameDate },
      end: { date: nextIsoDate(event.gameDate) },
    };
  }
  // Лиги публикуют московское время. Конец на сайтах не указан, поэтому используем
  // длительность их стандартного слота: 80 минут ЛЧБ, 90 минут МЛБЛ.
  const start = new Date(`${event.gameDate}T${event.gameTime}:00+03:00`);
  const durationMinutes = event.source === 'LCHB' ? 80 : 90;
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  return {
    ...common,
    start: { dateTime: start.toISOString(), timeZone: env.TZ },
    end: { dateTime: end.toISOString(), timeZone: env.TZ },
  };
}

/** Создать или обновить импортированный матч в календаре команды. */
export async function upsertScheduledCalendarEvent(event: ScheduledCalendarEvent): Promise<string> {
  const calendar = calendarClient();
  const calendarId = env.calendars[event.team];
  const eventId = event.calendarEventId ?? importedEventId(event);
  const requestBody = calendarBody(event);
  try {
    await calendar.events.update({ calendarId, eventId, requestBody });
  } catch (err) {
    const status = (err as { code?: number; response?: { status?: number } }).code ??
      (err as { response?: { status?: number } }).response?.status;
    if (status !== 404) throw err;
    try {
      await calendar.events.insert({ calendarId, requestBody: { ...requestBody, id: eventId } });
    } catch (insertErr) {
      // Параллельный/повторный импорт мог успеть создать событие между update и insert.
      const insertStatus = (insertErr as { code?: number; response?: { status?: number } }).code ??
        (insertErr as { response?: { status?: number } }).response?.status;
      if (insertStatus !== 409) throw insertErr;
      await calendar.events.update({ calendarId, eventId, requestBody });
    }
  }
  return eventId;
}
