import { calendarClient } from './auth.js';
import { parseTags, type EventTags } from './tags.js';
import { env } from '../config/env.js';
import type { Team } from '../db/types.js';

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
